import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { criteriaFromRow } from '../lib/server-data';
import { defaultSearchCriteria } from '../lib/criteria';

/**
 * #72: two switches decide which countries a search contacts.
 *
 * Real D1 rather than a mock, so the migration's own DEFAULT is what gets tested. The thing most
 * worth proving is that an existing account keeps searching what it searched yesterday: somebody
 * who has never seen this setting has not asked to search less.
 */
async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  // The pre-migration-18 shape, written out rather than imported, because db/runtime.ts now
  // carries the new columns and importing it would test nothing.
  await db.prepare(`CREATE TABLE search_settings (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    role_override_a TEXT NOT NULL DEFAULT '',
    role_override_b TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    workplace TEXT NOT NULL DEFAULT 'any',
    seniority TEXT NOT NULL DEFAULT 'any',
    contract_type TEXT NOT NULL DEFAULT 'any',
    required_keywords TEXT NOT NULL DEFAULT '[]',
    excluded_keywords TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`).run();
  return { db, dispose: () => runtime.dispose() };
}

test('an account that predates the setting keeps searching both countries', async () => {
  const { db, dispose } = await fixture();
  try {
    await db.prepare("INSERT INTO search_settings (id, user_id, updated_at) VALUES ('settings:alice', 'alice', '2026-09-01')").run();

    const migration = runtimeMigrations.find((entry) => entry.version === 18);
    assert.ok(migration, 'migration 18 must exist');
    assert.equal(migration.name, 'country_search_switches');
    await db.batch(migration.statements.map((sql) => db.prepare(sql)));

    const row = await db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind('alice')
      .first<Record<string, unknown>>();
    assert.equal(row?.search_netherlands, 1);
    assert.equal(row?.search_switzerland, 1);

    // The whole point: the row existed before the setting did, and it still searches both.
    const criteria = criteriaFromRow(row as never, []);
    assert.equal(criteria.searchNetherlands, true);
    assert.equal(criteria.searchSwitzerland, true);
  } finally {
    await dispose();
  }
});

test('switching one country off survives a reload and leaves the other alone', async () => {
  const { db, dispose } = await fixture();
  try {
    await db.prepare("INSERT INTO search_settings (id, user_id, updated_at) VALUES ('settings:alice', 'alice', '2026-09-01')").run();
    await db.prepare("INSERT INTO search_settings (id, user_id, updated_at) VALUES ('settings:bob', 'bob', '2026-09-01')").run();
    await db.batch(runtimeMigrations.find((entry) => entry.version === 18)!.statements.map((sql) => db.prepare(sql)));

    await db.prepare('UPDATE search_settings SET search_switzerland = 0 WHERE user_id = ?').bind('alice').run();

    const reloaded = await db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind('alice')
      .first<Record<string, unknown>>();
    const alice = criteriaFromRow(reloaded as never, []);
    assert.equal(alice.searchSwitzerland, false);
    assert.equal(alice.searchNetherlands, true, 'switching one off must not touch the other');

    // Per account, not per installation.
    const bobRow = await db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind('bob')
      .first<Record<string, unknown>>();
    assert.equal(criteriaFromRow(bobRow as never, []).searchSwitzerland, true);
  } finally {
    await dispose();
  }
});

test('a missing row reads as both countries on, never as neither', () => {
  // A null row is a brand-new account. Reading absence as "off" would hand someone a dashboard
  // whose search button is disabled before they have touched anything.
  const criteria = criteriaFromRow(null, []);
  assert.equal(criteria.searchNetherlands, true);
  assert.equal(criteria.searchSwitzerland, true);
  assert.equal(defaultSearchCriteria.searchNetherlands, true);
  assert.equal(defaultSearchCriteria.searchSwitzerland, true);
});

test('the search refuses to run with both countries off, and reports a skip as a choice', async () => {
  const source = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');

  // Refused rather than run: a search that contacts nothing looks exactly like a search that
  // found nothing, and nobody could tell which had happened.
  assert.match(source, /if \(!criteria\.searchNetherlands && !criteria\.searchSwitzerland\) \{/);
  assert.match(source, /Both countries are switched off in Search settings/);

  // The gate is applied to the permitted set, so it cannot accidentally re-admit a source that
  // the access or admin-only rules already removed.
  assert.match(source, /const activeAdapters = permittedAdapters\.filter\(\(adapter\) => countrySearched\(adapter\.country\)\)/);
  assert.match(source, /const skippedAdapters = permittedAdapters\.filter\(\(adapter\) => !countrySearched\(adapter\.country\)\)/);

  // Reported, not omitted: leaving it out would make Search statistics silently shrink.
  assert.match(source, /for \(const adapter of skippedAdapters\)/);
  assert.match(source, /status: 'skipped'/);

  // And a deliberate skip must not be counted as something going wrong.
  assert.match(source, /source\.status !== 'complete' && source\.status !== 'skipped'/);
});

test('both countries off disables the search button from the saved setting, not the draft', async () => {
  const source = await readFile(new URL('../app/job-radar.tsx', import.meta.url), 'utf8');

  // Read from state, not criteriaDraft: a search uses what was saved, so an untouched tick in the
  // form must not decide whether the button works.
  assert.match(source, /const noCountrySearched = !state\.criteria\.searchNetherlands && !state\.criteria\.searchSwitzerland;/);
  assert.match(source, /!criteriaDraft\.searchNetherlands && !criteriaDraft\.searchSwitzerland\s*&& <p className="switch-warning"/,
    'the draft may only drive the in-form warning, never the button');

  // Disabled AND told why. A button that silently does nothing is the most common reason someone
  // presses it twice.
  const disabled = [...source.matchAll(/disabled=\{loading \|\| Boolean\(loadError\) \|\| Boolean\(scrapeBusy\) \|\| noCountrySearched\}/g)];
  assert.equal(disabled.length, 2, 'both the authorized and the administrator search must be disabled');
  assert.match(source, /Both countries are switched off in\s*\{' '\}<a href="#criteria"/);

  // This setting decides what is collected; the country facet narrows what is shown. The UX
  // audit's finding 02 is that two filters which do not know about each other leave someone
  // unable to tell which one emptied the list, so the copy has to say which this is.
  assert.match(source, /This decides which countries a search contacts\./);
  assert.match(source, /It does not hide jobs you have\s*already collected/);
});
