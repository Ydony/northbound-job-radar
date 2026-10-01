import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openSqliteDatabase } from '../db/sqlite-adapter';
import {
  databaseEncryptionStatus,
  decideDatabaseOpen,
  isEncryptionRequired,
  resolveDatabaseKey,
} from '../db/encryption';

/**
 * F11/T30: encrypted database opening and key injection, fail-closed, behind
 * the current adapter. Synthetic fixtures only — no real key material anywhere.
 *
 * The current driver (`node:sqlite`) ships no cipher, so every keyed open must
 * be REFUSED, never silently downgraded to plaintext, and `DB_ENCRYPTION_REQUIRED`
 * without a key must refuse to boot. When the owner-selected cipher driver
 * lands, these same tests pin the fail-closed half of the contract; only the
 * "keyed open succeeds and the copy reads opaque" assertions get added.
 */

const dir = mkdtempSync(join(tmpdir(), 'sqlite-encryption-'));
const SYNTHETIC_KEY = `synthetic-test-key-${Date.now()}-not-a-secret`;

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Adapter handles stay open for the process lifetime; temp files are harmless.
  }
});

test('isEncryptionRequired is exact: only the string "true" arms it', () => {
  assert.equal(isEncryptionRequired({}), false);
  assert.equal(isEncryptionRequired({ DB_ENCRYPTION_REQUIRED: 'true' }), true);
  assert.equal(isEncryptionRequired({ DB_ENCRYPTION_REQUIRED: '1' }), false);
  assert.equal(isEncryptionRequired({ DB_ENCRYPTION_REQUIRED: 'TRUE' }), false);
  assert.equal(isEncryptionRequired({ DB_ENCRYPTION_REQUIRED: '' }), false);
});

test('resolveDatabaseKey finds nothing when neither variable is set', () => {
  assert.equal(resolveDatabaseKey({}), undefined);
  assert.equal(resolveDatabaseKey({ SQLITE_KEY: '   ' }), undefined);
  assert.equal(resolveDatabaseKey({ SQLITE_KEY_FILE: '' }), undefined);
});

test('resolveDatabaseKey reads an inline key and names its source', () => {
  const found = resolveDatabaseKey({ SQLITE_KEY: `  ${SYNTHETIC_KEY}  ` });
  assert.equal(found?.source, 'SQLITE_KEY');
  assert.equal(found?.key, SYNTHETIC_KEY);
});

test('resolveDatabaseKey prefers the key file and fails closed on a bad one', () => {
  const keyFile = join(dir, 'synthetic.key');
  writeFileSync(keyFile, `${SYNTHETIC_KEY}\n`, 'utf8');
  const found = resolveDatabaseKey({ SQLITE_KEY: 'stale-inline', SQLITE_KEY_FILE: keyFile });
  assert.equal(found?.source, 'SQLITE_KEY_FILE');
  assert.equal(found?.key, SYNTHETIC_KEY);

  assert.throws(
    () => resolveDatabaseKey({ SQLITE_KEY_FILE: join(dir, 'absent.key') }),
    /cannot be read/,
    'a missing key file must stop the boot, not fall through to plaintext',
  );
  const emptyFile = join(dir, 'empty.key');
  writeFileSync(emptyFile, '  \n', 'utf8');
  assert.throws(
    () => resolveDatabaseKey({ SQLITE_KEY_FILE: emptyFile }),
    /empty/,
    'an empty key file must stop the boot, not fall through to plaintext',
  );
});

test('decideDatabaseOpen refuses required-without-key before any file is opened', () => {
  assert.throws(
    () => decideDatabaseOpen({ path: join(dir, 'x.sqlite'), key: undefined, encryptionRequired: true, driverSupportsEncryption: false }),
    /DB_ENCRYPTION_REQUIRED.*no database key/,
  );
});

test('decideDatabaseOpen refuses a key the driver cannot use, and redacts it', () => {
  for (const driverSupportsEncryption of [false]) {
    let message = '';
    try {
      decideDatabaseOpen({
        path: join(dir, 'x.sqlite'),
        key: { source: 'SQLITE_KEY', key: SYNTHETIC_KEY },
        encryptionRequired: false,
        driverSupportsEncryption,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /no cipher|refusing/i, 'a key with no cipher must fail closed, not open plaintext');
    assert.ok(!message.includes(SYNTHETIC_KEY), 'the refusal must never echo key material');
  }
});

test('decideDatabaseOpen lets the plaintext dev/test posture through unchanged', () => {
  const decided = decideDatabaseOpen({
    path: join(dir, 'plain.sqlite'),
    key: undefined,
    encryptionRequired: false,
    driverSupportsEncryption: false,
  });
  assert.equal(decided.path, join(dir, 'plain.sqlite'));
  assert.equal(decided.key, undefined);
});

test('openSqliteDatabase still opens unkeyed files and refuses keyed ones', async () => {
  const db = openSqliteDatabase(join(dir, 'unkeyed.sqlite')) as unknown as D1Database;
  await db.prepare('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)').run();
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind('synthetic-row').run();
  const row = await db.prepare('SELECT id FROM t WHERE id = ?').bind('synthetic-row').first<{ id: string }>();
  assert.equal(row?.id, 'synthetic-row');

  let message = '';
  try {
    openSqliteDatabase(join(dir, 'keyed.sqlite'), { key: SYNTHETIC_KEY });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /no cipher|refusing/i);
  assert.ok(!message.includes(SYNTHETIC_KEY), 'the refusal must never echo key material');
});

test('databaseEncryptionStatus carries presence and source, never the key', () => {
  const status = databaseEncryptionStatus({
    path: join(dir, 's.sqlite'),
    encryptionRequired: true,
    keyPresent: true,
    keySource: 'SQLITE_KEY_FILE',
    driverSupportsEncryption: false,
  });
  assert.equal(status.encrypted, false);
  assert.equal(status.encryptionRequired, true);
  assert.equal(status.keyPresent, true);
  assert.equal(status.keySource, 'SQLITE_KEY_FILE');
  assert.ok(!JSON.stringify(status).includes(SYNTHETIC_KEY));
});

test('bindings() fails closed through the runtime wiring', async () => {
  const saved = {
    SQLITE_PATH: process.env.SQLITE_PATH,
    SQLITE_KEY: process.env.SQLITE_KEY,
    SQLITE_KEY_FILE: process.env.SQLITE_KEY_FILE,
    DB_ENCRYPTION_REQUIRED: process.env.DB_ENCRYPTION_REQUIRED,
  };
  try {
    const { bindings } = await import('../db/runtime');

    // Required without a key: refuse before opening.
    process.env.SQLITE_PATH = join(dir, 'runtime-required.sqlite');
    process.env.DB_ENCRYPTION_REQUIRED = 'true';
    delete process.env.SQLITE_KEY;
    delete process.env.SQLITE_KEY_FILE;
    assert.throws(() => bindings(), /no database key/);

    // Key supplied but no cipher driver: refuse rather than open plaintext.
    const keyFile = join(dir, 'runtime.key');
    writeFileSync(keyFile, SYNTHETIC_KEY, 'utf8');
    process.env.SQLITE_KEY_FILE = keyFile;
    let message = '';
    try {
      bindings();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /no cipher|refusing/i);
    assert.ok(!message.includes(SYNTHETIC_KEY));

    // Neither required nor keyed: the existing plaintext posture still boots.
    delete process.env.DB_ENCRYPTION_REQUIRED;
    delete process.env.SQLITE_KEY_FILE;
    const { db } = bindings();
    await db.prepare('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY NOT NULL)').run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
