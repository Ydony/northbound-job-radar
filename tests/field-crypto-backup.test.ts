import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteDatabase } from '../db/sqlite-adapter';
import { decodeDataKey, decryptField, encryptField, rotateField } from '../lib/field-crypto';

/**
 * T29 (F11) synthetic compatibility proof: reviewed field encryption
 * (AES-256-GCM via OpenSSL, see `lib/field-crypto.ts`) against the existing
 * `node:sqlite` D1 adapter and the existing file-copy backup shape that
 * stands in for `litestream restore` in `verify-sqlite-restore`.
 *
 * All fixtures are synthetic (`@example.test`, fixed sentinel strings).
 * No real secret, key, or production data is involved; keys are random per
 * run and never written to the backup copy.
 */

const dir = mkdtempSync(join(tmpdir(), 'f11-crypto-'));
const dbPath = join(dir, 'private.sqlite');
const backupPath = join(dir, 'backup.sqlite');

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const wrongKey = randomBytes(32);
const keyAEncoded = keyA.toString('base64');

// Synthetic private fixtures. Distinct sentinel per category so a leak scan
// can attribute any occurrence to the exact value that leaked.
const FIXTURES = {
  accountEmail: 'f11-synthetic-account@example.test',
  privateCriterion: 'f11-synthetic-criterion senior suport de birou Bucuresti',
  serviceToken: 'f11-synthetic-service-token-9f2c',
  feedbackNote: 'f11-synthetic-feedback verdict correction note',
};

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Adapter-cached handles can block deletion on Windows; temp dir only.
  }
});

function rawBytes(...paths: string[]): Buffer {
  const parts = paths.filter((path) => existsSync(path)).map((path) => readFileSync(path));
  return Buffer.concat(parts);
}

function assertNoPlaintextLeak(context: string) {
  const bytes = rawBytes(dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`);
  for (const [name, value] of Object.entries(FIXTURES)) {
    assert.equal(
      bytes.includes(Buffer.from(value, 'utf8')),
      false,
      `${context}: synthetic ${name} is readable in the database files`,
    );
  }
}

test('sealed values store through the unchanged D1 adapter and stay opaque on disk', async () => {
  const db = openSqliteDatabase(dbPath) as unknown as D1Database;
  await db.prepare('CREATE TABLE private_notes (id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, sealed TEXT NOT NULL)').run();
  const aad = (id: string) => `private_notes:${id}`;
  for (const [index, value] of Object.values(FIXTURES).entries()) {
    const id = `note-${index}`;
    await db.prepare('INSERT INTO private_notes (id, owner, sealed) VALUES (?, ?, ?)')
      .bind(id, 'synthetic-user', encryptField(value, keyA, aad(id))).run();
  }
  // WAL holds the fresh writes before any checkpoint: scan it too, not just
  // the main file. A scan of the main file alone is not proof of encryption.
  assertNoPlaintextLeak('pre-checkpoint');

  // Correct key recovers every fixture through the same adapter read path.
  const rows = await db.prepare('SELECT id, sealed FROM private_notes ORDER BY id').all<{ id: string; sealed: string }>();
  assert.equal(rows.results.length, 4);
  const recovered = rows.results.map((row) => decryptField(row.sealed, keyA, aad(row.id)));
  assert.deepEqual(recovered, Object.values(FIXTURES));
});

test('wrong key, missing key, wrong row binding, and tampering all fail closed', async () => {
  const db = openSqliteDatabase(dbPath) as unknown as D1Database;
  const row = await db.prepare("SELECT id, sealed FROM private_notes WHERE id = 'note-0'").first<{ id: string; sealed: string }>();
  assert.ok(row);
  const aad = `private_notes:${row.id}`;
  assert.throws(() => decryptField(row.sealed, wrongKey, aad));
  assert.throws(() => decodeDataKey(undefined));
  assert.throws(() => decodeDataKey(''));
  assert.throws(() => decodeDataKey('too-short'));
  assert.throws(() => decryptField(row.sealed, keyA, 'private_notes:another-row'));
  const tampered = row.sealed.slice(0, -4) + (row.sealed.endsWith('A') ? 'BBB' : 'AAA');
  assert.throws(() => decryptField(tampered, keyA, aad));
});

test('rotation re-wraps to the new key; the old key stops working', async () => {
  const db = openSqliteDatabase(dbPath) as unknown as D1Database;
  const row = await db.prepare("SELECT id, sealed FROM private_notes WHERE id = 'note-1'").first<{ id: string; sealed: string }>();
  assert.ok(row);
  const aad = `private_notes:${row.id}`;
  const rewrapped = rotateField(row.sealed, keyA, keyB, aad);
  assert.equal(decryptField(rewrapped, keyB, aad), FIXTURES.privateCriterion);
  assert.throws(() => decryptField(rewrapped, keyA, aad));
  assert.throws(() => rotateField(row.sealed, wrongKey, keyB, aad));
});

test('checkpointed backup copy restores without the key and still recovers with it', async () => {
  // Same checkpoint-then-copy shape as `verify-sqlite-restore`: WAL mode
  // keeps fresh writes outside the main file, so a copy without this step
  // is the truncated-restore failure that drill exists to catch.
  const checkpoint = new DatabaseSync(dbPath);
  try {
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
  copyFileSync(dbPath, backupPath);
  assert.equal(existsSync(backupPath), true);

  // No decryption key travels with the backup: neither the key nor its
  // base64 form may occur in the backup artifact.
  const backupBytes = readFileSync(backupPath);
  assert.equal(backupBytes.includes(keyA), false, 'raw key bytes bundled with backup');
  assert.equal(
    backupBytes.includes(Buffer.from(keyAEncoded, 'utf8')),
    false,
    'encoded key bundled with backup',
  );

  // Isolated restore behind a fresh handle (never the adapter cache): the
  // copy opens clean, holds the same sealed rows, and still hides plaintext.
  const restored = new DatabaseSync(backupPath);
  try {
    restored.exec('PRAGMA foreign_keys = ON');
    const integrity = restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, 'ok');
    const rows = restored.prepare('SELECT id, sealed FROM private_notes ORDER BY id').all() as { id: string; sealed: string }[];
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(decryptField(row.sealed, keyA, `private_notes:${row.id}`) !== '', true);
    }
    assert.equal(decryptField(rows[0].sealed, keyA, 'private_notes:note-0'), FIXTURES.accountEmail);
    assert.throws(() => decryptField(rows[0].sealed, wrongKey, 'private_notes:note-0'));
    for (const value of Object.values(FIXTURES)) {
      assert.equal(backupBytes.includes(Buffer.from(value, 'utf8')), false, `backup leaks ${value.slice(0, 24)}...`);
    }
  } finally {
    restored.close();
  }
});
