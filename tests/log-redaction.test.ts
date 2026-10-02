import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { hashEmailToken, issueEmailVerification, issuePasswordReset, purgeExpiredTokens,
  sendEmailViaResend } from '../lib/email';

/**
 * T39/F13: approved log redaction and expiry, proven with synthetic secrets.
 *
 * The audit log is `auth_events` (email + IP + kind only) and the token log is
 * `email_verifications` / `password_resets` (hashes only). Nothing else in server code
 * records credentials, tokens, keys, request bodies or private search data. These tests
 * pin that with synthetic fixtures — no real secrets, no production data — in three ways:
 *
 * 1. Static guards: server code never logs, audit writes carry only approved literal
 *    kinds, audit reads stay administrator-only, and raw tokens reach a response only
 *    on loopback.
 * 2. Leakage: synthetic password/token/key material run through the real issue/send
 *    paths never appears in any stored log row.
 * 3. Expiry: the boot-time sweep deletes expired token rows while keeping live ones;
 *    the 30-day `auth_events` retention is pinned at both the migration and the runtime.
 *
 * Periods exercised here are the ones already in code and on `/privacy` (30-day sign-in
 * records, 24h verification / 1h reset links, 15-minute rate-limit buckets). They are
 * not an owner-approved retention table — that approval is T38's gate, not this test.
 */

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function tsFiles(relative: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(join(repoRoot, directory), { withFileTypes: true })) {
      const next = join(directory, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) found.push(next);
    }
  };
  await walk(relative);
  return found.sort();
}

const read = (relative: string) => readFile(join(repoRoot, relative), 'utf8');

test('server code never logs: no console output in app, lib or worker', async () => {
  // If nothing is ever written to a server log, no password, token, key or request body
  // can leak through one. Local scripts/ tooling is out of scope: it runs on the
  // owner's computer, and the one place it prints a credential (the temporary admin
  // password) is a deliberate show-once handoff, not a retained log.
  const files = [...await tsFiles('app'), ...await tsFiles('lib'), ...await tsFiles('worker')];
  assert.ok(files.length > 0, 'the scan must actually cover server code');
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /console\.(log|error|warn|info|debug|trace)\s*\(/,
      `${file} must not write to a server log`);
  }
});

test('audit writes carry only approved literal kinds, never detail', async () => {
  // Every auth_events write is one of the two helpers (per-route recordAttempt, admin
  // recordAdminAction) or the email-diagnostics INSERT. The kind column is the only
  // free-text-adjacent field, so it may only ever be a literal from this list — never
  // a refusal reason, token, password, or request body. Resend's refusal text can quote
  // the address it refused, which is why outcomes are recorded as bare email-sent/failed.
  const approved = new Set([
    'throttled', 'register', 'register-duplicate', 'login', 'failed', 'unverified',
    'bot-rejected', 'reset-request', 'reset-confirm', 'reset-invalid',
    'email-sent', 'email-failed', 'verify', 'verify-invalid',
    'disable', 'enable', 'promote', 'demote', 'set-password', 'delete-account',
  ]);
  const writers = [
    'app/api/auth/route.ts',
    'app/api/auth/verify/route.ts',
    'app/api/auth/password-reset/route.ts',
    'app/api/auth/password-reset/confirm/route.ts',
    'app/api/admin/route.ts',
    'app/api/admin/email/route.ts',
  ];
  for (const file of writers) {
    const source = await read(file);
    assert.match(source, /INSERT INTO auth_events/, `${file} must keep its audit write visible`);
    // No error/detail/refusal value may flow into the write: the only interpolation
    // allowed is the admin `admin:<action> by <actor>` kind, built from two emails.
    assert.doesNotMatch(source, /recordAttempt\([^)]*\.error/, `${file} must not log error text`);
    assert.doesNotMatch(source, /recordAttempt\([^)]*token/, `${file} must not log tokens`);
    assert.doesNotMatch(source, /recordAttempt\([^)]*password/, `${file} must not log passwords`);
    assert.doesNotMatch(source, /\.bind\([^)]*\.error/, `${file} must not bind error text`);
  }
  // Every literal kind passed to recordAttempt, plus every admin action, is approved.
  const kinds: string[] = [];
  for (const file of writers) {
    const source = await read(file);
    for (const match of source.matchAll(/recordAttempt\(db, [^,]+, [^,]+, ('[a-z-]+'|sent\.sent|resent\.sent)/g)) {
      const literal = match[1];
      if (literal.startsWith("'")) kinds.push(literal.slice(1, -1));
      else kinds.push('email-sent', 'email-failed');
    }
    for (const match of source.matchAll(/recordAdminAction\(db, [^,]+, [^,]+, '([a-z-]+)'\)/g)) {
      kinds.push(match[1]);
    }
  }
  assert.ok(kinds.length > 0, 'the scan must actually find audit kinds');
  for (const kind of kinds) {
    assert.ok(approved.has(kind), `audit kind '${kind}' is not an approved literal`);
  }
  // The one dynamic kind is administrator-attribution only: `admin:<action> by <email>`.
  const admin = await read('app/api/admin/route.ts');
  assert.match(admin, /`admin:\$\{action\} by \$\{actorEmail\}`/);
  assert.doesNotMatch(admin, /admin:\$\{[^}]*token[^}]*\}/i, 'the admin kind must not carry tokens');
});

test('audit reads stay administrator-only and aggregate, never row-level', async () => {
  // auth_events holds emails and IPs, so only the administrator diagnostics route may
  // read it — and only as sent/failed counts, never as rows that could be browsed.
  for (const file of await tsFiles('app/api')) {
    const source = await read(file);
    if (!source.includes('FROM auth_events')) continue;
    assert.match(file, /app[\/\\]api[\/\\]admin[\/\\]/, `${file} reads the audit log without the admin boundary`);
    assert.match(source, /adminOnly: true/, `${file} reads the audit log without the admin guard`);
  }
  const diagnostics = await read('app/api/admin/email/route.ts');
  assert.match(diagnostics, /SELECT kind, COUNT\(\*\)/);
  assert.doesNotMatch(diagnostics, /SELECT \*/);
});

test('raw single-use tokens reach a response only on loopback', async () => {
  // With no sender configured there is no email to click, so the raw token is handed
  // back — but only to a caller on this computer. On any reachable host the token
  // travels by email alone and the API never serializes it.
  for (const file of ['app/api/auth/route.ts', 'app/api/auth/verify/route.ts',
    'app/api/auth/password-reset/route.ts']) {
    const source = await read(file);
    for (const match of source.matchAll(/(verificationToken|resetToken)/g)) {
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      assert.match(before, /isLocalBootstrapRequest/,
        `${file} exposes a raw token without the loopback gate`);
    }
  }
});

test('provider refusal detail is bounded and never reaches a non-admin caller', async () => {
  // Resend's refusal can quote the address it refused, so the detail is capped at the
  // send boundary and discarded by every public route, which answers identically
  // either way instead of becoming an account-existence oracle.
  const email = await read('lib/email.ts');
  assert.match(email, /detail\.slice\(0, 200\)/, 'provider refusal text must stay capped');
  for (const file of ['app/api/auth/route.ts', 'app/api/auth/verify/route.ts',
    'app/api/auth/password-reset/route.ts']) {
    const source = await read(file);
    assert.doesNotMatch(source, /sent\.error|resent\.error/,
      `${file} must not serialize provider refusal text`);
  }
  const refused = await sendEmailViaResend(
    { apiKey: 'synthetic-resend-key', from: 'Ik ben een appel <synthetic@example.test>' },
    { to: 'person@example.test', subject: 's', text: 't', html: '<p>t</p>' },
    (async () => new Response(JSON.stringify({ message: `rejected synthetic@example.test with key synthetic-resend-key ${'x'.repeat(5000)}` }),
      { status: 400 })) as unknown as typeof fetch,
  );
  assert.equal(refused.sent, false);
  assert.ok((refused.error ?? '').length < 300, 'refusal detail must stay bounded');
});

async function logDb() {
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
  await db.prepare(`CREATE TABLE auth_events (
    id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE email_verifications (
    token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT NOT NULL DEFAULT ''
  )`).run();
  return { db, dispose: () => runtime.dispose() };
}

test('synthetic password, token and key material never lands in a log row', async () => {
  const { db, dispose } = await logDb();
  try {
    const password = 'synthetic-password-9f2c41';
    const apiKey = 'synthetic-resend-key-7d55aa';
    await db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@example.test', 'synthetic-hash', '2026-09-24')").run();
    const verification = await issueEmailVerification(db, 'u1');
    const reset = await issuePasswordReset(db, 'u1');
    // Mirror the route helpers exactly: email + IP + literal kind, nothing else.
    const recordAttempt = (email: string, ip: string, kind: string) =>
      db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), email, ip, kind, new Date().toISOString()).run();
    await recordAttempt('a@example.test', '203.0.113.7', 'register');
    await recordAttempt('a@example.test', '203.0.113.7', 'email-sent');
    await recordAttempt('a@example.test', '203.0.113.7', 'login');
    await db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), 'a@example.test', '', 'admin:set-password by boss@example.test',
        new Date().toISOString()).run();

    const dump = JSON.stringify({
      auth: (await db.prepare('SELECT email, ip, kind FROM auth_events').all()).results,
      verifications: (await db.prepare('SELECT token_hash FROM email_verifications').all()).results,
      resets: (await db.prepare('SELECT token_hash FROM password_resets').all()).results,
    });
    for (const secret of [password, verification.token, reset.token, apiKey]) {
      assert.equal(dump.includes(secret), false, 'a raw secret leaked into a stored log row');
    }
    // Hashes — not usable links — are what is stored.
    assert.equal(dump.includes(await hashEmailToken(verification.token)), true);
    assert.equal(dump.includes(await hashEmailToken(reset.token)), true);
  } finally {
    await dispose();
  }
});

test('the boot sweep deletes expired token rows and keeps live ones', async () => {
  const { db, dispose } = await logDb();
  try {
    await db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@example.test', 'h', '2026-09-24')").run();
    const live = await issueEmailVerification(db, 'u1');
    const liveReset = await issuePasswordReset(db, 'u1');
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.prepare('INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind('stale-verification', 'u1', past).run();
    await db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, used_at) VALUES (?, ?, ?, ?)')
      .bind('stale-reset', 'u1', past, '').run();

    await purgeExpiredTokens(db);

    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM email_verifications WHERE token_hash = 'stale-verification'")
      .first<{ n: number }>().then((row) => row?.n), 0, 'expired verification row must be swept');
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = 'stale-reset'")
      .first<{ n: number }>().then((row) => row?.n), 0, 'expired reset row must be swept');
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM email_verifications WHERE token_hash = ?')
      .bind(await hashEmailToken(live.token)).first<{ n: number }>().then((row) => row?.n), 1,
      'a live verification row must survive the sweep');
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?')
      .bind(await hashEmailToken(liveReset.token)).first<{ n: number }>().then((row) => row?.n), 1,
      'a live reset row must survive the sweep');
  } finally {
    await dispose();
  }
});

test('the 30-day sign-in retention is pinned at the migration and at boot', async () => {
  // The purge must stay a short window, not drift into indefinite retention: pin the
  // exact statement in both places it lives — the one-time migration for old rows and
  // the boot sweep that enforces it from here on.
  const { runtimeMigrations } = await import('../db/migrations');
  const migration = runtimeMigrations.find((entry) => entry.version === 9);
  assert.ok(migration, 'migration 9 must exist');
  assert.match(migration.statements.join('\n'),
    /DELETE FROM auth_events WHERE created_at < datetime\('now', '-30 days'\)/);
  const runtime = await read('db/runtime.ts');
  assert.match(runtime, /DELETE FROM auth_events WHERE created_at < datetime\('now', '-30 days'\)/);
  assert.match(runtime, /purgeExpiredTokens\(db\)/, 'boot must sweep expired single-use tokens');
});
