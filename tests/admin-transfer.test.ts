import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../lib/auth';
import { transferAdminIdentity } from '../scripts/admin-identity-transfer.mjs';

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
    CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE auth_events (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE indeed_control (
      id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '',
      lease_until INTEGER NOT NULL DEFAULT 0, last_success TEXT NOT NULL DEFAULT ''
    );`);
  db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(31, 'synthetic', '2026-01-01');
  db.prepare("INSERT INTO indeed_control (id) VALUES ('indeed')").run();
  return db;
}

test('transfers only verified administrator identity and revokes old sessions', async () => {
  const source = database();
  const destination = database();
  try {
    const hash = await hashPassword('synthetic-password-not-real');
    source.prepare(`INSERT INTO users
      (id, email, password_hash, role, status, created_at, last_seen_at, session_epoch, email_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'admin-1', 'admin@example.test', hash, 'admin', 'active', '2026-01-01', '2026-09-30', 7, '2026-01-02');
    source.prepare('INSERT INTO jobs VALUES (?, ?)').run('job-1', 'admin-1');
    source.prepare('INSERT INTO email_verifications VALUES (?, ?)').run('token-1', 'admin-1');
    source.prepare('INSERT INTO password_resets VALUES (?, ?)').run('token-2', 'admin-1');
    source.prepare('INSERT INTO auth_events VALUES (?, ?)').run('event-1', 'admin@example.test');

    assert.deepEqual(transferAdminIdentity(source, destination), { transferred: 1 });
    const user = destination.prepare('SELECT * FROM users').get() as Record<string, unknown>;
    assert.deepEqual({ ...user, password_hash: '[redacted]' }, {
      id: 'admin-1', email: 'admin@example.test', password_hash: '[redacted]',
      role: 'admin', status: 'active', created_at: '2026-01-01', last_seen_at: '',
      session_epoch: 8, email_verified_at: '2026-01-02',
    });
    assert.equal(await verifyPassword('synthetic-password-not-real', String(user.password_hash)), true);
    for (const table of ['jobs', 'email_verifications', 'password_resets', 'auth_events']) {
      assert.equal((destination.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
    }
  } finally {
    source.close();
    destination.close();
  }
});

test('refuses a destination with any workspace row without changing it', async () => {
  const source = database();
  const destination = database();
  try {
    source.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, email_verified_at)
      VALUES ('admin-1', 'admin@example.test', 'hash', 'admin', 'active', '2026-01-01', '2026-01-02')`).run();
    destination.prepare("INSERT INTO jobs VALUES ('existing-job', 'other-user')").run();
    assert.throws(() => transferAdminIdentity(source, destination), /destination.*nonempty/i);
    assert.equal((destination.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
    assert.equal((destination.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 1);
  } finally {
    source.close();
    destination.close();
  }
});

test('refuses operational state changed from the migration seed', () => {
  const source = database();
  const destination = database();
  try {
    source.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, email_verified_at)
      VALUES ('admin-1', 'admin@example.test', 'hash', 'admin', 'active', '2026-01-01', '2026-01-02')`).run();
    destination.prepare('UPDATE indeed_control SET paused = 1').run();
    assert.throws(() => transferAdminIdentity(source, destination), /destination.*nonempty/i);
    assert.equal((destination.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  } finally {
    source.close();
    destination.close();
  }
});

test('refuses different source and destination schema versions', () => {
  const source = database();
  const destination = database();
  try {
    source.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, email_verified_at)
      VALUES ('admin-1', 'admin@example.test', 'hash', 'admin', 'active', '2026-01-01', '2026-01-02')`).run();
    destination.prepare('DELETE FROM schema_migrations WHERE version = 31').run();
    assert.throws(() => transferAdminIdentity(source, destination), /schema.*mismatch/i);
    assert.equal((destination.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  } finally {
    source.close();
    destination.close();
  }
});

test('refuses a source with a second account', () => {
  const source = database();
  const destination = database();
  try {
    source.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, email_verified_at)
      VALUES ('admin-1', 'admin@example.test', 'hash', 'admin', 'active', '2026-01-01', '2026-01-02')`).run();
    source.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, email_verified_at)
      VALUES ('user-2', 'user@example.test', 'hash', 'user', 'active', '2026-01-01', '2026-01-02')`).run();
    assert.throws(() => transferAdminIdentity(source, destination), /exactly one.*admin/i);
    assert.equal((destination.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  } finally {
    source.close();
    destination.close();
  }
});

test('refuses an unverified administrator', () => {
  const source = database();
  const destination = database();
  try {
    source.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at)
      VALUES ('admin-1', 'admin@example.test', 'hash', 'admin', 'active', '2026-01-01')`).run();
    assert.throws(() => transferAdminIdentity(source, destination), /verified/i);
    assert.equal((destination.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  } finally {
    source.close();
    destination.close();
  }
});

test('full-schema synthetic rehearsal passes without touching configured environments', () => {
  const result = spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/verify-admin-transfer.mjs'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Admin transfer rehearsal PASS/);
});
