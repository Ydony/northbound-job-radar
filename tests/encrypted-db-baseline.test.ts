import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * T31 (F11) — encrypted-database baseline: private-data inventory and the
 * plaintext tripwire.
 *
 * F11's first acceptance item is an explicit storage/encryption/key-access
 * mapping for every private data category. This test pins that mapping
 * against the real schema (a fresh synthetic database built through the
 * adapter, repo-local work dir so it never touches /tmp), separating the
 * public catalogue (`vacancies`, `vacancy_sources` — employer's advert
 * text, no owner by design per migration 30) from each account's private
 * relationship to it.
 *
 * TRIPWIRE: the second test asserts storage is currently PLAINTEXT at rest
 * (node:sqlite, no cipher, no encryption dependency). T30 partial (#231)
 * landed fail-closed key injection (`db/encryption.ts`, `SQLITE_KEY` handling
 * in `db/runtime.ts`, keyed opens refused) — so key handling is EXPECTED, but
 * a cipher is still absent and the byte-scan in
 * `scripts/verify-encrypted-db-baseline.mjs` still finds readable private
 * fixtures. The full T30 must REPLACE this with: wrong/missing keys fail,
 * correct keys recover, and the byte-scan finds nothing. If this test still
 * passes after the cipher lands, the cipher trial forgot to update it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, 'scripts', 'output', `t31-test-${Date.now()}-${process.pid}`);

// Category → tables/columns holding it. Public job content is distinct from
// a user's private relationship to a job (migration 30 split).
const PRIVATE_MAP: Record<string, { table: string; columns: string[] }> = {
  accountIdentity: { table: 'users', columns: ['email', 'password_hash'] },
  privateCriteria: { table: 'search_roles', columns: ['role'] },
  savedAppliedJobs: { table: 'user_vacancy_state', columns: ['is_saved', 'application_status', 'visibility_status'] },
  languageCorrections: { table: 'language_feedback', columns: ['corrected_status', 'reason'] },
  correctionCopies: { table: 'user_vacancy_state', columns: ['corrected_status', 'corrected_reason'] },
  recoverySecrets: { table: 'password_resets', columns: ['token_hash'] },
  verificationSecrets: { table: 'email_verifications', columns: ['token_hash'] },
  authLog: { table: 'auth_events', columns: ['email', 'ip'] },
  dismissedTombstones: { table: 'dismissed_jobs', columns: ['canonical_url', 'identity_fingerprint'] },
  rejectionMemory: { table: 'rejected_listings', columns: ['canonical_url'] },
};
const PUBLIC_CATALOGUE = ['vacancies', 'vacancy_sources'];

test.after(() => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch { /* work dir is Git-ignored; leaving it is harmless */ }
});

test('every inventoried private table and column exists in a fresh database', async () => {
  mkdirSync(work, { recursive: true });
  process.env.SQLITE_TMPDIR = work;
  process.env.SQLITE_PATH = join(work, 'inventory.sqlite');
  const { ensureSchema, bindings } = await import('../db/runtime');
  await ensureSchema();
  const { db } = bindings();
  for (const [category, { table, columns }] of Object.entries(PRIVATE_MAP)) {
    const found = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ name: string }>();
    assert.equal(found?.name, table, `${category}: missing table ${table}`);
    for (const column of columns) {
      const hit = await db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).all();
      assert.ok(hit.success, `${category}: missing column ${table}.${column}`);
    }
  }
  for (const table of PUBLIC_CATALOGUE) {
    const found = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ name: string }>();
    assert.equal(found?.name, table, `missing public catalogue table ${table}`);
  }
  // The public catalogue carries no owner by design; private state is keyed by one.
  const raw = new DatabaseSync(join(work, 'inventory.sqlite'));
  try {
    const sql = (name: string) =>
      (raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql;
    for (const table of PUBLIC_CATALOGUE) assert.doesNotMatch(sql(table), /user_id/, `${table} must stay owner-free`);
    assert.match(sql('user_vacancy_state'), /user_id/, 'private state must stay owner-keyed');
  } finally {
    raw.close();
  }
});

test('TRIPWIRE: private storage is currently plaintext at rest (cipher still absent)', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  assert.deepEqual(
    deps.filter((d) => /sqlcipher|sqlite.*crypt|crypt.*sqlite|@journeyapps|wa-sqlite|sodium|age-encryption/i.test(d)),
    [], 'no maintained database-encryption solution is wired in yet');
  const adapter = readFileSync(join(root, 'db', 'sqlite-adapter.ts'), 'utf8');
  const runtime = readFileSync(join(root, 'db', 'runtime.ts'), 'utf8');
  assert.doesNotMatch(adapter + runtime, /PRAGMA\s+(key|cipher|kdf)/i, 'no key/cipher wiring in the DB layer yet');
  // T30 partial (#231): fail-closed key injection exists and must stay wired —
  // a key the driver cannot use is refused, never silently downgraded.
  assert.match(adapter + runtime, /SQLITE_KEY/, 'fail-closed key injection (T30 partial) must stay wired');
  const encryption = readFileSync(join(root, 'db', 'encryption.ts'), 'utf8');
  assert.match(encryption, /no cipher|driverSupportsEncryption/i, 'fail-closed posture must stay documented');
  assert.match(adapter, /DRIVER_SUPPORTS_ENCRYPTION\s*=\s*false/, 'node:sqlite driver still offers no cipher');
});
