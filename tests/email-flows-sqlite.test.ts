import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  consumeEmailVerification,
  consumePasswordReset,
  issueEmailVerification,
  issuePasswordReset,
  markEmailVerified,
  PASSWORD_RESET_TOKEN_TTL_MS,
  VERIFICATION_TOKEN_TTL_MS,
} from '../lib/email';

/**
 * T17 (#121): the verification and password-reset flows, on the SQLite adapter.
 *
 * `tests/email.test.ts` already covers these flows thoroughly — single use,
 * expiry, per-account scoping, enumeration safety — but it runs them on
 * Miniflare's D1. Dev, test and the self-hosted stack run on `node:sqlite`
 * through `db/sqlite-adapter.ts`, and that difference has already hidden a
 * defect of exactly this shape: `INSERT ... ON CONFLICT ... RETURNING`
 * returned no rows through the adapter, so the durable rate limiter failed
 * closed and every sign-in answered 503 while the whole D1 suite stayed
 * green. A flow proved only on D1 is not proved on the stack that ships.
 *
 * So this file re-proves the behaviour that matters rather than the plumbing:
 * tokens round-trip, are single-use, expire, are scoped to one account, and
 * `markEmailVerified` is a one-way door. Synthetic accounts and a throwaway
 * database only; no mail is sent and no credential is real.
 */

const dir = mkdtempSync(join(tmpdir(), 'email-flows-sqlite-'));
process.env.SQLITE_PATH = join(dir, 'flows.sqlite');

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // The adapter caches one handle per path for the process lifetime, which
    // blocks deletion on Windows. The files are under the OS temp dir.
  }
});

/**
 * One migrated SQLite database, built by the app's own `ensureSchema()` so the
 * schema is the real one rather than a hand-rolled subset. Each call makes a
 * fresh synthetic account, so no test can read another's tokens.
 */
let accounts = 0;
async function syntheticAccount() {
  const { bindings, ensureSchema } = await import('../db/runtime');
  await ensureSchema();
  const { db } = bindings();
  const id = `u${accounts += 1}`;
  await db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, `${id}@example.test`, 'synthetic-hash', '2026-01-01').run();
  return { db, id };
}

test('a verification token round-trips through the SQLite adapter and confirms once', async () => {
  const { db, id } = await syntheticAccount();
  const issued = await issueEmailVerification(db, id);
  assert.match(issued.token, /^[A-Za-z0-9_-]+$/, 'the token is URL-safe');

  const stored = await db.prepare('SELECT token_hash FROM email_verifications WHERE user_id = ?')
    .bind(id).first<{ token_hash: string }>();
  assert.ok(stored, 'the row reached the database');
  assert.notEqual(stored.token_hash, issued.token, 'only a hash is stored, never the token');

  assert.deepEqual(await consumeEmailVerification(db, issued.token), { userId: id });
  assert.equal(await consumeEmailVerification(db, issued.token), null, 'a second use is refused');
  const left = await db.prepare('SELECT COUNT(*) AS total FROM email_verifications WHERE user_id = ?')
    .bind(id).first<{ total: number }>();
  assert.equal(left?.total, 0, 'the consumed row is gone, not merely marked');
});

test('only the newest verification token works, and an expired one dies quietly', async () => {
  const { db, id } = await syntheticAccount();
  const first = await issueEmailVerification(db, id);
  const second = await issueEmailVerification(db, id);
  assert.equal(await consumeEmailVerification(db, first.token), null, 'the superseded token is withdrawn');
  assert.deepEqual(await consumeEmailVerification(db, second.token), { userId: id });

  const issuedAt = Date.now();
  const expiring = await issueEmailVerification(db, id, issuedAt);
  assert.equal(await consumeEmailVerification(db, expiring.token, issuedAt + VERIFICATION_TOKEN_TTL_MS + 1), null,
    'an expired token yields null rather than throwing');
});

test('a reset token is single-use and scoped to its own account', async () => {
  const { db, id: mineId } = await syntheticAccount();
  const { id: theirId } = await syntheticAccount();

  const mine = await issuePasswordReset(db, mineId);
  const theirs = await issuePasswordReset(db, theirId);
  assert.notEqual(mine.token, theirs.token);

  assert.deepEqual(await consumePasswordReset(db, mine.token), { userId: mineId },
    'the token resolves to the account it was issued for, not the other one');
  assert.equal(await consumePasswordReset(db, mine.token), null, 'it cannot be replayed');
  assert.deepEqual(await consumePasswordReset(db, theirs.token), { userId: theirId },
    'consuming one account token leaves the other account alone');
});

test('an expired reset token is refused', async () => {
  const { db, id } = await syntheticAccount();
  const issuedAt = Date.now();
  const issued = await issuePasswordReset(db, id, issuedAt);
  assert.equal(await consumePasswordReset(db, issued.token, issuedAt + PASSWORD_RESET_TOKEN_TTL_MS + 1), null);
});

test('an unknown token is refused without revealing whether the account exists', async () => {
  const { db } = await syntheticAccount();
  assert.equal(await consumeEmailVerification(db, 'not-a-real-token'), null);
  assert.equal(await consumePasswordReset(db, 'not-a-real-token'), null);
});

test('markEmailVerified is a one-way door on the SQLite adapter', async () => {
  const { db, id } = await syntheticAccount();
  const before = await db.prepare('SELECT email_verified_at FROM users WHERE id = ?')
    .bind(id).first<{ email_verified_at: string }>();
  assert.equal(before?.email_verified_at, '', 'new accounts start unverified');

  await markEmailVerified(db, id, '2026-02-02T00:00:00.000Z');
  const verified = await db.prepare('SELECT email_verified_at FROM users WHERE id = ?')
    .bind(id).first<{ email_verified_at: string }>();
  assert.equal(verified?.email_verified_at, '2026-02-02T00:00:00.000Z');

  // The UPDATE is guarded by `email_verified_at = ''`, so a later call must not
  // move the timestamp. Through the adapter that is an UPDATE matching no rows,
  // which has to be a quiet no-op rather than an error.
  await markEmailVerified(db, id, '2026-03-03T00:00:00.000Z');
  const unchanged = await db.prepare('SELECT email_verified_at FROM users WHERE id = ?')
    .bind(id).first<{ email_verified_at: string }>();
  assert.equal(unchanged?.email_verified_at, '2026-02-02T00:00:00.000Z',
    'the first verification time stands');
});
