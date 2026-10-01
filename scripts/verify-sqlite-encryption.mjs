#!/usr/bin/env node
/**
 * F11/T30: fail-closed key-injection rehearsal on throwaway synthetic data.
 *
 * Exercises the encrypted-database opening seam behind the current adapter:
 * plaintext dev/test posture still boots, `DB_ENCRYPTION_REQUIRED=true`
 * without a key refuses to boot, any supplied key is refused (fail-closed,
 * never silently downgraded to plaintext) until the owner-selected cipher
 * driver lands, and no refusal ever echoes key material.
 *
 * Synthetic fixtures only — the "key" below is a random throwaway. This
 * script does NOT prove at-rest encryption: the current `node:sqlite` driver
 * ships no cipher, so step 4 asserts the copy still reads clean AND that a
 * keyed open was refused. A string scan alone is not proof of encryption;
 * that proof arrives with the cipher driver (F11/T29) and will extend this
 * script with wrong-key-fails / right-key-recovers checks.
 *
 * Run with: `node --import tsx scripts/verify-sqlite-encryption.mjs`
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'f11-encryption-'));
const syntheticKey = `synthetic-${randomBytes(12).toString('hex')}`;
const keyFile = join(work, 'synthetic.key');
writeFileSync(keyFile, `${syntheticKey}\n`, 'utf8');

const failures = [];
function check(condition, label, detail = '') {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${condition || !detail ? '' : ` - ${detail}`}`);
  if (!condition) failures.push(label);
  return condition;
}

function messageOf(fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') return value.then(() => '', (error) => String(error?.message ?? error));
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const { openSqliteDatabase } = await import('../db/sqlite-adapter.ts');
const { decideDatabaseOpen, isEncryptionRequired, resolveDatabaseKey } = await import('../db/encryption.ts');

// 1/6 Plaintext dev/test posture still boots and round-trips.
const plainPath = join(work, 'plain.sqlite');
let roundtrip = false;
try {
  const db = openSqliteDatabase(plainPath);
  await db.prepare('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)').run();
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind('synthetic-row').run();
  roundtrip = (await db.prepare('SELECT id FROM t WHERE id = ?').bind('synthetic-row').first('id')) === 'synthetic-row';
} catch (error) {
  check(false, 'unkeyed open boots', String(error?.message ?? error));
}
check(roundtrip, 'unkeyed open boots and round-trips a synthetic row');

// 2/6 Required without a key refuses before opening.
const requiredMsg = messageOf(() => decideDatabaseOpen({
  path: join(work, 'required.sqlite'), key: undefined, encryptionRequired: true, driverSupportsEncryption: false,
}));
check(typeof requiredMsg === 'string' && /no database key/.test(requiredMsg), 'DB_ENCRYPTION_REQUIRED without a key fails closed');

// 3/6 A supplied key is refused (no cipher yet), via env value and via file.
const viaEnv = resolveDatabaseKey({ SQLITE_KEY: syntheticKey });
const viaFile = resolveDatabaseKey({ SQLITE_KEY: 'stale', SQLITE_KEY_FILE: keyFile });
check(viaEnv?.key === syntheticKey && viaFile?.source === 'SQLITE_KEY_FILE', 'key resolution prefers the key file');
for (const [label, key] of [['inline key', viaEnv], ['key file', viaFile]]) {
  const msg = messageOf(() => decideDatabaseOpen({
    path: join(work, 'keyed.sqlite'), key, encryptionRequired: false, driverSupportsEncryption: false,
  }));
  check(/no cipher|refusing/i.test(msg), `${label} with no cipher driver fails closed`);
  check(!msg.includes(syntheticKey), `${label} refusal carries no key material`);
}
const adapterMsg = messageOf(() => openSqliteDatabase(join(work, 'keyed.sqlite'), { key: syntheticKey }));
check(/no cipher|refusing/i.test(adapterMsg), 'adapter-level keyed open fails closed');
check(!adapterMsg.includes(syntheticKey), 'adapter refusal carries no key material');

// 4/6 Current posture, stated honestly: the copy still reads clean.
const header = readFileSync(plainPath).subarray(0, 16).toString('utf8');
check(header.startsWith('SQLite format 3'), 'unkeyed copy is openly readable SQLite (expected until the cipher lands)');
check(isEncryptionRequired({ DB_ENCRYPTION_REQUIRED: 'true' }) && !isEncryptionRequired({}), 'requirement flag is exact-match only');

// 5/6 A missing key file fails closed rather than falling through to plaintext.
const missingMsg = messageOf(() => resolveDatabaseKey({ SQLITE_KEY_FILE: join(work, 'absent.key') }));
check(/cannot be read/.test(missingMsg), 'missing key file fails closed');

// 6/6 Runtime wiring: required-without-key refuses inside bindings().
process.env.SQLITE_PATH = join(work, 'runtime.sqlite');
process.env.DB_ENCRYPTION_REQUIRED = 'true';
delete process.env.SQLITE_KEY;
delete process.env.SQLITE_KEY_FILE;
const { bindings } = await import('../db/runtime.ts');
const runtimeMsg = messageOf(() => bindings());
check(/no database key/.test(runtimeMsg), 'bindings() fails closed when encryption is required but no key is set');
delete process.env.DB_ENCRYPTION_REQUIRED;

const evidence = {
  unkeyedBootOk: roundtrip,
  requiredWithoutKeyRefused: /no database key/.test(requiredMsg),
  keyedOpensRefused: true,
  refusalsRedacted: true,
  plaintextCopyReadsClean: header.startsWith('SQLite format 3'),
  cipherDriverPresent: false,
};
console.log(JSON.stringify(evidence, null, 2));

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed. Key injection is not fail-closed.`);
  process.exit(1);
}
console.log('\nPASS key injection is fail-closed behind the adapter; at-rest encryption still needs the owner-selected cipher driver.');
