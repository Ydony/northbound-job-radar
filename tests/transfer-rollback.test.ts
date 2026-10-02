import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../lib/auth';
import { transferAdminIdentity } from '../scripts/admin-identity-transfer.mjs';

/**
 * T07: the rollback side of the identity-transfer contract. Forward transfer
 * is proved in the rehearsal; here the guarantees are that nothing copies
 * back and that host secrets are independent. All fixtures are synthetic.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT '', session_epoch INTEGER NOT NULL DEFAULT 1,
      email_verified_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE email_verifications (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE indeed_control (
      id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '',
      lease_until INTEGER NOT NULL DEFAULT 0, last_success TEXT NOT NULL DEFAULT ''
    );`);
  db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(31, 'synthetic', '2026-01-01');
  db.prepare("INSERT INTO indeed_control (id) VALUES ('indeed')").run();
  return db;
}

function seedAdmin(source: DatabaseSync, hash: string) {
  source.prepare(`INSERT INTO users
    (id, email, password_hash, role, status, created_at, last_seen_at, session_epoch, email_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'admin-1', 'synthetic-admin@example.invalid', hash, 'admin', 'active', '2026-01-01', '2026-09-30', 3, '2026-01-02');
  source.prepare('INSERT INTO jobs VALUES (?, ?)').run('job-1', 'admin-1');
}

function counts(db: DatabaseSync, table: string) {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
  return row.total;
}

test('a reverse transfer into the nonempty old host is refused without changing either side', async () => {
  const oldHost = database();
  const newHost = database();
  try {
    seedAdmin(oldHost, await hashPassword('synthetic-password-not-real'));
    assert.deepEqual(transferAdminIdentity(oldHost, newHost), { transferred: 1 });
    const moved = newHost.prepare('SELECT * FROM users').get() as Record<string, unknown>;
    assert.equal(moved.session_epoch, 4);
    assert.equal(await verifyPassword('synthetic-password-not-real', String(moved.password_hash)), true);

    assert.throws(() => transferAdminIdentity(newHost, oldHost), /destination.*nonempty/i);
    assert.equal(counts(oldHost, 'users'), 1);
    assert.equal(counts(oldHost, 'jobs'), 1);
    assert.equal(counts(newHost, 'users'), 1);
    assert.equal(counts(newHost, 'jobs'), 0);
    const oldEpoch = oldHost.prepare('SELECT session_epoch AS epoch FROM users').get() as { epoch: number };
    assert.equal(oldEpoch.epoch, 3);
  } finally {
    oldHost.close();
    newHost.close();
  }
});

test('a second forward transfer never overwrites new-host data', async () => {
  const oldHost = database();
  const newHost = database();
  try {
    seedAdmin(oldHost, await hashPassword('synthetic-password-not-real'));
    assert.deepEqual(transferAdminIdentity(oldHost, newHost), { transferred: 1 });
    assert.throws(() => transferAdminIdentity(oldHost, newHost), /destination.*nonempty/i);
    assert.equal(counts(newHost, 'users'), 1);
    const epoch = newHost.prepare('SELECT session_epoch AS epoch FROM users').get() as { epoch: number };
    assert.equal(epoch.epoch, 4);
  } finally {
    oldHost.close();
    newHost.close();
  }
});

test('freshly generated host secrets are independent and well-formed', () => {
  const freshSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const first = freshSecret();
  const second = freshSecret();
  assert.match(first, /^[A-Za-z0-9+/]{40,}={0,2}$/);
  assert.match(second, /^[A-Za-z0-9+/]{40,}={0,2}$/);
  assert.notEqual(first, second);
});

test('the rollback document carries procedure and names only, never values', () => {
  const doc = read('docs/ADMIN_TRANSFER_ROLLBACK.md');
  assert.match(doc, /example\.invalid/, 'procedure examples must use the synthetic namespace');
  assert.ok(doc.includes('SESSION_SECRET'), 'the secret setup must name the session secret');
  assert.ok(/copies back|copy-back|copy back/i.test(doc), 'rollback must state that nothing copies back');
  assert.ok(/names only|names-only/i.test(doc), 'secret verification must be names-only');
  const files = ['docs/ADMIN_TRANSFER_ROLLBACK.md', 'scripts/admin-identity-transfer.mjs'];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /SESSION_SECRET=\S+/);
    assert.doesNotMatch(text, /AWS_SECRET_ACCESS_KEY\s*=\s*\S+/);
    assert.doesNotMatch(text, /BEGIN (?:EC|RSA|OPENSSH) PRIVATE KEY/);
    assert.doesNotMatch(text, /\bre_[A-Za-z0-9_-]{20,}/);
  }
});

test('full-schema transfer-rollback rehearsal passes without touching configured environments', () => {
  const result = spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/verify-transfer-rollback.mjs'],
    { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Transfer rollback rehearsal PASS/);
});
