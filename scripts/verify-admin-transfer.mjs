#!/usr/bin/env node
/** T05: rehearse identity-only transfer on throwaway, fully migrated SQLite files. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../lib/auth.ts';
import { transferAdminIdentity } from './admin-identity-transfer.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'admin-transfer-rehearsal-'));
const temporaryRoot = resolve(tmpdir()) + sep;
if (!resolve(work).startsWith(temporaryRoot)) throw new Error('Unsafe temporary cleanup path.');
const sourcePath = join(work, 'old.sqlite');
const destinationPath = join(work, 'new.sqlite');
let source;
let destination;
try {
  // A separate process exits and closes the adapter's cached handle, leaving
  // real app schema in the file without retaining a lock during cleanup.
  const initialized = spawnSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e',
      "import { ensureSchema } from './db/runtime.ts'; await ensureSchema();"],
    { cwd: projectRoot, env: { ...process.env, SQLITE_PATH: sourcePath }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const checkpoint = new DatabaseSync(sourcePath);
  checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  checkpoint.close();
  copyFileSync(sourcePath, destinationPath);

  source = new DatabaseSync(sourcePath);
  destination = new DatabaseSync(destinationPath);
  const password = 'synthetic-admin-rehearsal-only';
  const hash = await hashPassword(password);
  source.prepare(`INSERT INTO users
    (id, email, password_hash, role, status, email_verified_at, created_at, last_seen_at, session_epoch)
    VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?, ?)`).run(
    'synthetic-admin', 'admin@example.test', hash, '2026-01-02', '2026-01-01', '2026-09-30', 3);
  source.prepare(`INSERT INTO jobs
    (id, source_url, title, description, language_status, language_summary, created_at, updated_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'synthetic-job', 'https://example.test/job', 'Example', 'Synthetic only',
    'pass', 'English', '2026-01-01', '2026-01-01', 'synthetic-admin');
  source.prepare(`INSERT INTO email_verifications (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)`).run('synthetic-token-hash', 'synthetic-admin', '2026-10-02');

  const versions = (db) => db.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all().map((row) => row.version);
  assert.deepEqual(versions(destination), versions(source));
  assert.deepEqual(transferAdminIdentity(source, destination), { transferred: 1 });
  const user = destination.prepare('SELECT * FROM users').get();
  assert.equal(user?.role, 'admin');
  assert.equal(user?.status, 'active');
  assert.equal(user?.email_verified_at, '2026-01-02');
  assert.equal(user?.session_epoch, 4);
  assert.equal(user?.last_seen_at, '');
  assert.equal(await verifyPassword(password, user?.password_hash), true);
  const count = (db, table) => db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
  assert.equal(count(source, 'jobs'), 1);
  assert.equal(count(destination, 'jobs'), 0);
  assert.equal(count(source, 'email_verifications'), 1);
  assert.equal(count(destination, 'email_verifications'), 0);
  assert.equal(count(destination, 'users'), 1);
  assert.throws(() => transferAdminIdentity(source, destination), /destination.*nonempty/i);

  console.log(JSON.stringify({
    schemaVersion: versions(destination).at(-1), identityRows: count(destination, 'users'),
    copiedJobRows: count(destination, 'jobs'), copiedTokenRows: count(destination, 'email_verifications'),
    oldSessionEpochRevoked: user.session_epoch === 4, existingDestinationRefused: true,
  }));
  console.log('Admin transfer rehearsal PASS');
} finally {
  source?.close();
  destination?.close();
  rmSync(work, { recursive: true, force: true });
}
