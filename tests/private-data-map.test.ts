import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashEmailToken, newEmailToken } from '../lib/email';
import { dataWeHold } from '../lib/privacy-policy';

/**
 * T28 (F11 baseline): the private-data map must track the code, not memory.
 *
 * `docs/PRIVATE_DATA_MAP.md` names every private category with its storage,
 * encryption state, key access and retention. These tests fail when the
 * schema, the secret accessors, or the map drift apart — so a new table, a
 * new secret, or a quiet map edit forces the other side to move in the same
 * commit. All fixtures are synthetic; no test touches a real database.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const map = read('docs/PRIVATE_DATA_MAP.md');
const migrationSql = read('db/migrations.ts');
const runtimeSource = read('db/runtime.ts');
const schemaSql = `${migrationSql}\n${runtimeSource}`;

function tablesInCode(): Set<string> {
  const names = new Set<string>();
  for (const match of schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) names.add(match[1]);
  for (const match of schemaSql.matchAll(/CREATE TABLE (?!IF\b)(\w+)\s*\(/gi)) names.add(match[1]);
  return names;
}

// Every persistent table the schema can create, including the historical CV
// base (kept so old databases upgrade) and the migration bookkeeping table.
const KNOWN_TABLES = [
  'users', 'jobs', 'search_settings', 'search_roles', 'language_feedback', 'dismissed_jobs',
  'search_runs', 'search_run_sources', 'auth_events', 'rate_limits', 'password_resets',
  'email_verifications', 'daily_visits', 'visit_markers', 'rejected_listings', 'indeed_control',
  'indeed_settings', 'indeed_coverage', 'vacancies', 'vacancy_sources', 'user_vacancy_state',
  'public_refresh_state', 'public_refresh_queue', 'cvs', 'schema_migrations',
];

test('the map names every table the schema can create', () => {
  const code = tablesInCode();
  for (const table of KNOWN_TABLES) {
    assert.ok(code.has(table), `${table} is expected in the schema but was not found in db/ sources`);
    assert.ok(map.includes(table), `schema table ${table} is missing from docs/PRIVATE_DATA_MAP.md`);
  }
});

test('no schema table escapes the map', () => {
  const code = tablesInCode();
  for (const table of code) {
    if (table.endsWith('_rebuilt')) continue; // migration 7 scaffolding, renamed away
    assert.ok(map.includes(table), `table ${table} exists in db/ sources but is not mapped`);
  }
});

test('every secret accessor in db/runtime.ts has a lifecycle row in the map', () => {
  for (const secret of ['SESSION_SECRET', 'APP_PASSWORD_HASH', 'RESEND_API_KEY', 'TURNSTILE_SECRET_KEY',
    'INDEED_API_KEY', 'ADZUNA_APP_KEY', 'CAREERJET_API_KEY', 'SQLITE_PATH', 'LITESTREAM_REPLICA_URL']) {
    assert.ok(runtimeSource.includes(secret) || read('db/env.d.ts').includes(secret)
      || read('deploy/litestream.yml').includes(secret),
    `${secret} is not declared in db/ sources or deploy config`);
    assert.ok(map.includes(secret), `secret ${secret} has no lifecycle row in docs/PRIVATE_DATA_MAP.md`);
  }
});

test('missing session secret fails closed before any database access', () => {
  // Closed by default, asserted on shape (repo precedent: tenant-route
  // bindings assert the same way): the secret check answers 503 before
  // bindings(), the origin check, or any user lookup, so a half-configured
  // deployment cannot expose anybody's rows. The live 503 round trip runs in
  // scripts/verify-private-data-map.mjs instead.
  const guard = read('lib/guard.ts');
  const secretCheck = guard.indexOf('if (!sessionSecret)');
  assert.ok(secretCheck >= 0, 'the fail-closed secret check is gone from lib/guard.ts');
  assert.match(guard.slice(secretCheck, secretCheck + 200), /503/);
  for (const later of ['isSameOrigin(request', 'readSessionValue(', 'bindings()', 'findUserById(']) {
    assert.ok(guard.indexOf(later, secretCheck) > secretCheck, `${later} runs before the secret check`);
  }
});

test('stored email tokens cannot be replayed from the hash', async () => {
  const token = newEmailToken();
  const hash = await hashEmailToken(token);
  assert.equal(hash.length, 64);
  assert.ok(!hash.includes(token.slice(0, 8)), 'token material leaks into its stored hash');
  assert.equal(await hashEmailToken(token), hash);
});

test('the map states the current plaintext baseline honestly', () => {
  assert.match(map, /plaintext today/i, 'the map must admit what is unencrypted, not imply protection');
  assert.match(map, /string scan/i, 'the map must frame the string scan as baseline, not proof');
});

test('the map and /privacy agree on what is held', () => {
  const held = dataWeHold.map((item) => `${item.what} ${item.why} ${item.kept}`).join('\n');
  assert.match(held, /password/i);
  assert.match(held, /advertisement/i);
  assert.match(held, /30 days/);
  // Matched case-insensitively, and on a stable stem rather than an exact phrase: the privacy
  // copy capitalises "Sign-in records" and the map row reads "Sign-in abuse records", so a
  // case-sensitive `includes` of the literal missed both while each did disclose it.
  for (const marker of [/sign-in/i, /search settings/i, /catalogue/i]) {
    assert.ok(marker.test(map) || marker.test(held),
      `${marker} is disclosed in neither the map nor /privacy copy`);
  }
});

test('the map carries synthetic fixtures only, no usable credentials', () => {
  assert.match(map, /example\.invalid/, 'synthetic examples must use the example.invalid namespace');
  assert.match(map, /synthetic-/i, 'synthetic examples must be marked synthetic');
  assert.doesNotMatch(map, /BEGIN (?:EC|RSA|OPENSSH) PRIVATE KEY/);
  assert.doesNotMatch(map, /\bre_[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(map, /SESSION_SECRET=\S+/);
  assert.doesNotMatch(map, /AWS_SECRET_ACCESS_KEY\s*=\s*\S+/);
});
