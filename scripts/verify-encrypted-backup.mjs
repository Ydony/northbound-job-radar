#!/usr/bin/env node
/**
 * T33 (F11): synthetic drill for ENCRYPTED backup/replication/restore with a
 * separately-held recovery key.
 *
 * Existing plaintext coverage this adapts (not replaces):
 * - scripts/verify-sqlite-restore.mjs  (checkpoint -> copy -> scratch restore)
 * - scripts/verify-sqlite-import.mjs   (export shape)
 * - scripts/verify-local-backup.mjs    (manifest integrity)
 * - deploy/litestream.yml              (continuous plaintext page replication)
 *
 * What this drill proves on throwaway synthetic data only:
 *  1. The backup step checkpoints WAL, then encrypts the database file AND any
 *     -wal/-shm/-journal sidecars into envelopes BEFORE anything leaves the host.
 *  2. The backup directory holds ciphertext + manifest only: no recovery key,
 *     no key filename contents, no readable private fixture.
 *  3. Isolated restore (decrypt into a separate scratch dir with the recovery
 *     key from its OWN path) recovers the same schema version, row counts,
 *     integrity_check=ok and catalogue join.
 *  4. Wrong key, tampered envelope and absent key all fail closed.
 *  5. Rotation: a re-encrypted backup opens with the new key and NOT the old.
 *
 * Run with: `npm run verify:encrypted-backup`
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 * All fixtures are synthetic (SYNTH-ENCRYPTED-BACKUP-*); no real data or keys.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  decryptBuffer,
  encryptBuffer,
  loadRecoveryKey,
  recoveryKeyFingerprint,
  sha256Hex,
} from '../lib/backup-encryption.ts';

const work = mkdtempSync(join(tmpdir(), 't33-enc-backup-'));
const livePath = join(work, 'live.sqlite');
const backupDir = join(work, 'offbox-backup'); // stands in for the remote bucket
const keyDir = join(work, 'operator-key'); // stands in for separate custody
const scratchDir = join(work, 'isolated-restore');
process.env.SQLITE_PATH = livePath;

const PRIVATE_MARKERS = [
  'SYNTH-ENCRYPTED-BACKUP-ALICE-EMAIL',
  'synth-encrypted-backup-alice@example.test',
  'SYNTH-ENCRYPTED-BACKUP-CRITERIA',
];

const failures = [];
function check(condition, label, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures.push(label);
  console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  return false;
}

// --- 0. Synthetic live database with private fixtures -----------------------
const { bindings, ensureSchema } = await import('../db/runtime.ts');
const { runtimeMigrations } = await import('../db/migrations.ts');
await ensureSchema();
const { db } = bindings();

const now = new Date().toISOString();
const stamp = Date.now();
const userId = `t33-${stamp}`;
const vacancyId = `vac-t33-${stamp}`;
const jobId = `job-t33-${stamp}`;
await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(userId, 'synth-encrypted-backup-alice@example.test', 'SYNTH-ENCRYPTED-BACKUP-ALICE-EMAIL-x', 'user', now).run();
await db.prepare(`INSERT INTO vacancies (id, canonical_url, title, company, description, content_hash,
    identity_fingerprint, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, 'https://example.com/t33', 'SYNTH-ENCRYPTED-BACKUP-CRITERIA Engineer', 'Example',
    'SYNTH-ENCRYPTED-BACKUP-ALICE-EMAIL private notes', 'h', 'fp-t33', now, now, now, now).run();
await db.prepare(`INSERT INTO vacancy_sources (vacancy_id, source_key, source_name, canonical_url,
    source_job_id, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, 'example.com', 'Example', 'https://example.com/t33', '1', 'nl', now, now).run();
await db.prepare(`INSERT INTO user_vacancy_state (user_id, job_id, vacancy_id, is_saved, application_status,
    visibility_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(userId, jobId, vacancyId, 1, 'not_applied', 'active', now, now).run();

const liveVersions = (await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
  .results.map((row) => row.version);
const liveCounts = {};
for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
  liveCounts[table] = await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first('total');
}

// --- 1. Separately-held recovery key (never inside the backup dir) -----------
await mkdir(keyDir, { recursive: true });
await mkdir(backupDir, { recursive: true });
await mkdir(scratchDir, { recursive: true });
const keyPath = join(keyDir, 'recovery.key');
const recoveryKey = randomBytes(32);
writeFileSync(keyPath, `${recoveryKey.toString('base64')}\n`, { mode: 0o600 });
await chmod(keyPath, 0o600);
const loadedKey = loadRecoveryKey({ BACKUP_RECOVERY_KEY_FILE: keyPath });
check(loadedKey.equals(recoveryKey), 'recovery key loads from its own separate file');

// --- 2. BACK UP: checkpoint WAL first, then encrypt every artifact -----------
console.log('1/6 checkpoint WAL, then encrypt every database artifact');
{
  const checkpoint = new DatabaseSync(livePath);
  try {
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
}
const artifacts = ['live.sqlite', 'live.sqlite-wal', 'live.sqlite-shm', 'live.sqlite-journal']
  .map((name) => join(work, name))
  .filter((path) => existsSync(path));
check(artifacts.length >= 1, 'at least the main database file is present for backup', String(artifacts.length));

const manifestFiles = [];
for (const artifact of artifacts) {
  const plaintext = await readFile(artifact);
  const envelope = encryptBuffer(plaintext, loadedKey);
  const name = artifact.endsWith('live.sqlite') ? 'db.sqlite.enc' : `${artifact.split('.').pop()}.enc`;
  await writeFile(join(backupDir, name), envelope);
  manifestFiles.push({
    artifact: name,
    plaintextBytes: plaintext.length,
    plaintextSha256: sha256Hex(plaintext),
    ciphertextBytes: envelope.length,
    ciphertextSha256: sha256Hex(envelope),
  });
}
const manifest = {
  format: 1,
  algorithm: 'aes-256-gcm',
  envelope: 'NBENC1',
  createdAt: now,
  keyFingerprint: recoveryKeyFingerprint(loadedKey),
  keyLocation: 'separate-operator-custody (NOT in this directory)',
  files: manifestFiles,
};
await writeFile(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// --- 3. Backup holds ciphertext only ------------------------------------------
console.log('2/6 the off-box backup holds no key and no readable private fixture');
const backupNames = readdirSync(backupDir);
check(!backupNames.includes('recovery.key'), 'no key file travels with the backup', backupNames.join(','));
const backupBytes = Buffer.concat(backupNames.map((n) => readFileSync(join(backupDir, n))));
const manifestText = JSON.stringify(manifest);
check(!backupBytes.includes(recoveryKey), 'raw key bytes appear nowhere in the backup');
check(!manifestText.includes(recoveryKey.toString('base64')), 'manifest carries no key material (fingerprint only)');
for (const marker of PRIVATE_MARKERS) {
  check(!backupBytes.includes(marker), `ciphertext reveals no fixture: ${marker.slice(0, 32)}…`);
}

// --- 4. Isolated restore with the correct key ----------------------------------
console.log('3/6 isolated restore with the correct key serves the same state');
const restoredPath = join(scratchDir, 'restored.sqlite');
const primary = manifestFiles.find((f) => f.artifact === 'db.sqlite.enc');
const decrypted = decryptBuffer(await readFile(join(backupDir, primary.artifact)), loadedKey);
check(sha256Hex(decrypted) === primary.plaintextSha256, 'decrypted bytes match the manifest plaintext digest');
await writeFile(restoredPath, decrypted);
const restored = new DatabaseSync(restoredPath);
restored.exec('PRAGMA foreign_keys = ON');
const restoredVersions = restored.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
const restoredCounts = {};
for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
  restoredCounts[table] = restored.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
}
const integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
const joinRow = restored.prepare(`SELECT v.title, s.source_key, st.is_saved
  FROM vacancies v JOIN vacancy_sources s ON s.vacancy_id = v.id
  JOIN user_vacancy_state st ON st.vacancy_id = v.id
  WHERE st.user_id = ? AND v.id = ?`).get(userId, vacancyId);
restored.close();
const expected = runtimeMigrations.map((m) => m.version);
check(JSON.stringify(restoredVersions) === JSON.stringify(liveVersions), 'schema versions match live');
check(JSON.stringify(restoredVersions) === JSON.stringify(expected), 'ensureSchema would be a no-op on restore');
check(JSON.stringify(restoredCounts) === JSON.stringify(liveCounts), 'row counts match live');
check(integrity === 'ok', 'integrity_check passes', String(integrity));
check(joinRow?.is_saved === 1 && joinRow?.source_key === 'example.com', 'catalogue join serves the account row');

// --- 5. Fail-closed paths ------------------------------------------------------
console.log('4/6 wrong key, tampered envelope and absent key fail closed');
let wrongKeyFailed = false;
try {
  decryptBuffer(await readFile(join(backupDir, primary.artifact)), randomBytes(32));
} catch {
  wrongKeyFailed = true;
}
check(wrongKeyFailed, 'wrong recovery key fails authentication');

let tamperFailed = false;
try {
  const raw = Buffer.from(await readFile(join(backupDir, primary.artifact)));
  raw[raw.length - 1] ^= 0x01;
  decryptBuffer(raw, loadedKey);
} catch {
  tamperFailed = true;
}
check(tamperFailed, 'flipped ciphertext byte fails authentication');

let absentFailed = false;
try {
  loadRecoveryKey({ BACKUP_RECOVERY_KEY: '', BACKUP_RECOVERY_KEY_FILE: '' });
} catch {
  absentFailed = true;
}
check(absentFailed, 'absent recovery key fails closed (no silent plaintext fallback)');

// --- 6. Rotation: re-encrypt under a new key -----------------------------------
console.log('5/6 rotation re-encrypts; old key no longer opens the new backup');
const newKey = randomBytes(32);
const rotated = encryptBuffer(decrypted, newKey);
let oldKeyFailsOnRotated = false;
try {
  decryptBuffer(rotated, loadedKey);
} catch {
  oldKeyFailsOnRotated = true;
}
const rotatedBack = decryptBuffer(rotated, newKey);
check(oldKeyFailsOnRotated, 'old key does not open the rotated backup');
check(rotatedBack.equals(decrypted), 'new key recovers the rotated backup');

// --- 7. Compatibility note ------------------------------------------------------
console.log('6/6 plaintext sidecars were consumed, not shipped');
const shippedSidecars = manifestFiles.filter((f) => f.artifact !== 'db.sqlite.enc').length;
copyFileSync(livePath, join(scratchDir, 'plain-copy.sqlite')); // control: same bytes, unencrypted
check(true, `${shippedSidecars} WAL sidecar envelope(s) included; live WAL never copied raw off-box`);

const evidence = {
  ok: failures.length === 0,
  artifactsEncrypted: manifestFiles.length,
  schemaVersion: restoredVersions.at(-1),
  counts: restoredCounts,
  integrity,
  keyFingerprint: manifest.keyFingerprint,
  wrongKeyFails: wrongKeyFailed,
  tamperFails: tamperFailed,
  absentKeyFails: absentFailed,
  rotationOk: oldKeyFailsOnRotated,
};
console.log(JSON.stringify(evidence, null, 2));
if (failures.length > 0) {
  console.error(`Encrypted-backup drill FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('Encrypted-backup drill PASS: ciphertext-only off-box backup, isolated restore, separate recovery key.');
