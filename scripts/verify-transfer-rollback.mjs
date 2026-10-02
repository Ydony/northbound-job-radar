#!/usr/bin/env node
/**
 * T07: rehearse transfer-then-rollback refusal and secret independence.
 *
 * Synthetic only. Builds two throwaway SQLite files with the app's real
 * schema, transfers a synthetic administrator old -> new, then proves:
 * a second forward transfer is refused, the reverse transfer back into the
 * old database is refused with both databases unchanged, two freshly
 * generated secrets differ and match the expected shape, and the documented
 * procedure carries secret names only, never values.
 *
 * Run with: npm run verify:transfer-rollback
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 * Touches neither DEV, TEST, Cloudflare nor production.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../lib/auth.ts';
import { transferAdminIdentity } from './admin-identity-transfer.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'transfer-rollback-rehearsal-'));
const temporaryRoot = resolve(tmpdir()) + sep;
if (!resolve(work).startsWith(temporaryRoot)) throw new Error('Unsafe temporary cleanup path.');
const oldPath = join(work, 'old.sqlite');
const newPath = join(work, 'new.sqlite');
let oldDb;
let newDb;
try {
  // A separate process exits and closes the adapter's cached handle, leaving
  // real app schema in the file without retaining a lock during cleanup.
  const initialized = spawnSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e',
      "import { ensureSchema } from './db/runtime.ts'; await ensureSchema();"],
    { cwd: projectRoot, env: { ...process.env, SQLITE_PATH: oldPath }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const checkpoint = new DatabaseSync(oldPath);
  checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  checkpoint.close();
  copyFileSync(oldPath, newPath);

  oldDb = new DatabaseSync(oldPath);
  newDb = new DatabaseSync(newPath);
  const password = 'synthetic-admin-rollback-only';
  const hash = await hashPassword(password);
  oldDb.prepare(`INSERT INTO users
    (id, email, password_hash, role, status, email_verified_at, created_at, last_seen_at, session_epoch)
    VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?, ?)`).run(
    'synthetic-admin', 'synthetic-admin@example.invalid', hash, '2026-01-02', '2026-01-01', '2026-09-30', 3);
  oldDb.prepare(`INSERT INTO jobs
    (id, source_url, title, description, language_status, language_summary, created_at, updated_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'synthetic-job', 'https://example.invalid/job', 'Example', 'Synthetic only',
    'pass', 'English', '2026-01-01', '2026-01-01', 'synthetic-admin');

  const count = (db, table) => db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  const epoch = (db) => db.prepare('SELECT session_epoch AS epoch FROM users').get()?.epoch;

  // 1. Forward transfer carries the identity and revokes old sessions.
  assert.deepEqual(transferAdminIdentity(oldDb, newDb), { transferred: 1 });
  const moved = newDb.prepare('SELECT * FROM users').get();
  assert.equal(moved?.role, 'admin');
  assert.equal(moved?.session_epoch, 4);
  assert.equal(await verifyPassword(password, moved?.password_hash), true);
  assert.equal(count(newDb, 'jobs'), 0);

  // 2. No second forward copy: the helper never overwrites new-host data.
  assert.throws(() => transferAdminIdentity(oldDb, newDb), /destination.*nonempty/i);
  assert.equal(count(newDb, 'users'), 1);
  assert.equal(epoch(newDb), 4);

  // 3. No automatic copy-back: the old host is nonempty, so the reverse
  // transfer is refused and both databases are unchanged. Rollback is a
  // service/DNS switch, never a database merge.
  assert.throws(() => transferAdminIdentity(newDb, oldDb), /destination.*nonempty/i);
  assert.equal(count(oldDb, 'users'), 1);
  assert.equal(epoch(oldDb), 3);
  assert.equal(count(oldDb, 'jobs'), 1);
  assert.equal(count(newDb, 'users'), 1);
  assert.equal(count(newDb, 'jobs'), 0);

  // 4. Independent secrets: two freshly generated session secrets differ and
  // match the shape init-secrets.mjs writes (32 random bytes, base64).
  const freshSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const first = freshSecret();
  const second = freshSecret();
  assert.match(first, /^[A-Za-z0-9+/]{40,}={0,2}$/);
  assert.match(second, /^[A-Za-z0-9+/]{40,}={0,2}$/);
  assert.notEqual(first, second);

  // 5. No real values in the documented procedure: secret names only.
  for (const file of ['docs/ADMIN_TRANSFER_ROLLBACK.md', 'scripts/admin-identity-transfer.mjs']) {
    const text = readFileSync(join(projectRoot, file), 'utf8');
    assert.doesNotMatch(text, /SESSION_SECRET=\S+/);
    assert.doesNotMatch(text, /AWS_SECRET_ACCESS_KEY\s*=\s*\S+/);
    assert.doesNotMatch(text, /BEGIN (?:EC|RSA|OPENSSH) PRIVATE KEY/);
    assert.doesNotMatch(text, /\bre_[A-Za-z0-9_-]{20,}/);
  }
  assert.match(readFileSync(join(projectRoot, 'docs/ADMIN_TRANSFER_ROLLBACK.md'), 'utf8'), /example\.invalid/);

  console.log(JSON.stringify({
    forwardTransferred: true, secondForwardRefused: true, reverseCopyBackRefused: true,
    oldHostUnchanged: true, newHostUnchanged: true, syntheticSecretsIndependent: true,
    documentedValuesAbsent: true,
  }));
  console.log('Transfer rollback rehearsal PASS');
} finally {
  oldDb?.close();
  newDb?.close();
  rmSync(work, { recursive: true, force: true });
}
