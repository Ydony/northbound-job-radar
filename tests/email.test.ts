import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { consumeEmailVerification, consumePasswordReset, hashEmailToken, issueEmailVerification,
  issuePasswordReset, markEmailVerified, newEmailToken, passwordResetEmail, passwordResetLinkFor,
  RESEND_API_URL, sendEmailViaResend, verificationEmail, verificationLinkFor } from '../lib/email';
import { createUser, userFromRow } from '../lib/users';

/**
 * #170: email verification + password reset via Resend. Every network assertion here runs
 * against an injected mock fetch — the real Resend API is never contacted and no real key
 * or address appears anywhere. D1 flows run against real Miniflare D1, not a mock.
 */

const config = { apiKey: 'synthetic-resend-key', from: 'Ik ben een appel <synthetic@example.test>' };

function mockFetch(captured: { url?: string; init?: RequestInit }, status = 200, body: unknown = { id: 'synthetic-id' }) {
  return async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify(body), { status });
  };
}

test('verification email goes to the Resend endpoint with a bearer key, never anywhere else', async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const email = verificationEmail('person@example.test', 'https://app.test/auth/verify?token=abc');
  const result = await sendEmailViaResend(config, email, mockFetch(captured) as typeof fetch);
  assert.deepEqual(result, { sent: true, id: 'synthetic-id' });
  assert.equal(captured.url, RESEND_API_URL);
  assert.equal(captured.url, 'https://api.resend.com/emails');
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-resend-key');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(captured.init?.method, 'POST');
  const body = JSON.parse(String(captured.init?.body));
  assert.equal(body.from, config.from);
  assert.equal(body.to, 'person@example.test');
  assert.match(body.subject, /Verify/);
  assert.match(body.text, /https:\/\/app\.test\/auth\/verify\?token=abc/);
  assert.match(body.html, /https:\/\/app\.test\/auth\/verify\?token=abc/);
});

test('a refused or unreachable Resend request reports unsent instead of throwing the signup away', async () => {
  const refused = await sendEmailViaResend(config,
    passwordResetEmail('person@example.test', 'https://app.test/auth/reset?token=x'),
    mockFetch({}, 400, { message: 'invalid from' }) as typeof fetch);
  assert.equal(refused.sent, false);
  assert.match(refused.error ?? '', /HTTP 400/);

  const unreachable = await sendEmailViaResend(config,
    passwordResetEmail('person@example.test', 'https://app.test/auth/reset?token=x'),
    (async () => { throw new Error('socket down'); }) as unknown as typeof fetch);
  assert.equal(unreachable.sent, false);
});

test('tokens are unique, URL-safe, and stored only as hashes', async () => {
  const first = newEmailToken();
  const second = newEmailToken();
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /[+/=]/, 'must survive a query string without escaping');
  const hash = await hashEmailToken(first);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashEmailToken(first), 'hashing must be deterministic');
  assert.notEqual(hash, await hashEmailToken(second));
});

test('email links are built from the request origin, never a hardcoded host', () => {
  const verify = new Request('http://localhost:3000/api/auth');
  assert.equal(verificationLinkFor(verify, 'tok'), 'http://localhost:3000/auth/verify?token=tok');
  assert.equal(passwordResetLinkFor(verify, 'tok'), 'http://localhost:3000/auth/reset?token=tok');
});

async function tokenDb() {
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
    email_verified_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE email_verifications (
    token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare('CREATE INDEX password_resets_user_idx ON password_resets(user_id)').run();
  return { db, dispose: () => runtime.dispose() };
}

test('a verification token confirms once, then is gone', async () => {
  const { db, dispose } = await tokenDb();
  try {
    await db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@example.test', 'h', '2026-09-24')").run();
    const issued = await issueEmailVerification(db, 'u1');
    // Only the hash is stored: the database never holds a usable link.
    const stored = await db.prepare('SELECT token_hash FROM email_verifications WHERE user_id = ?').bind('u1')
      .first<{ token_hash: string }>();
    assert.equal(stored?.token_hash, await hashEmailToken(issued.token));
    assert.equal((await consumeEmailVerification(db, issued.token))?.userId, 'u1');
    await markEmailVerified(db, 'u1');
    const user = await db.prepare('SELECT email_verified_at FROM users WHERE id = ?').bind('u1')
      .first<{ email_verified_at: string }>();
    assert.notEqual(user?.email_verified_at, '');
    assert.equal(await consumeEmailVerification(db, issued.token), null, 'a replayed link must fail');
  } finally {
    await dispose();
  }
});

test('only the newest verification email works, and expired tokens die quietly', async () => {
  const { db, dispose } = await tokenDb();
  try {
    await db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@example.test', 'h', '2026-09-24')").run();
    const first = await issueEmailVerification(db, 'u1');
    const second = await issueEmailVerification(db, 'u1');
    assert.equal(await consumeEmailVerification(db, first.token), null, 'the superseded email must fail');
    assert.equal((await consumeEmailVerification(db, second.token))?.userId, 'u1');
    const stale = await issuePasswordReset(db, 'u1', Date.now() - 2 * 60 * 60 * 1000);
    assert.equal(await consumePasswordReset(db, stale.token), null, 'an expired reset must fail');
  } finally {
    await dispose();
  }
});

test('a reset token is single-use and scoped to its own account', async () => {
  const { db, dispose } = await tokenDb();
  try {
    await db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@example.test', 'h', '2026-09-24')").run();
    await db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u2', 'b@example.test', 'h', '2026-09-24')").run();
    const reset = await issuePasswordReset(db, 'u1');
    assert.equal((await consumePasswordReset(db, reset.token))?.userId, 'u1');
    assert.equal(await consumePasswordReset(db, reset.token), null, 'a replayed reset must fail');
    assert.equal(await consumePasswordReset(db, 'bogus-token'), null);
  } finally {
    await dispose();
  }
});

test('new accounts start unverified; the verification flag round-trips through the row', async () => {
  const { db, dispose } = await tokenDb();
  try {
    // A pre-existing row keeps this account off the first-user path, so the legacy workspace
    // adoption (which needs tables this fixture does not have) never runs.
    await db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('seed', 'seed@example.test', 'h', '2026-09-24')").run();
    const created = await createUser(db, 'new@example.test', 'a-long-enough-password');
    assert.equal(created.user.emailVerified, false, 'signup must create an unverified account');
    assert.equal(userFromRow({ id: 'x', email: 'x', password_hash: 'h', role: 'user', status: 'active',
      created_at: '', last_seen_at: '' }).emailVerified, false);
    assert.equal(userFromRow({ id: 'x', email: 'x', password_hash: 'h', role: 'user', status: 'active',
      email_verified_at: '2026-09-24T00:00:00.000Z', created_at: '', last_seen_at: '' }).emailVerified, true);
  } finally {
    await dispose();
  }
});

test('migration 29 adds verification state and grandfathers existing accounts', async () => {
  const migration = runtimeMigrations.find((entry) => entry.version === 29);
  assert.ok(migration, 'migration 29 must exist');
  assert.equal(migration.name, 'email_verification_tokens');
  const sql = migration.statements.join('\n');
  assert.match(sql, /ALTER TABLE users ADD COLUMN email_verified_at TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS email_verifications/);
  assert.match(sql, /email_verifications_user_idx ON email_verifications\(user_id\)/);
  // Existing accounts proved ownership by signing in before verification existed.
  assert.match(sql, /UPDATE users SET email_verified_at = created_at/);

  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  try {
    const db = await runtime.getD1Database('DB') as unknown as D1Database;
    await db.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    )`).run();
    await db.prepare("INSERT INTO users (id, email, password_hash, role, status, created_at, last_seen_at) VALUES ('u1', 'a@example.test', 'h', 'admin', 'active', '2026-01-01', '2026-01-01')").run();
    await db.batch(migration.statements.map((statement) => db.prepare(statement)));
    const row = await db.prepare('SELECT email_verified_at FROM users WHERE id = ?').bind('u1')
      .first<{ email_verified_at: string }>();
    assert.equal(row?.email_verified_at, '2026-01-01', 'existing accounts stay able to sign in');
    await db.prepare("INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ('h', 'u1', 'x')").run();
  } finally {
    await runtime.dispose();
  }
});

test('verification and reset endpoints are rate-limited, single-use, and enumeration-safe', async () => {
  const root = new URL('../app/api/auth/', import.meta.url);
  const auth = await readFile(new URL('./route.ts', root), 'utf8');
  const verify = await readFile(new URL('./verify/route.ts', root), 'utf8');
  const reset = await readFile(new URL('./password-reset/route.ts', root), 'utf8');
  const confirm = await readFile(new URL('./password-reset/confirm/route.ts', root), 'utf8');

  // Registration creates an unverified account with no session; the login gate says so plainly
  // only to a caller who already proved the credential.
  assert.match(auth, /verificationRequired: true/);
  assert.match(auth, /needsVerification: true/);
  assert.match(auth, /issueEmailVerification/);

  for (const [name, source, buckets] of [
    ['verify', verify, ['verify:ip:', 'verify:email:', 'verify-confirm:ip:']],
    ['reset', reset, ['reset:ip:', 'reset:email:']],
    ['confirm', confirm, ['reset-confirm:ip:']],
  ] as const) {
    for (const bucket of buckets) assert.match(source, new RegExp(bucket.replaceAll(':', ':')),
      `${name} must rate-limit the ${bucket} bucket`);
    assert.match(source, /durableRateLimit/, `${name} must use the durable limiter, not the in-memory one`);
  }
  assert.match(verify, /consumeEmailVerification/);
  assert.match(verify, /markEmailVerified/);
  assert.match(reset, /issuePasswordReset/);
  assert.match(confirm, /consumePasswordReset/);
  // Enumeration-safe: the unauthenticated resend/request endpoints always answer the same way.
  assert.match(verify, /return Response\.json\(\{ ok: true \}\);/);
  assert.match(reset, /return Response\.json\(\{ ok: true \}\);/);
});

test('deleting an account removes its verification tokens with everything else', async () => {
  // Deletion is delegated to the shared helper (#176): the token cleanup lives there, once,
  // covering self-deletion, admin deletion and workspace reset — not as inline SQL per route.
  const helper = await readFile(new URL('../lib/account-deletion.ts', import.meta.url), 'utf8');
  assert.match(helper, /DELETE FROM email_verifications WHERE user_id = \?/);
  const account = await readFile(new URL('../app/api/account/route.ts', import.meta.url), 'utf8');
  assert.match(account, /accountDeletionStatements\(db, user\.id, user\.email\)/);
  const admin = await readFile(new URL('../app/api/admin/route.ts', import.meta.url), 'utf8');
  assert.match(admin, /accountDeletionStatements\(db, userId, target\.email\)/);
  const bootstrap = await readFile(new URL('../scripts/bootstrap-prod-admin.mjs', import.meta.url), 'utf8');
  assert.match(bootstrap, /email_verified_at/, 'the bootstrapped owner must start verified');
});
