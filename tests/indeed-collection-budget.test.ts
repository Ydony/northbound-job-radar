import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import {
  collectIndeed,
  INDEED_FINAL_BUDGET,
  INDEED_INITIAL_WINDOW_MS,
  INDEED_RUNNING_BUDGET,
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
  const v19 = runtimeMigrations.find((m) => m.version === 19)!;
  await db.batch(v19.statements.map((sql) => db.prepare(sql)));
  return { db, dispose: () => mf.dispose() };
}

let keyCounter = 0;
function row(ageMs: number | null, country = 'NL') {
  keyCounter += 1;
  return {
    key: `job-${keyCounter}`,
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

/** Serves scripted pages in order per query; records what the collector asked for. */
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

const recent = (n: number, country = 'NL') => Array.from({ length: n }, () => row(3_600_000, country));

test('running budget is unchanged: 25-row pages, one request per query, four per click', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const endless = Array.from({ length: 8 }, (_, i) => ({ rows: recent(25), cursor: `c${i}` }));
    const { fetcher, calls } = scripted(endless, seen);
    const result = await collectIndeed(db, config, ['analyst', 'master data'], undefined, fetcher, ['NL', 'CH']);
    assert.equal(calls(), 4);
    assert.ok(seen.every((query) => query.includes('limit: 25')), 'every page asks for 25 rows');
    // Full single pages with more upstream trigger the honest cap note, not a false complete.
    assert.equal(result.NL.status, 'partial');
    assert.match(result.NL.message, /25 per query/);
    assert.equal(result.NL.retrieved, 50);
  } finally {
    await dispose();
  }
});

test('recency is enforced locally: relevance order is sent, old rows drop, unknown dates stay', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const old = Array.from({ length: 5 }, () => row(10 * 24 * 3_600_000));
    const { fetcher } = scripted([{ rows: [...recent(3), ...old, row(null)], cursor: null }], seen);
    assert.ok(seen.length === 0);
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, INDEED_RUNNING_BUDGET, Date.now() - INDEED_INITIAL_WINDOW_MS);
    assert.ok(seen[0].includes('sort: RELEVANCE'), 'upstream order is relevance; the window is applied here, not upstream');
    // Exhausted source, but out-of-window rows were dropped: partial is honest,
    // and retrieved (9) vs kept (4) shows what the window removed.
    assert.equal(result.NL.status, 'partial');
    assert.equal(result.NL.jobs.length, 4, '3 recent + 1 undated kept; 5 old dropped');
    assert.equal(result.NL.retrieved, 9);
  } finally {
    await dispose();
  }
});

test('final design stops at 200 upstream rows per query with truthful partial status', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const endless = Array.from({ length: 12 }, (_, i) => ({ rows: recent(25), cursor: `k${i}` }));
    const { fetcher, calls } = scripted(endless, seen);
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, INDEED_FINAL_BUDGET);
    assert.equal(calls(), 8, 'eight 25-row pages reach exactly 200');
    assert.equal(result.NL.retrieved, 200);
    assert.equal(result.NL.jobs.length, 200);
    assert.equal(result.NL.status, 'partial');
    assert.match(result.NL.message, /200 per query/);
    assert.match(result.NL.message, /more results may exist upstream/);
  } finally {
    await dispose();
  }
});

test('final design stops the whole run at the total cap and leaves later queries unsent', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const endless = Array.from({ length: 20 }, (_, i) => ({ rows: recent(25), cursor: `t${i}` }));
    const { fetcher, calls } = scripted(endless, seen);
    const budget = { ...INDEED_FINAL_BUDGET, perQueryMaxRows: 200, totalMaxRows: 300 };
    const result = await collectIndeed(db, config, ['aaa', 'bbb'], undefined, fetcher, ['NL', 'CH'],
      undefined, budget);
    assert.equal(result.NL.retrieved, 300);
    assert.equal(result.CH.requests, 0, 'no request after the whole-run cap binds');
    assert.equal(result.CH.status, 'unavailable');
    assert.match(result.CH.message, /300 whole run/);
    assert.equal(calls(), 12);
  } finally {
    await dispose();
  }
});

test('a failed page keeps earlier results and reports partial, never a crash', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher } = scripted([{ rows: recent(25), cursor: 'next' }, { status: 500 }], seen);
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, INDEED_FINAL_BUDGET);
    assert.equal(result.NL.jobs.length, 25);
    assert.equal(result.NL.retrieved, 25);
    assert.equal(result.NL.status, 'partial');
    assert.match(result.NL.message, /upstream error/);
  } finally {
    await dispose();
  }
});

test('cancellation ends the run without hanging', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher } = scripted([{ rows: recent(25), cursor: 'next' }], seen);
    const controller = new AbortController();
    controller.abort();
    const result = await collectIndeed(db, config, ['analyst'], controller.signal, fetcher, ['NL'],
      undefined, INDEED_FINAL_BUDGET);
    assert.equal(result.NL.jobs.length, 0);
    assert.equal(result.NL.status, 'unavailable');
    assert.match(result.NL.message, /cancelled/);
  } finally {
    await dispose();
  }
});

test('deselected countries stay disabled with zero requests', async () => {
  const { db, dispose } = await fixture();
  try {
    const countries: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      countries.push(new Headers(init!.headers).get('indeed-co')!);
      return page(recent(25), null);
    };
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL']);
    assert.deepEqual(countries, ['NL']);
    assert.equal(result.CH.status, 'disabled');
    assert.equal(result.CH.requests, 0);
  } finally {
    await dispose();
  }
});

test('early exhaustion below the cap completes and keeps every in-window row', async () => {
  const { db, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const { fetcher, calls } = scripted([
      { rows: recent(25), cursor: 'p1' },
      { rows: recent(25), cursor: 'p2' },
      { rows: recent(10), cursor: null },
    ], seen);
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL'],
      undefined, INDEED_FINAL_BUDGET);
    assert.equal(calls(), 3, 'no filler requests after exhaustion');
    assert.equal(result.NL.status, 'complete');
    assert.equal(result.NL.jobs.length, 60);
    assert.equal(result.NL.retrieved, 60);
  } finally {
    await dispose();
  }
});
