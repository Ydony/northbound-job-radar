import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import {
  collectIndeed,
  INDEED_COVERAGE_OVERLAP_MS,
  INDEED_FINAL_BUDGET,
  INDEED_INITIAL_WINDOW_MS,
  INDEED_REUSE_FRESHNESS_MS,
} from '../lib/indeed/collection';

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
  for (const version of [19, 27]) {
    await db.batch(runtimeMigrations.find((m) => m.version === version)!.statements.map((sql) => db.prepare(sql)));
  }
  return { db, dispose: () => mf.dispose() };
}

async function cooldown(db: D1Database) {
  await db.prepare("UPDATE indeed_control SET cooldown_until = 0, lease_until = 0, lease_token = '' WHERE id = 'indeed'").run();
}

let keyCounter = 0;
function row(ageMs: number | null, country = 'NL') {
  keyCounter += 1;
  return {
    key: `cov-${keyCounter}`,
    title: `Synthetic role ${keyCounter}`,
    datePublished: ageMs == null ? 'not-a-date' : Date.now() - ageMs,
    description: { html: '<p>English-speaking team. Dutch is optional, not required.</p>' },
    location: { city: 'Amsterdam', countryCode: country },
    employer: { name: 'Synthetic BV' },
  };
}

function page(rows: unknown[], cursor: string | null) {
  return Response.json({ data: { jobSearch: { results: rows.map((job) => ({ job })), pageInfo: { nextCursor: cursor } } } });
}

function scripted(pages: Array<{ rows: unknown[]; cursor: string | null } | { status: number }>, seen: string[]) {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls += 1;
    seen.push(String(init!.body));
    const step = pages[Math.min(calls - 1, pages.length - 1)];
    if ('status' in step) return new Response('boom', { status: step.status, headers: { 'content-type': 'text/plain' } });
    return page(step.rows, step.cursor);
  };
  return { fetcher, calls: () => calls };
}

const recent = (n: number, ageMs = 3_600_000) => Array.from({ length: n }, () => row(ageMs));

async function coverage(db: D1Database) {
  return db.prepare('SELECT * FROM indeed_coverage').all().then((r) => r.results as Record<string, unknown>[]);
}

test('migration 27 creates the checkpoint table keyed by query identity', () => {
  const migration = runtimeMigrations.find((m) => m.version === 27);
  assert.ok(migration);
  assert.equal(migration.name, 'indeed_coverage_checkpoints');
  const sql = migration.statements.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS indeed_coverage/);
  assert.match(sql, /query_key TEXT PRIMARY KEY NOT NULL/);
  assert.match(sql, /covered_through_ms INTEGER/);
});

test('a successful first run stores complete coverage bounded by the run start', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher } = scripted([{ rows: recent(5), cursor: null }], seen);
    const before = Date.now();
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    const after = Date.now();
    assert.equal(result.NL.status, 'complete');
    assert.equal(result.NL.jobs.length, 5);
    const rows = await coverage(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'alice');
    assert.equal(rows[0].status, 'complete');
    const covered = rows[0].covered_through_ms as number;
    assert.ok(covered >= before && covered <= after, 'coverage advances to the run start, not completion or epoch');
    assert.equal(rows[0].window_start_ms, covered - INDEED_INITIAL_WINDOW_MS, 'first window is the initial 168h lookback');
  } finally {
    await dispose();
  }
});

test('an immediate identical click reuses results with no upstream request and never extends freshness', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher, calls } = scripted([{ rows: recent(3), cursor: null }], seen);
    const first = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    assert.equal(first.NL.jobs.length, 3);
    const stored = (await coverage(db))[0];
    await cooldown(db);
    const second = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    assert.equal(calls(), 1, 'the repeat click sends no upstream request');
    assert.equal(second.NL.jobs.length, 0);
    assert.equal(second.NL.status, 'complete');
    assert.match(second.NL.message, /Reused successful check/);
    assert.match(second.NL.message, /no upstream request/);
    const kept = (await coverage(db))[0];
    assert.equal(kept.last_check, stored.last_check, 'reuse leaves stored times alone: no indefinite cache');
    assert.deepEqual(second.NL.roles, ['analyst']);
  } finally {
    await dispose();
  }
});

test('a stale check refetches incrementally: late jobs surface, older rows drop, coverage advances', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher, calls } = scripted([{ rows: recent(2), cursor: null }], seen);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    // Pretend the successful check happened 25 hours ago.
    const then = Date.now() - 25 * 3_600_000;
    await db.prepare('UPDATE indeed_coverage SET last_check = ?, last_success = ?, covered_through_ms = ?, window_start_ms = ?')
      .bind(new Date(then).toISOString(), new Date(then).toISOString(), then, then - INDEED_INITIAL_WINDOW_MS).run();
    await cooldown(db);
    // A job posted 20h ago is inside the overlap window (25h + 6h); a 40h-old one is out.
    const late = row(20 * 3_600_000);
    const old = row(40 * 3_600_000);
    const { fetcher: refetch, calls: refetchCalls } = scripted([{ rows: [late, old, ...recent(1)], cursor: null }], seen);
    const second = await collectIndeed(db, config, ['analyst'], undefined, refetch, ['NL'],
      undefined, undefined, undefined, 'alice');
    assert.equal(refetchCalls(), 1, 'stale coverage searches again');
    assert.equal(calls(), 1);
    // Rows were [late (20h), old (40h), fresh]: the window starts 31h back, so
    // exactly the 40h-old row drops and the late-indexed one is kept.
    assert.equal(second.NL.jobs.length, 2, 'the 40h-old row drops out of the incremental window');
    const rows = await coverage(db);
    assert.ok((rows[0].covered_through_ms as number) > then, 'coverage advances on the new success');
  } finally {
    await dispose();
  }
});

test('changed settings start fresh coverage and leave the old checkpoint alone', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher, calls } = scripted([{ rows: recent(1), cursor: null }], seen);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      { nlLocation: 'Amsterdam, Netherlands', nlRadiusKm: 16, chLocation: 'Switzerland', chRadiusKm: 16, updatedAt: '' },
      undefined, undefined, 'alice');
    await cooldown(db);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      { nlLocation: 'Amsterdam, Netherlands', nlRadiusKm: 50, chLocation: 'Switzerland', chRadiusKm: 16, updatedAt: '' },
      undefined, undefined, 'alice');
    assert.equal(calls(), 2, 'a new radius is a new query identity: no reuse');
    assert.equal((await coverage(db)).length, 2);
  } finally {
    await dispose();
  }
});

test('a capped run stays incomplete without advancing, and the retry resumes the same window', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const endless = Array.from({ length: 12 }, (_, i) => ({ rows: recent(25), cursor: `q${i}` }));
    const { fetcher, calls } = scripted(endless, seen);
    const first = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, INDEED_FINAL_BUDGET, undefined, 'alice');
    assert.equal(first.NL.status, 'partial');
    let rows = await coverage(db);
    assert.equal(rows[0].status, 'incomplete');
    assert.equal(rows[0].covered_through_ms, 0, 'no advance on a capped run');
    const windowStart = rows[0].window_start_ms;
    await cooldown(db);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, INDEED_FINAL_BUDGET, undefined, 'alice');
    assert.ok(calls() > 8, 'incomplete coverage searches again instead of reusing');
    rows = await coverage(db);
    assert.equal(rows[0].window_start_ms, windowStart, 'the retry resumes the same window, never less');
  } finally {
    await dispose();
  }
});

test('a failed run keeps the previous successful boundary', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher } = scripted([{ rows: recent(2), cursor: null }], seen);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    const covered = (await coverage(db))[0].covered_through_ms;
    assert.ok((covered as number) > 0);
    await cooldown(db);
    // Force a refetch that fails: backdate past freshness, then serve a 500.
    await db.prepare('UPDATE indeed_coverage SET last_check = ?')
      .bind(new Date(Date.now() - INDEED_REUSE_FRESHNESS_MS - 1000).toISOString()).run();
    const { fetcher: failing } = scripted([{ status: 500 }], seen);
    const second = await collectIndeed(db, config, ['analyst'], undefined, failing, ['NL'],
      undefined, undefined, undefined, 'alice');
    assert.equal(second.NL.status, 'failed', 'no jobs and an upstream error is failed, not partial');
    const rows = await coverage(db);
    assert.equal(rows[0].status, 'incomplete');
    assert.equal(rows[0].covered_through_ms, covered, 'failure never moves the boundary back');
  } finally {
    await dispose();
  }
});

test('coverage is per owner and opt-in: no user means no writes, another user means no reuse', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher, calls } = scripted([{ rows: recent(1), cursor: null }], seen);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL']);
    assert.equal((await coverage(db)).length, 0, 'callers without an owner persist nothing');
    await cooldown(db);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    await cooldown(db);
    await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'bob');
    assert.equal(calls(), 3, 'bob does not reuse alice’s checkpoint');
    assert.equal((await coverage(db)).length, 2);
  } finally {
    await dispose();
  }
});

test('a second click while a run holds the lease attaches instead of duplicating requests', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher, calls } = scripted([{ rows: recent(1), cursor: null }], seen);
    await db.prepare("UPDATE indeed_control SET lease_token = 'other', lease_until = ? WHERE id = 'indeed'")
      .bind(Date.now() + 60_000).run();
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    assert.equal(calls(), 0);
    assert.equal(result.NL.status, 'unavailable');
    assert.match(result.NL.message, /attached/);
  } finally {
    await dispose();
  }
});

test('a job arriving during paging is kept and stays inside the next overlap window', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    // Posted one minute in the future relative to the run start: it arrived
    // while paging. The run-start boundary still covers it next time via overlap.
    const arriving = row(-60_000);
    const { fetcher } = scripted([{ rows: [arriving], cursor: null }], seen);
    const before = Date.now();
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, undefined, undefined, 'alice');
    assert.equal(result.NL.jobs.length, 1, 'the window is start-bounded only; arrivals during paging are kept');
    const rows = await coverage(db);
    const covered = rows[0].covered_through_ms as number;
    assert.ok(covered >= before, 'boundary is the run start');
    const keptPostedAt = Date.parse(result.NL.jobs[0].postedAt);
    assert.ok(keptPostedAt >= covered - INDEED_COVERAGE_OVERLAP_MS, 'the arrival stays inside the next overlap window');
  } finally {
    await dispose();
  }
});
