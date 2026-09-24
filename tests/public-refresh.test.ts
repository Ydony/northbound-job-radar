import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import {
  adminOnlySourcePolicyKeys,
  SOURCE_POLICY_REGISTRY,
} from '../lib/source-policy';
import {
  classifyUpstreamError,
  publicRefreshEligibleKeys,
  publicRefreshFreshness,
  claimQueuedRefresh,
  clearQueuedRefresh,
  requestCoalescedRefresh,
  runPublicRefresh,
  upstreamRefusal,
  type PublicRefreshFetch,
} from '../lib/public-refresh';
import {
  buildPublicRefreshFetchers,
  handlePublicRefreshCron,
  parseRefreshTerms,
  resolvePublicRefreshFetcher,
} from '../lib/public-refresh-scheduler';

/**
 * INT-06 (#165): bounded scheduled refresh, tested against real D1 SQL with
 * synthetic fetchers only. No live upstream, no production, no secrets.
 *
 * The contract under test:
 * - only public-eligible enabled sources are ever refreshed; fetchers keyed
 *   outside that set (including every admin-only key) are never called;
 * - identical concurrent runs never duplicate an upstream call (lease → busy);
 * - 429 persists a cooldown across restarts and honors Retry-After;
 * - 401/403/challenge pauses the source until operator review;
 * - transient 5xx gets bounded retries only, then a failure count;
 * - locks, cursors and freshness timestamps survive restarts (same D1);
 * - an expired catalogue queues exactly one coalesced refresh.
 */

const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const WINDOW = 60_000;
const NO_SLEEP = () => Promise.resolve();

let shared: { db: D1Database; dispose: () => Promise<void> } | undefined;

async function db(): Promise<D1Database> {
  if (!shared) {
    const runtime = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("test"); } };',
      compatibilityDate: '2026-05-15',
      d1Databases: ['DB'],
    });
    const handle = await runtime.getD1Database('DB') as unknown as D1Database;
    const migration = runtimeMigrations.find((entry) => entry.version === 31);
    assert.ok(migration, 'migration 31 is missing');
    for (const statement of migration.statements) {
      await handle.prepare(statement).run();
    }
    shared = { db: handle, dispose: () => runtime.dispose() };
  }
  await shared.db.prepare('DELETE FROM public_refresh_state').run();
  await shared.db.prepare('DELETE FROM public_refresh_queue').run();
  return shared.db;
}

test.after(async () => {
  await shared?.dispose();
});

function expectedEligible(): string[] {
  return SOURCE_POLICY_REGISTRY.filter((entry) => entry.audience === 'public' && entry.enabled)
    .map((entry) => entry.key);
}

function okFetcher(calls: { count: number; cursors: string[] }, nextCursor = 'cursor-1'): PublicRefreshFetch {
  return async (cursor: string) => {
    calls.count += 1;
    calls.cursors.push(cursor);
    return { adverts: [{ sourceUrl: 'https://example.com/job/1', title: 'Engineer' }], nextCursor };
  };
}

function okFetchers(): { fetchers: Record<string, PublicRefreshFetch>; calls: Record<string, { count: number; cursors: string[] }> } {
  const calls: Record<string, { count: number; cursors: string[] }> = {};
  const fetchers: Record<string, PublicRefreshFetch> = {};
  for (const key of publicRefreshEligibleKeys()) {
    calls[key] = { count: 0, cursors: [] };
    fetchers[key] = okFetcher(calls[key]);
  }
  return { fetchers, calls };
}

test('the refresh set is exactly the public-eligible enabled sources', () => {
  assert.deepEqual(publicRefreshEligibleKeys(), expectedEligible());
  const adminOnly = new Set(adminOnlySourcePolicyKeys());
  for (const key of publicRefreshEligibleKeys()) {
    assert.equal(adminOnly.has(key), false, `${key} is admin-only but refreshable`);
  }
  assert.ok(publicRefreshEligibleKeys().length > 0, 'expected at least one public source');
});

test('unwired sources report unavailable and admin-keyed fetchers are never called', async () => {
  const handle = await db();
  const adminCalls: Record<string, number> = {};
  const fetchers: Record<string, PublicRefreshFetch> = {};
  for (const key of adminOnlySourcePolicyKeys()) {
    adminCalls[key] = 0;
    fetchers[key] = async () => {
      adminCalls[key] += 1;
      return { adverts: [], nextCursor: '' };
    };
  }
  const report = await runPublicRefresh(handle, fetchers, { now: T0, windowMs: WINDOW, sleep: NO_SLEEP });
  for (const result of report.results) {
    assert.equal(result.status, 'unavailable', `${result.sourceKey} should be unwired, not fetched`);
  }
  for (const [key, count] of Object.entries(adminCalls)) {
    assert.equal(count, 0, `admin-only fetcher ${key} was called`);
  }
  assert.deepEqual(report.ignoredKeys.sort(), Object.keys(adminCalls).sort());
});

test('a successful pass persists cursor and freshness; a fresh source is not re-fetched', async () => {
  const handle = await db();
  const { fetchers, calls } = okFetchers();
  const firstKey = publicRefreshEligibleKeys()[0];
  const first = await runPublicRefresh(handle, fetchers, { now: T0, windowMs: WINDOW, sleep: NO_SLEEP });
  assert.equal(first.results.find((entry) => entry.sourceKey === firstKey)?.status, 'complete');
  assert.equal(calls[firstKey].count, 1);
  assert.deepEqual(calls[firstKey].cursors, ['']);

  const second = await runPublicRefresh(handle, fetchers, { now: T0 + 1_000, windowMs: WINDOW, sleep: NO_SLEEP });
  assert.equal(second.results.find((entry) => entry.sourceKey === firstKey)?.status, 'fresh');
  assert.equal(calls[firstKey].count, 1, 'a fresh source costs no second request');

  const third = await runPublicRefresh(handle, { [firstKey]: fetchers[firstKey] }, { now: T0 + WINDOW + 1, windowMs: WINDOW, sleep: NO_SLEEP });
  assert.equal(third.results.find((entry) => entry.sourceKey === firstKey)?.status, 'complete');
  assert.deepEqual(calls[firstKey].cursors, ['', 'cursor-1'], 'the persisted cursor resumes the next pass');
});

test('identical concurrent runs never duplicate an upstream call', async () => {
  const handle = await db();
  const firstKey = publicRefreshEligibleKeys()[0];
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const slow: PublicRefreshFetch = async () => {
    calls += 1;
    await gate;
    return { adverts: [], nextCursor: '' };
  };
  const run = () => runPublicRefresh(handle, { [firstKey]: slow }, { now: T0, windowMs: WINDOW, sleep: NO_SLEEP });
  const both = Promise.all([run(), run()]);
  // Let both prefixes reach the lease before the fetch can complete.
  await new Promise((done) => setTimeout(done, 200));
  release();
  const [first, second] = await both;
  assert.equal(calls, 1, 'one upstream call for two identical concurrent runs');
  const statuses = [first, second].map((report) => report.results.find((entry) => entry.sourceKey === firstKey)?.status).sort();
  assert.deepEqual(statuses, ['busy', 'complete']);
});

test('a 429 persists its cooldown across restarts and honors Retry-After', async () => {
  const handle = await db();
  const firstKey = publicRefreshEligibleKeys()[0];
  let calls = 0;
  const limited: PublicRefreshFetch = async () => {
    calls += 1;
    throw upstreamRefusal(429, 120);
  };
  const run = (now: number) => runPublicRefresh(handle, { [firstKey]: limited }, { now, windowMs: WINDOW, sleep: NO_SLEEP });
  const first = await run(T0);
  assert.equal(first.results[0].status, 'cooldown');
  assert.equal(first.results[0].retryAfterSeconds, 120);
  // A restart is just a later call against the same D1: the cooldown holds.
  const second = await run(T0 + 10_000);
  assert.equal(second.results[0].status, 'cooldown');
  assert.equal(second.results[0].retryAfterSeconds, 110);
  assert.equal(calls, 1, 'no request while cooling down');
  const third = await run(T0 + 121_000);
  assert.equal(third.results[0].status, 'cooldown', 'the source still refuses, so it cools down again');
  assert.equal(calls, 2);
});

test('Retry-After is read from refusal wording when no structured value exists', async () => {
  const handle = await db();
  const firstKey = publicRefreshEligibleKeys()[0];
  const limited: PublicRefreshFetch = async () => {
    throw new Error('Example request failed (429). Retry-After: 45');
  };
  const report = await runPublicRefresh(handle, { [firstKey]: limited }, { now: T0, windowMs: WINDOW, sleep: NO_SLEEP });
  assert.equal(report.results[0].status, 'cooldown');
  assert.equal(report.results[0].retryAfterSeconds, 45);
});

test('a 401 pauses the source until operator review, durably', async () => {
  const handle = await db();
  const firstKey = publicRefreshEligibleKeys()[0];
  let calls = 0;
  const refused: PublicRefreshFetch = async () => {
    calls += 1;
    throw upstreamRefusal(401);
  };
  const run = (now: number) => runPublicRefresh(handle, { [firstKey]: refused }, { now, windowMs: WINDOW, sleep: NO_SLEEP });
  assert.equal((await run(T0)).results[0].status, 'paused');
  assert.equal((await run(T0 + 3600_000)).results[0].status, 'paused', 'a pause is not a cooldown: time alone does not clear it');
  assert.equal(calls, 1, 'a paused source is never re-requested');
  const freshness = await publicRefreshFreshness(handle, { now: T0 + 3600_000, windowMs: WINDOW });
  assert.equal(freshness.find((entry) => entry.sourceKey === firstKey)?.paused, true);
});

test('challenge wording pauses rather than retrying', async () => {
  const handle = await db();
  const firstKey = publicRefreshEligibleKeys()[0];
  let calls = 0;
  const challenged: PublicRefreshFetch = async () => {
    calls += 1;
    throw new Error('Examplebot challenge detected, access denied.');
  };
  const report = await runPublicRefresh(handle, { [firstKey]: challenged }, { now: T0, windowMs: WINDOW, sleep: NO_SLEEP });
  assert.equal(report.results[0].status, 'paused');
  assert.equal(calls, 1, 'a challenge is never retried');
});

test('transient 5xx faults get bounded retries only, then a failure count', async () => {
  const handle = await db();
  const firstKey = publicRefreshEligibleKeys()[0];
  let calls = 0;
  const flaky: PublicRefreshFetch = async () => {
    calls += 1;
    if (calls < 3) throw new Error('Upstream request failed (500).');
    return { adverts: [], nextCursor: '' };
  };
  const recovered = await runPublicRefresh(handle, { [firstKey]: flaky },
    { now: T0, windowMs: WINDOW, sleep: NO_SLEEP, maxRetries: 2 });
  assert.equal(recovered.results[0].status, 'complete');
  assert.equal(calls, 3, 'initial attempt plus two bounded retries');

  const downDb = await db();
  let downCalls = 0;
  const down: PublicRefreshFetch = async () => {
    downCalls += 1;
    throw new Error('Upstream request failed (503).');
  };
  const failed = await runPublicRefresh(downDb, { [firstKey]: down },
    { now: T0, windowMs: WINDOW, sleep: NO_SLEEP, maxRetries: 2 });
  assert.equal(failed.results[0].status, 'failed');
  assert.equal(downCalls, 3, 'exactly 1 + maxRetries attempts, never more');
  const row = await downDb.prepare('SELECT consecutive_failures AS failures, paused FROM public_refresh_state WHERE source_key = ?')
    .bind(firstKey).first<{ failures: number; paused: number }>();
  assert.equal(row?.failures, 1);
  assert.equal(row?.paused, 0, 'a transient failure never pauses the source');
});

test('a bare "Service Unavailable" without a status never reads as a refusal', () => {
  assert.deepEqual(classifyUpstreamError(new Error('Service Unavailable')), { fate: 'transient' });
  assert.deepEqual(classifyUpstreamError(new Error('Upstream request failed (500).')), { fate: 'transient' });
  assert.deepEqual(classifyUpstreamError(new Error('timed out after 8000ms')), { fate: 'transient' });
  assert.deepEqual(classifyUpstreamError(upstreamRefusal(429, 30)), { fate: 'cooldown', retryAfterSeconds: 30 });
  assert.deepEqual(classifyUpstreamError(new Error('Example request failed (429).')), { fate: 'cooldown', retryAfterSeconds: undefined });
  assert.deepEqual(classifyUpstreamError(new Error('rate_limited')), { fate: 'cooldown', retryAfterSeconds: undefined });
  assert.deepEqual(classifyUpstreamError(upstreamRefusal(403)), { fate: 'paused' });
  assert.deepEqual(classifyUpstreamError(new Error('jobs.ch request failed (403).')), { fate: 'paused' });
  assert.deepEqual(classifyUpstreamError(new Error('bot challenge')), { fate: 'paused' });
});

test('an expired catalogue queues exactly one coalesced refresh', async () => {
  const handle = await db();
  assert.equal(await requestCoalescedRefresh(handle, { now: T0, windowMs: WINDOW }), 'queued');
  assert.equal(await requestCoalescedRefresh(handle, { now: T0, windowMs: WINDOW }), 'already-queued',
    'ten visitors with a stale catalogue queue one refresh, not ten');
  assert.equal(await claimQueuedRefresh(handle), true, 'exactly one claimant wins');
  assert.equal(await claimQueuedRefresh(handle), false);
  await clearQueuedRefresh(handle);
  assert.equal(await requestCoalescedRefresh(handle, { now: T0, windowMs: WINDOW }), 'queued',
    'still stale after the run cleared nothing, so demand queues again');
});

test('a running refresh absorbs queue demand; a fresh catalogue queues nothing', async () => {
  const handle = await db();
  const firstKey = publicRefreshEligibleKeys()[0];
  await handle.prepare(`INSERT INTO public_refresh_state (source_key, lease_token, lease_until, updated_at)
    VALUES (?, 'held', ?, ?)`).bind(firstKey, T0 + 60_000, new Date(T0).toISOString()).run();
  assert.equal(await requestCoalescedRefresh(handle, { now: T0, windowMs: WINDOW }), 'running');

  const freshDb = await db();
  const { fetchers } = okFetchers();
  await runPublicRefresh(freshDb, fetchers, { now: T0, windowMs: WINDOW, sleep: NO_SLEEP });
  assert.equal(await requestCoalescedRefresh(freshDb, { now: T0 + 1_000, windowMs: WINDOW }), 'fresh');
});

test('freshness disclosure reports last success, staleness, pause and cooldown', async () => {
  const handle = await db();
  const keys = publicRefreshEligibleKeys();
  const calls: Record<string, number> = {};
  const fetchers: Record<string, PublicRefreshFetch> = {
    [keys[0]]: async () => ({ adverts: [], nextCursor: '' }),
    [keys[1]]: async () => {
      calls[keys[1]] = (calls[keys[1]] ?? 0) + 1;
      throw upstreamRefusal(429, 90);
    },
  };
  await runPublicRefresh(handle, fetchers, { now: T0, windowMs: WINDOW, sleep: NO_SLEEP });
  const freshness = await publicRefreshFreshness(handle, { now: T0 + 1_000, windowMs: WINDOW });
  assert.equal(freshness.length, keys.length, 'every eligible source is disclosed');
  const ok = freshness.find((entry) => entry.sourceKey === keys[0])!;
  assert.equal(ok.lastSuccess, new Date(T0).toISOString());
  assert.equal(ok.stale, false);
  const cooling = freshness.find((entry) => entry.sourceKey === keys[1])!;
  assert.equal(cooling.retryAfterSeconds, 89);
  assert.equal(cooling.stale, true);
  const never = freshness.find((entry) => entry.sourceKey === keys[2])!;
  assert.equal(never.lastSuccess, '');
  assert.equal(never.stale, true);
});

test('the scheduler resolves every eligible key and refuses every admin-only one', () => {
  for (const key of publicRefreshEligibleKeys()) {
    assert.ok(resolvePublicRefreshFetcher(key, ['engineer']), `${key} should resolve`);
  }
  for (const key of adminOnlySourcePolicyKeys()) {
    assert.throws(() => resolvePublicRefreshFetcher(key, ['engineer']), /not a public-eligible enabled source/,
      `admin-only ${key} must never resolve to a refresh fetcher`);
  }
  assert.throws(() => resolvePublicRefreshFetcher('no-such-source', ['engineer']), /not a public-eligible enabled source/);
  assert.deepEqual(parseRefreshTerms(undefined), []);
  assert.deepEqual(parseRefreshTerms(' engineer, ,analyst '), ['engineer', 'analyst']);
});

test('empty terms wire no fetchers: the run reports instead of contacting anyone', () => {
  assert.deepEqual(buildPublicRefreshFetchers([]), {});
  const wired = buildPublicRefreshFetchers(['engineer']);
  assert.deepEqual(Object.keys(wired).sort(), publicRefreshEligibleKeys().sort());
});

test('a resolved public fetcher only ever calls its own public endpoint', async () => {
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    return new Response('Internal Server Error', { status: 500 });
  }) as typeof fetch;
  try {
    const fetcher = resolvePublicRefreshFetcher('eures-ch', ['engineer']);
    await assert.rejects(fetcher(''), /EURES request failed \(500\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(requested.length > 0, 'expected at least one upstream request');
  const adminHosts = ['jobs.ch', 'jobup.ch', 'jobscout24.ch', 'iamexpat.nl', 'undutchables.nl',
    'adzuna.com', 'careerjet', 'jobviewtrack.com', 'indeed.com'];
  for (const url of requested) {
    const host = new URL(url).hostname;
    for (const adminHost of adminHosts) {
      assert.equal(host.includes(adminHost), false, `public refresh requested an admin-only host: ${url}`);
    }
  }
});

test('the disabled cron handler touches nothing; the enabled one never reaches admin keys', async () => {
  const handle = await db();
  let publicCalls = 0;
  let adminCalls = 0;
  const fetchers: Record<string, PublicRefreshFetch> = {
    [publicRefreshEligibleKeys()[0]]: async () => {
      publicCalls += 1;
      return { adverts: [], nextCursor: '' };
    },
    [adminOnlySourcePolicyKeys()[0]]: async () => {
      adminCalls += 1;
      return { adverts: [], nextCursor: '' };
    },
  };
  const off = await handlePublicRefreshCron({ db: handle, enabled: false, terms: ['engineer'], fetchers });
  assert.equal(off.enabled, false);
  assert.equal(publicCalls, 0, 'a disabled handler sends no request at all');
  assert.equal(adminCalls, 0);

  await handle.prepare(`INSERT INTO public_refresh_queue (id, status, requested_at, updated_at)
    VALUES ('global', 'queued', ?, ?)`).bind(new Date(T0).toISOString(), new Date(T0).toISOString()).run();
  const on = await handlePublicRefreshCron({ db: handle, enabled: true, terms: ['engineer'], fetchers, now: T0 });
  assert.equal(on.enabled, true);
  assert.equal(on.claimedQueue, true, 'a queued coalesced refresh is claimed by the tick');
  assert.equal(publicCalls, 1);
  assert.equal(adminCalls, 0, 'the enabled handler never touches an admin-only key');
  const queue = await handle.prepare("SELECT id FROM public_refresh_queue WHERE id = 'global'")
    .first<{ id: string }>();
  assert.equal(queue, null, 'the claimed queue is cleared after the run');
});

test('the collector never imports the adapter registry; the scheduler never page-fetches', async () => {
  const collector = await readFile(new URL('../lib/public-refresh.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(collector, /from\s+['"]\.\/job-adapters['"]/,
    'admin-only adapters must be unreachable at import level: the collector takes injected fetchers');
  const scheduler = await readFile(new URL('../lib/public-refresh-scheduler.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(scheduler, /\.fetchDetail\s*\(/,
    'the public refresh uses bulk search only, never per-advert detail fetching');
  assert.doesNotMatch(scheduler, /puppeteer|playwright|ProxyAgent|proxy-agent|headless|stealth/i,
    'no evasion mechanisms: no proxy rotation, no browser fallback');
});
