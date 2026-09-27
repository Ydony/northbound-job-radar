#!/usr/bin/env node
/**
 * Prove the self-hosted stack serves the app from an empty database (#196).
 *
 * The other two SQLite verifiers compare databases. This one compares dashboards: it boots the
 * real standalone bundle on a brand-new SQLite file and drives it over HTTP, because the thing
 * that can break in the move off Workers is not the schema - `verify:sqlite-import` already
 * proves that - it is everything the runtime swap touches. `node:sqlite` is synchronous where D1
 * is not, `bindings()` resolves its database differently, `installRuntimeEnv` is called from a
 * Node server rather than a Worker handler, and none of those is exercised by a unit test.
 *
 * **Empty on purpose.** The owner's decision on 2026-09-27: data only matters in production, and
 * starting with nothing is better everywhere else, because search has to actually run to fill it.
 * So this asserts that an empty workspace reads as *empty* rather than as broken - the same
 * distinction #141 was about - and that a search against unconfigured providers completes and
 * says so, instead of failing.
 *
 * What it does NOT do: contact a provider. No API keys are read, set or needed. Every source
 * reports itself unavailable, which is the point - the plumbing runs end to end while nothing
 * leaves the machine.
 *
 * Run with: `npm run verify:selfhosted` (build first; it serves `dist/standalone`).
 * Exits non-zero on the first failed expectation, and always stops the server it started.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { parseVerifierPayload } from './verify-dev-workflow.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const bundle = join(root, 'dist', 'standalone', 'server.js');
// A port of its own. The dev and test environments own 3000 and 3001, and this harness must not
// be able to pass by talking to a server someone else started - which is how a stale build gets
// mistaken for a current one.
const PORT = Number(process.env.VERIFY_SELFHOSTED_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(bundle)) {
  console.error(`No standalone bundle at ${bundle}. Run \`npm run build\` first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'selfhosted-'));
const databasePath = join(work, 'app.sqlite');

let failures = 0;
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` - ${detail}`}`);
  return false;
}

/** One cookie jar, so the installer account stays signed in across calls. */
function client() {
  let cookie = '';
  return async function request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Origin', BASE);
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(`${BASE}${path}`, { ...options, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    const body = await response.text();
    return { status: response.status, data: parseVerifierPayload(response.headers.get('content-type'), body) };
  };
}

const server = spawn(process.execPath, [bundle], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    SQLITE_PATH: databasePath,
    // Throwaway, generated here: this database exists for the length of this run.
    SESSION_SECRET: randomBytes(48).toString('base64'),
    // Left unset deliberately: DB (so the SQLite path is taken), every provider credential (so
    // sources report unavailable), and RESEND_API_KEY (so registration hands the token back).
    DB: undefined,
  },
});

const log = [];
server.stdout.on('data', (chunk) => log.push(String(chunk)));
server.stderr.on('data', (chunk) => log.push(String(chunk)));

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited with ${server.exitCode}:\n${log.join('')}`);
    try {
      const response = await fetch(`${BASE}/login`);
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server never answered on ${BASE}:\n${log.join('')}`);
}

try {
  console.log(`Serving ${bundle}`);
  console.log(`Database ${databasePath} (empty)`);
  await waitForServer();

  const request = client();

  console.log('1/6 The empty database bootstraps its administrator');
  const email = `selfhosted-${Date.now()}@local.test`;
  const registered = await request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email, password: `Local-${randomBytes(18).toString('base64url')}!` }),
  });
  check(registered.status === 200, 'first registration succeeds on loopback', `status ${registered.status}: ${JSON.stringify(registered.data)}`);
  // Verified on creation, because it was created on this computer with remote first-signup
  // blocked - so there is no address to prove and no emailer to prove it with.
  check(registered.data?.role === 'admin', 'the installer account is the administrator', `role ${registered.data?.role}`);

  console.log('2/6 An empty workspace reads as empty, not as broken');
  const state = await request('/api/state');
  check(state.status === 200, 'the signed-in workspace loads', `status ${state.status}`);
  check(state.data?.account?.email === email, 'it belongs to the account that just registered');
  check(state.data?.totalJobs === 0, 'it reports no jobs', `totalJobs ${state.data?.totalJobs}`);
  check(Array.isArray(state.data?.jobs) && state.data.jobs.length === 0, 'the job list is empty rather than absent');
  // #141's rule, from the API side: an account that has never searched must say so, and must not
  // present an absent search history as a failed one.
  check(Array.isArray(state.data?.searchRuns) && state.data.searchRuns.length === 0, 'no search history yet');

  console.log('3/6 Criteria persist through the SQLite adapter');
  const saved = await request('/api/criteria', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roleKeywords: ['Data Analyst', 'Supply Chain'],
      location: '',
      workplace: 'any',
      seniority: 'mid',
      contractType: 'permanent',
      requiredKeywords: [],
      excludedKeywords: [],
    }),
  });
  check(saved.status === 200, 'criteria save', `status ${saved.status}`);
  const reread = await request('/api/state');
  check(reread.data?.criteria?.roleKeywords?.length === 2, 'and come back on the next load', JSON.stringify(reread.data?.criteria?.roleKeywords));

  console.log('4/6 A search with no providers configured completes and says so');
  const search = await request('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'authorized' }),
  });
  check(search.status === 200, 'the search run completes', `status ${search.status}`);
  const sources = search.data?.run?.sources;
  check(Array.isArray(sources) && sources.length > 0, 'it reports per-source outcomes', `sources ${JSON.stringify(sources)?.slice(0, 200)}`);
  // The honest-failure rule (#191, #192): a source that was never configured must not be
  // reported as refusing, unreachable, or as having changed anything about this machine.
  const dishonest = (sources ?? []).filter((source) => /IP has changed|blocked us|refused/i.test(source.message ?? ''));
  check(dishonest.length === 0, 'no source claims a refusal it never made', JSON.stringify(dishonest).slice(0, 300));

  console.log('5/6 Deletion is still impossible');
  const deleted = await fetch(`${BASE}/api/jobs`, { method: 'DELETE', headers: { Origin: BASE } });
  check(deleted.status === 405, 'DELETE /api/jobs is refused by the route itself', `status ${deleted.status}`);

  console.log('6/6 The file on disk is a fully migrated database');
  const database = new DatabaseSync(databasePath);
  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
  const users = database.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
  database.close();
  check(versions.length > 0, 'migrations were applied to the empty file', `versions ${versions.length}`);
  check(users === 1, 'exactly the one bootstrapped account exists', `users ${users}`);
  check(integrity === 'ok', 'integrity_check passes', String(integrity));
  console.log(`  schema version ${versions.at(-1)}, ${versions.length} migrations`);

  const serverErrors = log.join('').split('\n').filter((line) => /error|unhandled|ECONNRESET/i.test(line)
    // Build filenames are not errors. `error-boundary-*.js` is a real chunk name.
    && !/error-boundary|ExperimentalWarning/.test(line));
  check(serverErrors.length === 0, 'the server logged no errors', serverErrors.slice(0, 3).join(' | '));
} catch (error) {
  failures += 1;
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  server.kill();
  // Give the process a moment to release the SQLite file before removing the directory; on
  // Windows a held file makes rmSync throw EBUSY, which would mask the real result.
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    console.log(`(left ${work} in place; the server still held it)`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed. The self-hosted stack is not ready.`);
  process.exit(1);
}
console.log('\nPASS the self-hosted stack serves the app from an empty SQLite database.');
