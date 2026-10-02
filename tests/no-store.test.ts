import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NO_STORE_HEADERS, noStoreJson, withNoStore } from '../lib/no-store';
import { nativeRateLimit, rateLimit } from '../lib/rate-limit';
import { durableRateLimit } from '../lib/guard';

/**
 * T19: authenticated API responses must say `Cache-Control: no-store` on the
 * wire, or a proxy/CDN in front of the app may serve one account's data —
 * or a cached token-bearing response — to the next visitor.
 */

test('the helper stamps no-store while preserving status, body and cookies', async () => {
  const response = noStoreJson({ ok: true }, {
    status: 201,
    headers: { 'set-cookie': 'ike_session=abc; Path=/; HttpOnly' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('set-cookie') ?? '', /ike_session=abc/);
  assert.deepEqual(await response.json(), { ok: true });
});

test('an explicit caller-supplied cache-control still wins', () => {
  const response = noStoreJson({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('withNoStore stamps an already-built response without changing it otherwise', async () => {
  const stamped = withNoStore(new Response('stream', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  }));
  assert.equal(stamped.status, 200);
  assert.equal(stamped.headers.get('cache-control'), 'no-store');
  assert.equal(stamped.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(await stamped.text(), 'stream');
});

test('every limiter refusal is uncacheable at the source', async () => {
  // In-memory quota refusal.
  for (let attempt = 0; attempt < 3; attempt += 1) rateLimit('no-store:mem', 1, 60_000);
  const mem = rateLimit('no-store:mem', 1, 60_000);
  assert.equal(mem?.headers.get('cache-control'), 'no-store');

  // Durable fault refusal (fail-closed 503) — no database needed for this path.
  const broken = { prepare() { throw new Error('storage down'); } } as unknown as D1Database;
  const fault = await durableRateLimit(broken, 'no-store:db', 5, 15 * 60_000);
  assert.equal(fault?.status, 503);
  assert.equal(fault?.headers.get('cache-control'), 'no-store');

  // Native edge refusal.
  const edge = await nativeRateLimit({ limit: async () => ({ success: false }) }, 'no-store:edge');
  assert.equal(edge?.status, 429);
  assert.equal(edge?.headers.get('cache-control'), 'no-store');
});

test('the guard denial path is uncacheable', async () => {
  const { requireSession } = await import('../lib/guard');
  const { response } = await requireSession(new Request('https://app.test/api/state'));
  assert.ok(response, 'an unsigned request must still be refused');
  assert.equal(response?.headers.get('cache-control'), 'no-store');
});

test('every private API route answers through the no-store helper', async () => {
  // The one deliberate exception: the Turnstile sitekey route is public by
  // design (unauthenticated, no account data), so plain Response.json stays.
  const root = path.dirname(fileURLToPath(import.meta.url));
  const routeFiles: string[] = [];
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(full);
      else if (entry.name === 'route.ts') routeFiles.push(full);
    }
  }
  await collect(path.join(root, '..', 'app', 'api'));
  assert.ok(routeFiles.length > 10, 'expected to find the API routes');
  for (const file of routeFiles) {
    const source = await readFile(file, 'utf8');
    const relative = path.relative(path.join(root, '..'), file);
    if (relative === path.join('app', 'api', 'turnstile', 'route.ts')) continue;
    assert.doesNotMatch(
      source,
      /Response\.json\(/,
      `${relative} must answer via noStoreJson (or an already no-store stream), not bare Response.json`,
    );
  }
});

test('the documented failure policy names its constant', () => {
  assert.deepEqual({ ...NO_STORE_HEADERS }, { 'cache-control': 'no-store' });
});
