#!/usr/bin/env node
/**
 * T31 (F11): verify encrypted-database migration, WAL/temp behavior and SQL
 * compatibility on fresh/existing synthetic databases.
 *
 * Synthetic fixtures only. No real secrets, keys, or production data are read,
 * written, or printed — key presence is reported as a boolean, never a value.
 *
 * What this proves TODAY (T30 landed as fail-closed key injection in
 * `db/encryption.ts`, but the owner-selected cipher driver from T29 has not:
 * at-rest encryption is still plaintext): the mechanical baseline every
 * encrypted future must preserve —
 * fresh migration reaches the latest version, an existing database migrates
 * without losing rows, the D1-dialect surface the ~197 call sites rely on
 * behaves identically, and the checkpoint-then-copy backup drill restores
 * intact. It ALSO proves the current gap: raw-byte scans of the copied
 * database, WAL/temp artifacts, and backup copy find the synthetic private
 * markers in the clear, so a copied ordinary SQLite file FAILS F11 acceptance
 * even though the mechanics pass.
 *
 * What this does NOT prove (blocked on the owner-selected cipher driver +
 * owner key-custody review): wrong/missing keys failing, correct keys
 * recovering, encrypted replication/restore, or Litestream compatibility
 * with an encrypted file. Those sections report BLOCKED, not PASS — a string
 * scan alone is not proof of encryption, and neither is its absence here
 * proof of anything beyond "no cipher is wired up".
 *
 * Run with: `node --import tsx scripts/verify-encrypted-db.mjs`
  *   `--require-encryption` exits non-zero when F11 acceptance fails (CI gate
  *   for after the cipher lands). Default mode exits 0 once the verification itself
 *   ran, with `"f11Acceptance": "FAIL"` recorded as data.
 * Prints JSON evidence on stdout; exits non-zero on any mechanical mismatch.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const requireEncryption = process.argv.includes('--require-encryption');

const work = mkdtempSync(join(tmpdir(), 't31-encdb-'));
const freshPath = join(work, 'fresh.sqlite');
const backupDir = join(work, 'backup');
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, 'fresh-backup.sqlite');
const scratchPath = join(work, 'scratch.sqlite');
process.env.SQLITE_PATH = freshPath;

const { bindings, ensureSchema } = await import('../db/runtime.ts');
const { runtimeMigrations } = await import('../db/migrations.ts');
const expectedVersions = runtimeMigrations.map((m) => m.version);
const expectedLatest = Math.max(...expectedVersions);

// ---- Fresh database: migrate an empty file to the latest version. ----
await ensureSchema();
const { db } = bindings();

async function versionsOf(database) {
  const rows = await database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return rows.results.map((r) => r.version);
}
const freshVersions = await versionsOf(db);
const freshMigrationOk = JSON.stringify(freshVersions) === JSON.stringify(expectedVersions);

const requiredTables = ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state',
  'language_feedback', 'search_roles', 'auth_events', 'search_runs', 'dismissed_jobs'];
const tablesOk = {};
for (const table of requiredTables) {
  const found = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(table).first();
  tablesOk[table] = found?.name === table;
}

// ---- Existing database: seed synthetic private fixtures, re-run schema. ----
// Markers are distinctive ASCII so a raw-byte scan finds them iff the file is plaintext.
const stamp = Date.now();
const M = {
  email: `synth-t31-${stamp}@example.test`,
  hash: `T31-SYNTH-HASH-${stamp}`,
  role: `T31-SYNTH-ROLE-${stamp}`,
  company: `T31-SYNTH-COMPANY-${stamp}`,
  note: `T31-PLAINTEXT-MARKER-${stamp}`,
  ip: `192.0.2.${(stamp % 200) + 1}`, // TEST-NET-1, never a real address.
};
const userId = `t31-user-${stamp}`;
const vacancyId = `t31-vac-${stamp}`;
const jobId = `t31-job-${stamp}`;
const now = new Date().toISOString();

await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(userId, M.email, M.hash, 'user', now).run();
await db.prepare('INSERT INTO search_roles (id, position, role, updated_at, user_id) VALUES (?, ?, ?, ?, ?)')
  .bind(`t31-sr-${stamp}`, 0, M.role, now, userId).run();
await db.prepare(`INSERT INTO vacancies (id, canonical_url, title, company, description, content_hash,
    identity_fingerprint, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, `https://example.com/t31/${stamp}`, `Engineer ${M.note}`, M.company,
    `English-only role ${M.note}`, 'h', `fp-t31-${stamp}`, now, now, now, now).run();
await db.prepare(`INSERT INTO vacancy_sources (vacancy_id, source_key, source_name, canonical_url,
    source_job_id, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, 'example.com', 'Example', `https://example.com/t31/${stamp}`, '1', 'nl', now, now).run();
await db.prepare(`INSERT INTO user_vacancy_state (user_id, job_id, vacancy_id, is_saved, application_status,
    visibility_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(userId, jobId, vacancyId, 1, 'applied', 'active', now, now).run();
await db.prepare('INSERT INTO language_feedback (job_id, verdict, corrected_status, reason, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(jobId, 'incorrect', 'pass', M.note, now, userId).run();
await db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(`t31-ae-${stamp}`, M.email, M.ip, 'sign-in', now).run();

// Re-running the schema against the seeded ("existing") database must be a no-op.
await ensureSchema();
const existingVersions = await versionsOf(db);
const existingNoOp = JSON.stringify(existingVersions) === JSON.stringify(expectedVersions);
const userCount = await db.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?').bind(userId).first('total');
const existingRowsSurvive = userCount === 1;

// ---- SQL compatibility: the D1-dialect surface the call sites rely on. ----
// Each entry runs against the live synthetic DB; failures mean an encryption
// adapter (or any future storage swap) broke the dialect contract.
const sqlCompat = {};
async function check(name, fn) {
  try {
    sqlCompat[name] = (await fn()) ? 'pass' : 'FAIL';
  } catch {
    sqlCompat[name] = 'FAIL';
  }
}
await check('returning-write-returns-rows', async () => {
  await db.prepare('CREATE TABLE t31_seq (bucket TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL DEFAULT 0)').run();
  const one = await db.prepare(`INSERT INTO t31_seq (bucket, n) VALUES (?, 1)
    ON CONFLICT(bucket) DO UPDATE SET n = t31_seq.n + 1 RETURNING n`).bind('b').first();
  const two = await db.prepare(`INSERT INTO t31_seq (bucket, n) VALUES (?, 1)
    ON CONFLICT(bucket) DO UPDATE SET n = t31_seq.n + 1 RETURNING n`).bind('b').first();
  return one?.n === 1 && two?.n === 2;
});
await check('batch-is-atomic', async () => {
  await db.prepare('CREATE TABLE t31_batch (id TEXT PRIMARY KEY NOT NULL)').run();
  await db.prepare("INSERT INTO t31_batch (id) VALUES ('keep')").run();
  let rejected = false;
  try {
    await db.batch([
      db.prepare("INSERT INTO t31_batch (id) VALUES ('new')"),
      db.prepare("INSERT INTO t31_batch (id) VALUES ('keep')"),
    ]);
  } catch { rejected = true; }
  const rows = await db.prepare('SELECT id FROM t31_batch').all();
  return rejected && rows.results.length === 1;
});
await check('undefined-binding-rejected', async () => {
  try {
    await db.prepare("INSERT INTO t31_batch (id) VALUES (?)").bind(undefined).run();
    return false;
  } catch (e) { return e instanceof TypeError; }
});
await check('like-json-datetime', async () => {
  const row = await db.prepare(`SELECT datetime('now') AS ts,
    json_extract(?, '$.a') AS j, (? LIKE ?) AS lk`).bind('{"a":1}', 'jobs.ch/abc', '%jobs.ch%').first();
  return row?.j === 1 && row?.lk === 1 && typeof row?.ts === 'string';
});
await check('foreign-keys-on', async () => {
  const raw = new DatabaseSync(freshPath);
  try {
    return raw.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;
  } finally { raw.close(); }
});
await check('journal-mode-wal', async () => {
  const raw = new DatabaseSync(freshPath);
  try {
    return String(raw.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase() === 'wal';
  } finally { raw.close(); }
});
await check('catalogue-join-per-account', async () => {
  const row = await db.prepare(`SELECT v.title, s.source_key, st.is_saved
    FROM vacancies v
    JOIN vacancy_sources s ON s.vacancy_id = v.id
    JOIN user_vacancy_state st ON st.vacancy_id = v.id
    WHERE st.user_id = ? AND v.id = ?`).bind(userId, vacancyId).first();
  return row?.source_key === 'example.com' && row?.is_saved === 1;
});
await check('integrity-ok', async () => {
  const raw = new DatabaseSync(freshPath);
  try {
    return raw.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  } finally { raw.close(); }
});

// ---- WAL/temp behavior: leave uncheckpointed frames, then inventory artifacts. ----
// PASSIVE checkpoints without truncating, so frames stay in -wal for the scan.
{
  const raw = new DatabaseSync(freshPath);
  try { raw.exec('PRAGMA wal_checkpoint(PASSIVE)'); } finally { raw.close(); }
}
const artifactNames = ['-wal', '-shm', '-journal'];
for (const suffix of artifactNames) {
  if (existsSync(freshPath + suffix) && !existsSync(join(backupDir, basename(freshPath) + suffix))) {
    // Noted, not copied: the backup drill below checkpoints first, which is
    // exactly why a naive `cp` of a WAL database is not a backup.
  }
}
function scanBytes(path) {
  if (!existsSync(path)) return { present: false, hits: [] };
  const bytes = readFileSync(path);
  const hits = Object.entries(M).filter(([, v]) => bytes.includes(v)).map(([k]) => k);
  return { present: true, size: bytes.length, hits };
}
const walTempArtifacts = {
  main: scanBytes(freshPath),
  wal: scanBytes(freshPath + '-wal'),
  shm: scanBytes(freshPath + '-shm'),
  journal: scanBytes(freshPath + '-journal'),
};
let tempStore = '';
{
  const raw = new DatabaseSync(freshPath);
  try { tempStore = String(raw.prepare('PRAGMA temp_store').get().temp_store); } finally { raw.close(); }
}
const leakedArtifacts = Object.entries(walTempArtifacts)
  .filter(([, v]) => v.present && v.hits.length > 0).map(([k]) => k);

// ---- Old snapshot compatibility: the backup drill must also work on the copy. ----
{
  const raw = new DatabaseSync(freshPath);
  try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { raw.close(); }
}
copyFileSync(freshPath, backupPath);
const backupScan = scanBytes(backupPath);
// No decryption key may travel with the backup: the backup dir must hold only the copy.
const backupDirFiles = readdirSync(backupDir);
const keyBundledWithBackup = backupDirFiles.some((f) => /key|secret|\.env/i.test(f));

copyFileSync(backupPath, scratchPath);
const scratch = new DatabaseSync(scratchPath);
scratch.exec('PRAGMA foreign_keys = ON');
const scratchVersions = scratch.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
const scratchCounts = {};
for (const t of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
  scratchCounts[t] = scratch.prepare(`SELECT COUNT(*) AS total FROM ${t}`).get().total;
}
const scratchJoin = scratch.prepare(`SELECT v.title, s.source_key, st.is_saved
  FROM vacancies v
  JOIN vacancy_sources s ON s.vacancy_id = v.id
  JOIN user_vacancy_state st ON st.vacancy_id = v.id
  WHERE st.user_id = ? AND v.id = ?`).get(userId, vacancyId);
let scratchIntegrity = '';
try { scratchIntegrity = scratch.prepare('PRAGMA integrity_check').get().integrity_check; }
catch (e) { scratchIntegrity = `FAILED: ${e instanceof Error ? e.message : String(e)}`; }
scratch.close();

// Same SQL-compat spot checks against the RESTORED copy (existing-DB path).
const restored = new DatabaseSync(scratchPath);
restored.exec('PRAGMA foreign_keys = ON');
const restoredJoinOk = (() => {
  const r = restored.prepare(`SELECT s.source_key, st.is_saved FROM vacancy_sources s
    JOIN user_vacancy_state st ON st.vacancy_id = s.vacancy_id
    WHERE st.user_id = ? AND s.vacancy_id = ?`).get(userId, vacancyId);
  return r?.source_key === 'example.com' && r?.is_saved === 1;
})();
const restoredFeedback = restored.prepare('SELECT reason FROM language_feedback WHERE job_id = ?').get(jobId);
restored.close();

// ---- Encryption-provider gate: presence only, never values. ----
const keyEnvNames = ['SQLITE_KEY', 'ENCRYPTED_DB_KEY', 'DB_ENCRYPTION_KEY', 'SQLCIPHER_KEY'];
const keyEnvPresent = keyEnvNames.filter((n) => typeof process.env[n] === 'string' && process.env[n] !== '');
let packageDeps = '{}';
try {
  const root = new URL('../package.json', import.meta.url);
  packageDeps = JSON.stringify(JSON.parse(readFileSync(root, 'utf8')).dependencies ?? {});
} catch { packageDeps = '{}'; }
const knownCipherPkgs = ['sqlcipher', 'sqlite3mc', 'better-sqlite3-multiple-ciphers', '@journeyapps/wa-sqlite'];
const cipherDepPresent = knownCipherPkgs.some((p) => packageDeps.toLowerCase().includes(p));
const encryptionProvider = keyEnvPresent.length > 0 || cipherDepPresent ? 'configured?' : 'none';
// Independent of env: the adapter has a key-injection point (`options.key`,
// T30) which this driver refuses fail-closed until the cipher lands.
const { openSqliteDatabase } = await import('../db/sqlite-adapter.ts');
const adapterTakesKey = openSqliteDatabase.length !== 1;

const copiedDbRevealsPrivateFixtures =
  walTempArtifacts.main.hits.length > 0 || backupScan.hits.length > 0;
const f11Acceptance = (!copiedDbRevealsPrivateFixtures && encryptionProvider !== 'none') ? 'PASS' : 'FAIL';

const evidence = {
  harness: 'PASS',
  freshMigration: { latest: expectedLatest, ok: freshMigrationOk, tablesOk },
  existingMigration: { versionsNoOp: existingNoOp, rowsSurvive: existingRowsSurvive },
  sqlCompat,
  walTemp: { tempStore, artifacts: walTempArtifacts, leakedArtifacts },
  backup: {
    counts: scratchCounts,
    versionsMatch: JSON.stringify(scratchVersions) === JSON.stringify(expectedVersions),
    integrity: scratchIntegrity,
    liveJoinOk: scratchJoin?.source_key === 'example.com',
    restoredJoinOk,
    restoredFeedbackOk: restoredFeedback?.reason === M.note,
    backupRevealsFixtures: backupScan.hits,
    keyBundledWithBackup,
  },
  copiedDbRevealsPrivateFixtures,
  encryption: {
    provider: encryptionProvider,
    keyEnvVarsPresent: keyEnvPresent.length, // count only, never names+values
    cipherDepPresent,
    adapterTakesKey,
    wrongKeyFails: 'BLOCKED (no cipher; T30 gate refuses keyed opens until the owner-selected driver lands)',
    correctKeyRecovers: 'BLOCKED (no cipher; T30 gate refuses keyed opens until the owner-selected driver lands)',
    encryptedReplicationRestore: 'BLOCKED (Litestream-vs-encrypted unproven; cipher pending)',
  },
  f11Acceptance,
  note: f11Acceptance === 'FAIL'
    ? 'Plaintext baseline: copied DB/WAL/backup reveal synthetic private fixtures. Expected until the owner-selected cipher lands behind the owner key-custody review (T30 fail-closed gate already in place).'
    : 'Encrypted acceptance met.',
};
console.log(JSON.stringify(evidence, null, 2));

const mechanicalOk = freshMigrationOk && existingNoOp && existingRowsSurvive
  && Object.values(sqlCompat).every((v) => v === 'pass')
  && Object.values(tablesOk).every(Boolean)
  && evidence.backup.versionsMatch && scratchIntegrity === 'ok'
  && !keyBundledWithBackup && restoredJoinOk;
if (!mechanicalOk) {
  console.error('Encrypted-DB verification FAILED: a mechanical check broke. See JSON above.');
  process.exit(1);
}
if (requireEncryption && f11Acceptance !== 'PASS') {
  console.error('F11 acceptance FAILED under --require-encryption: plaintext baseline (cipher pending).');
  process.exit(1);
}
console.log('Encrypted-DB verification evidence recorded. '
  + (f11Acceptance === 'FAIL'
    ? 'Mechanics pass; F11 acceptance FAILS on this plaintext baseline (cipher pending).'
    : 'F11 acceptance passes.'));
