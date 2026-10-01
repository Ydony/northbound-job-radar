import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { currentPasswordIterations, hashPassword, NODE_PBKDF2_ITERATIONS, parsePasswordHash,
  passwordHashNeedsRehash, verifyPassword, WORKERS_PBKDF2_CAP } from '../lib/auth';
import { authenticate } from '../lib/users';

/**
 * T34: versioned password-hashing policy with legacy-login rehash. All passwords and
 * accounts are synthetic fixtures created inside the test; no real credential appears.
 */

const PASSWORD = 'synthetic legacy-login password 0123456789';

function withoutEnvOverride() {
  const saved = process.env.PASSWORD_HASH_ITERATIONS;
  delete process.env.PASSWORD_HASH_ITERATIONS;
  return () => {
    if (saved === undefined) delete process.env.PASSWORD_HASH_ITERATIONS;
    else process.env.PASSWORD_HASH_ITERATIONS = saved;
  };
}

test('the reviewed policy targets 600k iterations on Node and keeps the 100k Workers cap', () => {
  const restore = withoutEnvOverride();
  try {
    assert.equal(NODE_PBKDF2_ITERATIONS, 600_000);
    assert.equal(WORKERS_PBKDF2_CAP, 100_000);
    assert.equal(currentPasswordIterations(), NODE_PBKDF2_ITERATIONS);
  } finally {
    restore();
  }
});

test('an explicit PASSWORD_HASH_ITERATIONS override tunes the target; garbage is ignored', () => {
  const saved = process.env.PASSWORD_HASH_ITERATIONS;
  try {
    process.env.PASSWORD_HASH_ITERATIONS = '100000';
    assert.equal(currentPasswordIterations(), 100_000);
    process.env.PASSWORD_HASH_ITERATIONS = 'not-a-number';
    assert.equal(currentPasswordIterations(), NODE_PBKDF2_ITERATIONS);
  } finally {
    if (saved === undefined) delete process.env.PASSWORD_HASH_ITERATIONS;
    else process.env.PASSWORD_HASH_ITERATIONS = saved;
  }
});

test('verification is versioned: legacy iteration counts verify, malformed hashes do not', async () => {
  const legacy100k = await hashPassword(PASSWORD, 100_000);
  const legacy210k = await hashPassword(PASSWORD, 210_000);
  assert.ok(await verifyPassword(PASSWORD, legacy100k), 'hosted 100k hashes must keep verifying');
  assert.ok(await verifyPassword(PASSWORD, legacy210k), 'pre-2026-09-24 210k local hashes must verify on Node');
  assert.equal(await verifyPassword('wrong synthetic password', legacy100k), false);

  const parsed = parsePasswordHash(legacy100k);
  assert.equal(parsed?.iterations, 100_000, 'the iteration count is the stored version');

  assert.equal(await verifyPassword(PASSWORD, 'not-a-hash'), false);
  assert.equal(await verifyPassword(PASSWORD, 'pbkdf2$1$AAAA$AAAA'), false, 'must reject a low iteration count');
  assert.equal(await verifyPassword(PASSWORD, 'pbkdf2$100000$AAAA$AAAA'), false, 'must reject a truncated salt/hash');
  assert.equal(await verifyPassword(PASSWORD, 'pbkdf2$5000000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
    false, 'must reject an iteration count above the verification ceiling');
  assert.equal(await verifyPassword(PASSWORD, 'argon2$19$m=65536$salt$hash'), false, 'unknown algorithms are not silently accepted');
});

test('only weaker-than-current hashes need a rehash; stronger ones are never downgraded', () => {
  const restore = withoutEnvOverride();
  try {
    const legacy = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const current = `pbkdf2$${NODE_PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
    const stronger = 'pbkdf2$1200000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    assert.equal(passwordHashNeedsRehash(legacy), true);
    assert.equal(passwordHashNeedsRehash(current), false);
    assert.equal(passwordHashNeedsRehash(stronger), false, 'must never downgrade a stronger hash');
    assert.equal(passwordHashNeedsRehash('not-a-hash'), false, 'malformed input cannot be upgraded');
  } finally {
    restore();
  }
});

async function loginDb() {
  const restore = withoutEnvOverride();
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  await db.prepare(`CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
    email_verified_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT '', session_epoch INTEGER NOT NULL DEFAULT 1
  )`).run();
  return { db, dispose: async () => { await runtime.dispose(); restore(); } };
}

async function seedUser(db: D1Database, id: string, email: string, hash: string, status = 'active') {
  await db.prepare(`INSERT INTO users (id, email, password_hash, role, status, email_verified_at, created_at, last_seen_at)
    VALUES (?, ?, ?, 'user', ?, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`)
    .bind(id, email, hash, status).run();
}

async function storedHash(db: D1Database, id: string) {
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(id)
    .first<{ password_hash: string }>();
  return row?.password_hash ?? '';
}

test('a successful legacy login upgrades the stored hash without changing the password', async () => {
  const { db, dispose } = await loginDb();
  try {
    await seedUser(db, 'u1', 'legacy@example.test', await hashPassword(PASSWORD, 100_000));
    const user = await authenticate(db, 'legacy@example.test', PASSWORD);
    assert.ok(user, 'the legacy password must still sign in');
    assert.equal(user?.id, 'u1');

    const upgraded = await storedHash(db, 'u1');
    assert.equal(parsePasswordHash(upgraded)?.iterations, currentPasswordIterations(),
      'the stored hash must move to the current policy');
    assert.ok(await verifyPassword(PASSWORD, upgraded), 'the same password verifies against the upgraded hash');
    assert.equal(await verifyPassword('wrong synthetic password', upgraded), false);

    // A second login with the already-current hash leaves storage untouched.
    const before = upgraded;
    assert.ok(await authenticate(db, 'legacy@example.test', PASSWORD));
    assert.equal(await storedHash(db, 'u1'), before, 'a current hash must not be rewritten');
  } finally {
    await dispose();
  }
});

test('a wrong password, a disabled account, or a missing account never rewrites the hash', async () => {
  const { db, dispose } = await loginDb();
  try {
    const legacy = await hashPassword(PASSWORD, 100_000);
    await seedUser(db, 'u1', 'legacy@example.test', legacy);
    await seedUser(db, 'u2', 'disabled@example.test', legacy, 'disabled');

    assert.equal(await authenticate(db, 'legacy@example.test', 'wrong synthetic password'), null);
    assert.equal(await storedHash(db, 'u1'), legacy, 'a failed login must not rehash');
    assert.equal(await authenticate(db, 'disabled@example.test', PASSWORD), null);
    assert.equal(await storedHash(db, 'u2'), legacy, 'a disabled account must not rehash');
    assert.equal(await authenticate(db, 'nobody@example.test', PASSWORD), null);
  } finally {
    await dispose();
  }
});
