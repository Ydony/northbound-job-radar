import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { durableRateLimit, nativeRateLimit } from '../lib/rate-limit';

/**
 * The old limiter read the count and incremented it in separate statements, so concurrent
 * requests could all read the same count and all slip under the limit; it also failed open when
 * storage errored. These tests run against real D1 SQL (Miniflare), so a non-atomic
 * implementation or a fail-open fault path fails here instead of passing against a mock.
 */

async function rateLimitDatabase() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  const migration = runtimeMigrations.find((entry) => entry.version === 15)!;
  await db.batch(migration.statements.map((sql) => db.prepare(sql)));
  return { db, dispose: () => runtime.dispose() };
}

test('concurrent attempts share one atomic counter: exactly the limit passes', async () => {
  const { db, dispose } = await rateLimitDatabase();
  try {
    const limit = 5;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => durableRateLimit(db, 'auth:ip:203.0.113.7', limit, 15 * 60_000)),
    );
    assert.equal(outcomes.filter((outcome) => outcome === null).length, limit,
      'concurrent requests must not all read the same count and slip through');
    const rejected = outcomes.filter((outcome) => outcome !== null);
    assert.equal(rejected.length, 10 - limit);
    for (const response of rejected) {
      assert.equal(response!.status, 429);
      assert.ok(response!.headers.get('retry-after'), 'a rejection names when to retry');
    }
    const stored = await db.prepare('SELECT count FROM rate_limits WHERE bucket = ?')
      .bind('auth:ip:203.0.113.7').first<{ count: number }>();
    assert.equal(stored?.count, 10, 'rejected attempts are recorded, not silently discarded');
  } finally {
    await dispose();
  }
});

test('a rolled-over window starts counting again instead of staying blocked', async () => {
  const { db, dispose } = await rateLimitDatabase();
  try {
    await db.prepare('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, ?, ?)')
      .bind('auth:ip:198.51.100.9', 20, Date.now() - 1000).run();
    const first = await durableRateLimit(db, 'auth:ip:198.51.100.9', 5, 15 * 60_000);
    assert.equal(first, null, 'an expired window must admit the next attempt');
    const stored = await db.prepare('SELECT count FROM rate_limits WHERE bucket = ?')
      .bind('auth:ip:198.51.100.9').first<{ count: number }>();
    assert.equal(stored?.count, 1, 'the expired count resets rather than incrementing');
  } finally {
    await dispose();
  }
});

test('a database fault refuses attempts instead of admitting them', async () => {
  const broken = { prepare() { throw new Error('storage down'); } } as unknown as D1Database;
  const response = await durableRateLimit(broken, 'auth:ip:203.0.113.7', 5, 15 * 60_000);
  assert.ok(response, 'a limiter that allows attempts when the counter is down is an open door');
  assert.equal(response!.status, 503);
  assert.match(String((await response!.json() as { error?: string }).error), /temporarily unavailable/);
});

test('the native edge limiter blocks without touching the database', async () => {
  // nativeRateLimit takes no database handle at all: a block is decided purely at the edge, so a
  // blocked flood never costs a database round trip. The auth route returns this response before
  // reaching the database limiter.
  const blocking = { limit: async () => ({ success: false }) };
  const response = await nativeRateLimit(blocking, 'auth:203.0.113.7');
  assert.ok(response);
  assert.equal(response!.status, 429);
  assert.equal(response!.headers.get('retry-after'), '60');
});

test('the native edge limiter passes clean traffic through to the database limiter', async () => {
  const { db, dispose } = await rateLimitDatabase();
  try {
    const passing = { limit: async () => ({ success: true }) };
    assert.equal(await nativeRateLimit(passing, 'auth:203.0.113.7'), null);
    assert.equal(await durableRateLimit(db, 'auth:ip:203.0.113.7', 5, 15 * 60_000), null);
  } finally {
    await dispose();
  }
});

test('a failing native binding falls through to the database limiter', async () => {
  const { db, dispose } = await rateLimitDatabase();
  try {
    const failing = { limit: async (): Promise<{ success: boolean }> => { throw new Error('edge down'); } };
    assert.equal(await nativeRateLimit(failing, 'auth:203.0.113.7'), null,
      'an edge fault must not take sign-in down while the database limiter still holds');
    assert.equal(await durableRateLimit(db, 'auth:ip:203.0.113.7', 5, 15 * 60_000), null);
  } finally {
    await dispose();
  }
});

test('a missing native binding skips that layer entirely', async () => {
  assert.equal(await nativeRateLimit(undefined, 'auth:203.0.113.7'), null);
  assert.equal(await nativeRateLimit(null, 'auth:203.0.113.7'), null);
});
