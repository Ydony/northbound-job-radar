#!/usr/bin/env node
/**
 * T29 (F11) synthetic verification: field-encryption + backup compatibility.
 *
 * Proves, on throwaway synthetic fixtures only (no real secrets, keys, or
 * production data), that:
 *  1. sealed private values store through the UNCHANGED `node:sqlite` D1
 *     adapter (`db/sqlite-adapter.ts`) — ciphertext is just TEXT;
 *  2. the database file AND its WAL/SHM/journal artifacts contain no
 *     readable fixture (a main-file-only scan is not proof);
 *  3. wrong/missing keys, wrong row binding, and tampering fail closed while
 *     the correct key recovers;
 *  4. rotation re-wraps to a new key and revokes the old one;
 *  5. the checkpoint-then-copy backup shape from `verify-sqlite-restore`
 *     restores in isolation, bundles no key, passes `integrity_check`, and
 *     still recovers with the separately held key.
 *
 * Prints REDACTED JSON evidence only: counts, booleans, envelope lengths.
 * Never prints keys, plaintext fixtures, or ciphertext. Exits non-zero on
 * any mismatch.
 *
 * Run with: `node --import tsx scripts/verify-f11-encryption.mjs`
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const work = mkdtempSync(join(tmpdir(), 'f11-verify-'));
const livePath = join(work, 'live.sqlite');
const backupPath = join(work, 'backup.sqlite');

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const wrongKey = randomBytes(32);

const { openSqliteDatabase } = await import('../db/sqlite-adapter.ts');
const { decodeDataKey, decryptField, encryptField, rotateField } = await import('../lib/field-crypto.ts');

const db = openSqliteDatabase(livePath);
await db.prepare('CREATE TABLE secrets (id TEXT PRIMARY KEY NOT NULL, sealed TEXT NOT NULL)').run();

const fixtures = [
  'f11-verify-account@example.test',
  'f11-verify-criterion district technician night shifts',
  'f11-verify-service-token synthetic-only',
];
const aad = (id) => `secrets:${id}`;
const sealed = fixtures.map((value, index) => encryptField(value, keyA, aad(`s${index}`)));
for (const [index, envelope] of sealed.entries()) {
  await db.prepare('INSERT INTO secrets (id, sealed) VALUES (?, ?)').bind(`s${index}`, envelope).run();
}

// 1+2: pre-checkpoint scan across the main file and every sidecar artifact.
const sidecars = ['', '-wal', '-shm', '-journal'].map((suffix) => livePath + suffix).filter((p) => existsSync(p));
const liveBytes = Buffer.concat(sidecars.map((p) => readFileSync(p)));
const leakScan = fixtures.map((value) => liveBytes.includes(Buffer.from(value, 'utf8')));
const atRestOpaque = leakScan.every((found) => !found);

// 3: correct key recovers; everything else fails closed.
const rows = (await db.prepare('SELECT id, sealed FROM secrets ORDER BY id').all()).results;
const recoveredOk = rows.every((row, index) => decryptField(row.sealed, keyA, aad(row.id)) === fixtures[index]);
let wrongKeyFails = false;
try { decryptField(rows[0].sealed, wrongKey, aad(rows[0].id)); } catch { wrongKeyFails = true; }
let missingKeyFails = false;
try { decodeDataKey(''); } catch { missingKeyFails = true; }
let tamperFails = false;
try {
  // Flip one character inside the payload segment (an appended base64
  // character can fall in decoder-ignored padding territory, which proves
  // nothing — a mid-payload flip changes authenticated bytes).
  const segments = rows[0].sealed.split(':');
  const mid = Math.floor(segments[2].length / 2);
  const flipped = segments[2].slice(0, mid) + (segments[2][mid] === 'A' ? 'B' : 'A') + segments[2].slice(mid + 1);
  decryptField(`${segments[0]}:${segments[1]}:${flipped}`, keyA, aad(rows[0].id));
} catch { tamperFails = true; }
let bindingFails = false;
try { decryptField(rows[0].sealed, keyA, aad('other-row')); } catch { bindingFails = true; }

// 4: rotation to keyB; old key revoked.
const rewrapped = rotateField(rows[1].sealed, keyA, keyB, aad(rows[1].id));
const rotationOk = decryptField(rewrapped, keyB, aad(rows[1].id)) === fixtures[1];
let oldKeyRevoked = false;
try { decryptField(rewrapped, keyA, aad(rows[1].id)); } catch { oldKeyRevoked = true; }

// 5: checkpoint, copy WITHOUT any key, restore in isolation.
{
  const checkpoint = new DatabaseSync(livePath);
  try { checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { checkpoint.close(); }
}
copyFileSync(livePath, backupPath);
const backupBytes = readFileSync(backupPath);
const keyBundled = backupBytes.includes(keyA)
  || backupBytes.includes(Buffer.from(keyA.toString('base64'), 'utf8'))
  || backupBytes.includes(keyB);
const backupLeaks = fixtures.some((value) => backupBytes.includes(Buffer.from(value, 'utf8')));
const restored = new DatabaseSync(backupPath);
let integrity = '';
let restoreRecoverOk = false;
try {
  integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
  const restoredRows = restored.prepare('SELECT id, sealed FROM secrets ORDER BY id').all();
  restoreRecoverOk = restoredRows.length === 3
    && restoredRows.every((row, index) => decryptField(row.sealed, keyA, aad(row.id)) === fixtures[index]);
} catch {
  integrity = 'FAILED';
} finally {
  restored.close();
}

// Redacted evidence: shapes and verdicts only. No keys, fixtures, envelopes.
const evidence = {
  synthetic: true,
  adapterUnchanged: true,
  rowsSealed: rows.length,
  envelopeVersion: sealed[0].split(':')[0],
  atRestOpaque,
  filesScanned: sidecars.map((p) => (p.endsWith('.sqlite') ? 'main' : p.slice(p.lastIndexOf('-')))),
  recoveredOk,
  wrongKeyFails,
  missingKeyFails,
  tamperFails,
  rowBindingFails: bindingFails,
  rotationOk,
  oldKeyRevoked,
  backupIntegrity: integrity,
  keyBundledWithBackup: keyBundled,
  backupLeaksPlaintext: backupLeaks,
  restoreRecoverOk,
};
console.log(JSON.stringify(evidence, null, 2));

const pass = atRestOpaque && recoveredOk && wrongKeyFails && missingKeyFails && tamperFails
  && bindingFails && rotationOk && oldKeyRevoked && integrity === 'ok' && !keyBundled
  && !backupLeaks && restoreRecoverOk;
if (!pass) {
  console.error('F11 encryption rehearsal FAILED.');
  process.exit(1);
}
console.log('F11 encryption rehearsal PASS: sealed storage, fail-closed keys, rotation, and isolated restore all hold on synthetic fixtures.');
