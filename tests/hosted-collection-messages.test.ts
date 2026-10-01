import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { CollectionRunBudgets } from '../lib/collection-budgets';
import { isLoopbackRequest } from '../lib/indeed/access';
import { indeedStatus } from '../lib/indeed/collection';

// T15 (F4): collection controls and status messages for hosted mode with the VPN
// workflow shelved there, plus refusal/cooldown/restart behavior — all with
// synthetic fixtures. The scrape route cannot be imported here (it needs the
// worker runtime), so messaging is pinned against the real route source the way
// tests/collection-budgets.test.ts already pins its enforcement, while durable
// restart behavior is exercised against a real D1 table.

const readyConfig = {
  access: { enabled: true, localExecution: true, administrator: true, appIdentityExperimentApproved: true },
  credentials: { apiKey: 'b'.repeat(64), userAgent: 'Synthetic fixture', appInfo: 'synthetic=1' },
};

async function controlDb() {
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

test('the VPN refusal tells a hosted caller the truth instead of an unactionable local step', async () => {
  const source = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');
  // Hosted vs local is decided the same way the Indeed gate decides it: a
  // loopback request URL means the local computer, anything else is hosted.
  assert.match(source, /from '@\/lib\/indeed\/access'/, 'loopback check comes from the tested access module');
  assert.match(source, /isLoopbackRequest\(request\)/, 'the refusal branches on loopback vs hosted');
  // The hosted message must not send a phone user to a local launcher, and must
  // point at the search that keeps working on the host.
  assert.match(source, /local-only and are not searched on hosted installations/, 'hosted refusal states the shelved VPN plainly');
  assert.match(source, /nothing to connect to from here/, 'hosted refusal says why the launcher cannot help');
  assert.match(source, /Find new jobs/, 'hosted refusal names the search that continues on the host');
  // The local message stays actionable where the launcher actually exists.
  assert.match(source, /npm run dev:private/, 'local refusal keeps the working instruction');
  // Still a refusal with its real status code — never a silent narrowing.
  assert.match(source, /requestedAll && !authSecrets\(\)\.vpnEnforced/, 'the VPN gate still guards the mode');
  assert.match(source, /status: 409/, 'the refusal keeps its conflict status');
  assert.match(source, /kind: 'refused'/, 'the refusal still bypasses the progress stream');
});

test('the scrape route gains no hosted execution path or evasion machinery', async () => {
  const source = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /puppeteer|playwright|ProxyAgent|proxy-agent|headless|stealth/i,
    'no evasion mechanisms: no proxy rotation, no browser fallback');
  // Indeed stays behind its own loopback-gated configuration, not generalized.
  assert.match(source, /indeedConfiguration\(request, user\.role === 'admin'\)/,
    'Indeed still goes through its loopback-gated configuration');
});

test('the dashboard states the VPN control is local-only, including on hosted', async () => {
  const source = await readFile(new URL('../app/job-radar.tsx', import.meta.url), 'utf8');
  assert.match(source, /local computer only/, 'admin control title states the local boundary');
  assert.match(source, /Unavailable on hosted\/phone/, 'admin control title says hosted cannot use it');
  assert.match(source, /local-only page-fetching ones \(VPN launcher on this computer, not on hosted\)/,
    'progress message states the local boundary while a run is refused');
});

test('the transparency page states restricted sources are not searched on hosted', async () => {
  const source = await readFile(new URL('../app/sources/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /on hosted installations these sources are not searched/,
    'restricted-sites blurb states the hosted outcome');
});

test('the hosted branch is reachable by exactly the requests a phone produces', () => {
  // The route computes `hosted = !isLoopbackRequest(request)`, so this pins the
  // predicate on the two shapes that matter: the local computer (loopback, where
  // the VPN launcher exists) and the host reached by phone (public host, where
  // the VPN workflow is shelved). A live non-loopback request.url cannot be
  // produced from a loopback socket — the standalone server derives it from the
  // listener, and the guard refuses a spoofed Host as cross-origin — so the
  // hosted message itself is pinned against the route source above.
  assert.equal(isLoopbackRequest(new Request('http://localhost:3000/api/scrape')), true);
  assert.equal(isLoopbackRequest(new Request('http://127.0.0.1:3000/api/scrape')), true);
  assert.equal(isLoopbackRequest(new Request('https://ikbeneenappel.nl/api/scrape')), false);
  assert.equal(isLoopbackRequest(new Request('http://192.168.1.10:3000/api/scrape')), false);
});

test('an Indeed refusal survives a restart: paused stays refused across re-reads', async () => {
  const { db, dispose } = await controlDb();
  try {
    await db.prepare("UPDATE indeed_control SET paused = 1 WHERE id = 'indeed'").run();
    assert.equal((await indeedStatus(db, readyConfig)).state, 'refused');
    // A restart re-reads the same row rather than resetting it: the second
    // read is what a fresh process would see.
    assert.equal((await indeedStatus(db, readyConfig)).state, 'refused', 'pause persists across restarts');
    assert.match((await indeedStatus(db, readyConfig)).state, /refused/);
  } finally {
    await dispose();
  }
});

test('an Indeed cooldown and lease survive a restart with their remaining time', async () => {
  const { db, dispose } = await controlDb();
  try {
    await db.prepare("UPDATE indeed_control SET cooldown_until = ? WHERE id = 'indeed'")
      .bind(Date.now() + 120_000).run();
    const first = await indeedStatus(db, readyConfig);
    assert.equal(first.state, 'cooldown');
    assert.ok(first.retryAfterSeconds > 0, 'cooldown carries its remaining wait');
    const second = await indeedStatus(db, readyConfig);
    assert.equal(second.state, 'cooldown', 'cooldown persists across restarts');
    assert.ok(second.retryAfterSeconds > 0 && second.retryAfterSeconds <= first.retryAfterSeconds,
      'the re-read wait never grows past the first');

    await db.prepare("UPDATE indeed_control SET paused = 0, cooldown_until = 0, lease_until = ? WHERE id = 'indeed'")
      .bind(Date.now() + 60_000).run();
    assert.equal((await indeedStatus(db, readyConfig)).state, 'busy');
    assert.equal((await indeedStatus(db, readyConfig)).state, 'busy', 'lease persists across restarts');

    await db.prepare("UPDATE indeed_control SET paused = 0, cooldown_until = 0, lease_until = 0, last_success = '' WHERE id = 'indeed'").run();
    assert.equal((await indeedStatus(db, readyConfig)).state, 'ready', 'a clear control reads ready again');
  } finally {
    await dispose();
  }
});

test('per-run collection budgets are memory-only by design: a fresh run starts unblocked', () => {
  // The durable gates above live in D1 rows; CollectionRunBudgets deliberately
  // does not — it stops one run from hammering a refusing source, and a refusal
  // never carries over into the next run (see lib/collection-budgets.ts).
  const run = new CollectionRunBudgets();
  run.markBlocked('mock-source');
  assert.equal(run.allowance('mock-source', false), 0, 'the refusing run leaves its source alone');
  const nextRun = new CollectionRunBudgets();
  assert.equal(nextRun.isBlocked('mock-source'), false, 'the next run is not bound by the previous refusal');
  assert.equal(nextRun.allowance('mock-source', false), 4, 'the next run retries normally');
});

test('the scheduled refresh persists its cooldowns and pauses across restarts', async () => {
  const source = await readFile(new URL('../lib/public-refresh.ts', import.meta.url), 'utf8');
  assert.match(source, /persisted in D1 so a worker restart neither multiplies requests nor forgets/,
    'refresh durability contract is stated');
  assert.match(source, /cooldown_until/, 'cooldowns are durable columns, not memory');
  assert.match(source, /paused = \?/, 'pauses are written back to the durable row');
});
