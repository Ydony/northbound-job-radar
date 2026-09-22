import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import {
  cleanIndeedSettingsInput,
  defaultIndeedSettings,
  indeedActiveRoles,
  indeedQueryIdentity,
  indeedSearchLocation,
  indeedSearchRadiusMiles,
  indeedSettingsFromRow,
  kmToProviderMiles,
  loadIndeedSettings,
  INDEED_DEFAULT_RADIUS_KM,
  INDEED_QUERY_VERSION,
  INDEED_RADIUS_KM_MAX,
  INDEED_RADIUS_KM_MIN,
} from '../lib/indeed/settings';
import { collectIndeed } from '../lib/indeed/collection';
import { MAX_ROLE_KEYWORDS } from '../lib/criteria';

const config = {
  access: { enabled: true, localExecution: true, administrator: true, appIdentityExperimentApproved: true },
  credentials: { apiKey: 'a'.repeat(64), userAgent: 'Synthetic fixture', appInfo: 'synthetic=1' },
};

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("fixture")}}',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const base = runtimeMigrations
    .find((m) => m.version === 7)!
    .statements[0].replace('CREATE TABLE jobs_rebuilt', 'CREATE TABLE jobs');
  await db.prepare(base).run();
  // v25 alters search_run_sources, which v1 creates; the cherry-picked chain
  // below skips v1, so create that table in its v1 shape first. Without it the
  // ALTER throws, dispose never runs, and Miniflare keeps the process alive.
  await db.prepare(`CREATE TABLE IF NOT EXISTS search_run_sources (
    run_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_name TEXT NOT NULL,
    country TEXT NOT NULL,
    status TEXT NOT NULL,
    roles_searched TEXT NOT NULL DEFAULT '[]',
    found_count INTEGER NOT NULL DEFAULT 0,
    known_count INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    imported_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, source_key)
  )`).run();
  for (const version of [13, 14, 17, 19, 21, 23, 25, 26]) {
    await db.batch(
      runtimeMigrations.find((m) => m.version === version)!.statements.map((sql) => db.prepare(sql)),
    );
  }
  await db.prepare(`CREATE TABLE language_feedback (job_id TEXT PRIMARY KEY, user_id TEXT, verdict TEXT,
    corrected_status TEXT, reason TEXT, updated_at TEXT)`).run();
  await db.prepare(`CREATE TABLE dismissed_jobs (id TEXT, user_id TEXT, source_key TEXT, source_job_id TEXT,
    canonical_url TEXT, identity_fingerprint TEXT)`).run();
  return { db, dispose: () => mf.dispose() };
}

test('migration 26 creates an account-scoped settings table with present defaults', () => {
  const migration = runtimeMigrations.find((m) => m.version === 26);
  assert.ok(migration, 'migration 26 must exist');
  assert.equal(migration.name, 'indeed_place_distance_settings');
  const sql = migration.statements.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS indeed_settings/);
  assert.match(sql, /user_id TEXT PRIMARY KEY NOT NULL/);
  assert.match(sql, /nl_location TEXT NOT NULL DEFAULT 'Amsterdam, Netherlands'/);
  assert.match(sql, /ch_location TEXT NOT NULL DEFAULT 'Switzerland'/);
  assert.match(sql, /nl_radius_km INTEGER NOT NULL DEFAULT 16/);
  assert.match(sql, /ch_radius_km INTEGER NOT NULL DEFAULT 16/);
});

test('defaults preserve the previous hardcoded collection behaviour', () => {
  const defaults = defaultIndeedSettings();
  assert.equal(defaults.nlLocation, 'Amsterdam, Netherlands');
  assert.equal(defaults.chLocation, 'Switzerland');
  assert.equal(defaults.nlRadiusKm, INDEED_DEFAULT_RADIUS_KM);
  assert.equal(defaults.chRadiusKm, INDEED_DEFAULT_RADIUS_KM);
  // 16 km converts to exactly the old hardcoded 10 provider miles.
  assert.equal(kmToProviderMiles(16), 10);
  assert.equal(indeedSearchLocation('NL', defaults), 'Amsterdam, Netherlands');
  assert.equal(indeedSearchLocation('CH', defaults), 'Switzerland');
  assert.equal(indeedSearchRadiusMiles('NL', defaults), 10);
  assert.equal(indeedSearchRadiusMiles('CH', defaults), 10);
});

test('kilometres convert explicitly to provider miles within the observed window', () => {
  assert.equal(kmToProviderMiles(0), 0);
  assert.equal(kmToProviderMiles(16), 10);
  assert.equal(kmToProviderMiles(800), 497);
  // The whole user range stays inside the transport's 0-500 mile evidence.
  assert.ok(kmToProviderMiles(INDEED_RADIUS_KM_MIN) >= 0);
  assert.ok(kmToProviderMiles(INDEED_RADIUS_KM_MAX) <= 500);
});

test('a missing row reads as defaults; corrupt values repair on read, not on write', () => {
  assert.deepEqual(indeedSettingsFromRow(null), { ...defaultIndeedSettings() });
  assert.equal(indeedSettingsFromRow({ nl_location: '', nl_radius_km: NaN }).nlLocation, 'Amsterdam, Netherlands');
  assert.equal(indeedSettingsFromRow({ nl_radius_km: 9999 }).nlRadiusKm, INDEED_DEFAULT_RADIUS_KM);
  assert.equal(indeedSettingsFromRow({ ch_location: 'x'.repeat(400) }).chLocation, 'Switzerland');
  assert.equal(indeedSettingsFromRow({ ch_radius_km: Number.POSITIVE_INFINITY }).chRadiusKm, INDEED_DEFAULT_RADIUS_KM);
});

test('server-side input validation refuses finite/range/country violations', () => {
  const good = cleanIndeedSettingsInput({
    nlLocation: '  Amsterdam  ',
    nlRadiusKm: 25,
    chLocation: 'Zurich',
    chRadiusKm: 0,
  });
  assert.equal(good.nlLocation, 'Amsterdam');
  assert.equal(good.nlRadiusKm, 25);
  for (const body of [
    { nlLocation: '', nlRadiusKm: 10, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: '   ', nlRadiusKm: 10, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 'x'.repeat(301), nlRadiusKm: 10, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 42, nlRadiusKm: 10, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 'Amsterdam', nlRadiusKm: NaN, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 'Amsterdam', nlRadiusKm: Number.POSITIVE_INFINITY, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 'Amsterdam', nlRadiusKm: 10.5, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 'Amsterdam', nlRadiusKm: -1, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 'Amsterdam', nlRadiusKm: 801, chLocation: 'Zurich', chRadiusKm: 10 },
    { nlLocation: 'Amsterdam', nlRadiusKm: 10, chLocation: '', chRadiusKm: 10 },
    { nlLocation: 'Amsterdam', nlRadiusKm: 10, chLocation: 'Zurich', chRadiusKm: '25' },
  ]) {
    assert.throws(() => cleanIndeedSettingsInput(body as Record<string, unknown>), /must be|must not be/);
  }
});

test('first-two-role semantics persist; the shared five inputs are unchanged', () => {
  assert.equal(MAX_ROLE_KEYWORDS, 5);
  assert.deepEqual(indeedActiveRoles(['data analyst', 'master data', 'supply chain']), ['data analyst', 'master data']);
  assert.deepEqual(indeedActiveRoles(['  Data Analyst ', 'data analyst', '', 'Master Data']), ['Data Analyst', 'Master Data']);
  assert.deepEqual(indeedActiveRoles([]), []);
  assert.deepEqual(indeedActiveRoles(['a', 'b', 'c', 'd', 'e']), ['a', 'b']);
});

test('query identity changes with settings and is stable otherwise', () => {
  const base = { userId: 'alice', country: 'NL' as const, role: 'Data Analyst', location: 'Amsterdam, Netherlands', radiusMiles: 10 };
  const same = indeedQueryIdentity(base);
  assert.equal(indeedQueryIdentity({ ...base }), same);
  assert.notEqual(indeedQueryIdentity({ ...base, location: 'Rotterdam, Netherlands' }), same);
  assert.notEqual(indeedQueryIdentity({ ...base, radiusMiles: 11 }), same);
  assert.notEqual(indeedQueryIdentity({ ...base, role: 'Master Data' }), same);
  assert.notEqual(indeedQueryIdentity({ ...base, country: 'CH' }), same);
  assert.notEqual(indeedQueryIdentity({ ...base, userId: 'bob' }), same);
  // Cosmetic case/whitespace does not fork coverage.
  assert.equal(indeedQueryIdentity({ ...base, role: '  DATA analyst ' }), same);
  assert.ok(same.includes(`v${INDEED_QUERY_VERSION}`));
});

test('fresh and existing databases persist per-account settings without touching other state', async () => {
  const { db, dispose } = await fixture();
  try {
    // Fresh: no row means defaults, and loading never creates one.
    assert.deepEqual(await loadIndeedSettings(db, 'alice'), defaultIndeedSettings());
    const missing = await db.prepare('SELECT COUNT(*) AS total FROM indeed_settings').first<{ total: number }>();
    assert.equal(missing?.total, 0);

    // Save alice, then bob independently.
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO indeed_settings (user_id, nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind('alice', 'Rotterdam, Netherlands', 25, 'Zurich, Switzerland', 50, now).run();
    await db.prepare(`INSERT INTO indeed_settings (user_id, nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind('bob', 'Utrecht, Netherlands', 10, 'Geneva, Switzerland', 10, now).run();

    const alice = await loadIndeedSettings(db, 'alice');
    const bob = await loadIndeedSettings(db, 'bob');
    assert.equal(alice.nlLocation, 'Rotterdam, Netherlands');
    assert.equal(alice.nlRadiusKm, 25);
    assert.equal(bob.nlLocation, 'Utrecht, Netherlands');
    assert.notEqual(alice.nlLocation, bob.nlLocation);

    // Updating alice leaves bob alone.
    await db.prepare(`UPDATE indeed_settings SET nl_radius_km = 30, updated_at = ? WHERE user_id = ?`)
      .bind(now, 'alice').run();
    assert.equal((await loadIndeedSettings(db, 'alice')).nlRadiusKm, 30);
    assert.equal((await loadIndeedSettings(db, 'bob')).nlRadiusKm, 10);
  } finally {
    await dispose();
  }
});

test('collection uses persisted place and radius instead of hardcoded defaults', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: Array<{ location: string; radius: number; country: string }> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const headers = new Headers(init!.headers);
      const body = JSON.parse(String(init!.body)) as { query: string };
      const location = /where:\s*"((?:[^"\\]|\\.)*)"/.exec(body.query)?.[1] ?? '';
      const radius = Number(/radius:\s*(\d+)/.exec(body.query)?.[1] ?? -1);
      seen.push({ location, radius, country: headers.get('indeed-co')! });
      return Response.json({ data: { jobSearch: { results: [], pageInfo: { nextCursor: null } } } });
    };
    const settings = {
      nlLocation: 'Rotterdam, Netherlands',
      nlRadiusKm: 25,
      chLocation: 'Zurich, Switzerland',
      chRadiusKm: 50,
      updatedAt: '',
    };
    // 25 km -> 16 mi, 50 km -> 31 mi.
    assert.equal(kmToProviderMiles(25), 16);
    assert.equal(kmToProviderMiles(50), 31);
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL', 'CH'], settings);
    assert.equal(result.NL.status, 'complete');
    assert.equal(result.CH.status, 'complete');
    const nl = seen.find((entry) => entry.country === 'NL')!;
    const ch = seen.find((entry) => entry.country === 'CH')!;
    assert.match(nl.location, /Rotterdam/);
    assert.equal(nl.radius, 16);
    assert.match(ch.location, /Zurich/);
    assert.equal(ch.radius, 31);
  } finally {
    await dispose();
  }
});

test('collection without settings keeps the old defaults for pre-settings callers', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { query: string };
      seen.push(body.query);
      return Response.json({ data: { jobSearch: { results: [], pageInfo: { nextCursor: null } } } });
    };
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL']);
    assert.ok(seen[0].includes('Amsterdam, Netherlands'));
    assert.ok(seen[0].includes('radius: 10'));
  } finally {
    await dispose();
  }
});

test('Indeed settings API is admin-only and scoped to the session user', async () => {
  const route = await readFile(new URL('../app/api/admin/indeed/settings/route.ts', import.meta.url), 'utf8');
  assert.match(route, /requireSession\(request, \{ adminOnly: true \}\)/);
  assert.match(route, /WHERE user_id = \?/);
  assert.match(route, /user\.id/);
  assert.doesNotMatch(route, /body\.userId|searchParams\.get\(['"]user/);
  assert.match(route, /cleanIndeedSettingsInput/);
  assert.match(route, /400/);
});

test('ordinary accounts never receive Indeed settings from state or the API', async () => {
  const state = await readFile(new URL('../app/api/state/route.ts', import.meta.url), 'utf8');
  assert.match(state, /user\.role === 'admin' \? \{ indeedSettings/);
  assert.match(state, /indeedSettingsFromRow/);
  const settingsRoute = await readFile(new URL('../app/api/admin/indeed/settings/route.ts', import.meta.url), 'utf8');
  assert.match(settingsRoute, /adminOnly: true/);
  const scrape = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');
  assert.match(scrape, /FROM indeed_settings WHERE user_id = \?/);
});

test('deleting an account or resetting a workspace removes its Indeed settings', async () => {
  for (const file of ['../app/api/account/route.ts', '../app/api/workspace/route.ts', '../app/api/admin/route.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /DELETE FROM indeed_settings WHERE user_id = \?/, file);
  }
});
