/**
 * Email verification and password reset over Resend, using plain fetch().
 *
 * No SDK: the Resend HTTP API is a single POST, which keeps this Workers-compatible
 * (see https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/).
 * The API key is never pasted, read, or tested with a real value here — routes read it
 * from the environment (`RESEND_API_KEY`, owner-set via `wrangler secret put`) and the
 * tests below run against an injected mock fetch only.
 */

export const RESEND_API_URL = 'https://api.resend.com/emails';

/** Verification links prove ownership for a day; reset links for an hour. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface EmailConfiguration {
  apiKey: string;
  from: string;
}

export function emailConfigured(config: EmailConfiguration) {
  return config.apiKey.length > 0 && config.from.length > 0;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type FetchImpl = typeof fetch;

export interface SendResult {
  sent: boolean;
  id?: string;
  error?: string;
}

/**
 * Sends one transactional email through Resend. Returns a result rather than throwing on an
 * API error, so registration can still create the (unverified) account and tell the caller
 * the email did not go out. Only a network failure throws, and routes treat that the same way.
 */
export async function sendEmailViaResend(
  config: EmailConfiguration,
  email: OutgoingEmail,
  fetchImpl: FetchImpl = fetch,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
    });
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : 'Email request failed.' };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { sent: false, error: `Resend refused the email (HTTP ${response.status}).${detail ? ` ${detail.slice(0, 200)}` : ''}` };
  }
  const body = await response.json().catch(() => ({})) as { id?: unknown };
  return { sent: true, id: typeof body.id === 'string' ? body.id : undefined };
}

/** A 256-bit token, base64url-encoded so it survives query strings without escaping. */
export function newEmailToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Only the hash is stored, so reading the database never yields a usable link. */
export async function hashEmailToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function verificationLinkFor(request: Request, token: string) {
  return `${new URL(request.url).origin}/auth/verify?token=${encodeURIComponent(token)}`;
}

export function passwordResetLinkFor(request: Request, token: string) {
  return `${new URL(request.url).origin}/auth/reset?token=${encodeURIComponent(token)}`;
}

export function verificationEmail(to: string, link: string): OutgoingEmail {
  return {
    to,
    subject: 'Verify your email for Ik ben een appel',
    text: `Confirm this address to finish creating your account:\n\n${link}\n\n`
      + 'This link works once and expires in 24 hours. If you did not register, ignore this email.',
    html: `<p>Confirm this address to finish creating your account:</p>`
      + `<p><a href="${escapeHtml(link)}">Verify my email</a></p>`
      + `<p>This link works once and expires in 24 hours. If you did not register, ignore this email.</p>`,
  };
}

export function passwordResetEmail(to: string, link: string): OutgoingEmail {
  return {
    to,
    subject: 'Reset your password for Ik ben een appel',
    text: `Someone requested a password reset for this address. Choose a new password here:\n\n${link}\n\n`
      + 'This link works once and expires in 1 hour. If that was not you, ignore this email — your password is unchanged.',
    html: `<p>Someone requested a password reset for this address. Choose a new password here:</p>`
      + `<p><a href="${escapeHtml(link)}">Choose a new password</a></p>`
      + `<p>This link works once and expires in 1 hour. If that was not you, ignore this email — your password is unchanged.</p>`,
  };
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

interface TokenRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
}

/**
 * Issues a single-use verification token for an account. Any earlier token for the same
 * account is withdrawn first, so only the newest email can confirm it.
 */
export async function issueEmailVerification(
  db: D1Database, userId: string, nowMs = Date.now(),
): Promise<IssuedToken> {
  const token = newEmailToken();
  const expiresAt = new Date(nowMs + VERIFICATION_TOKEN_TTL_MS).toISOString();
  await db.prepare('DELETE FROM email_verifications WHERE user_id = ?').bind(userId).run();
  await db.prepare('INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await hashEmailToken(token), userId, expiresAt, new Date(nowMs).toISOString()).run();
  await db.prepare('DELETE FROM email_verifications WHERE expires_at <= ?').bind(new Date(nowMs).toISOString()).run();
  return { token, expiresAt };
}

/** Consumes a verification token. Expired or already-used tokens yield null and stay gone. */
export async function consumeEmailVerification(
  db: D1Database, token: string, nowMs = Date.now(),
): Promise<{ userId: string } | null> {
  const row = await db.prepare('SELECT user_id, expires_at FROM email_verifications WHERE token_hash = ?')
    .bind(await hashEmailToken(token)).first<TokenRow>();
  await db.prepare('DELETE FROM email_verifications WHERE token_hash = ?').bind(await hashEmailToken(token)).run();
  if (!row || row.expires_at <= new Date(nowMs).toISOString()) return null;
  return { userId: row.user_id };
}

/** Issues a single-use password-reset token, withdrawing any earlier one for the account. */
export async function issuePasswordReset(
  db: D1Database, userId: string, nowMs = Date.now(),
): Promise<IssuedToken> {
  const token = newEmailToken();
  const expiresAt = new Date(nowMs + PASSWORD_RESET_TOKEN_TTL_MS).toISOString();
  await db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId).run();
  await db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, used_at) VALUES (?, ?, ?, ?)')
    .bind(await hashEmailToken(token), userId, expiresAt, '').run();
  await db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').bind(new Date(nowMs).toISOString()).run();
  return { token, expiresAt };
}

/** Consumes a reset token. A consumed token cannot be replayed: it is deleted first. */
export async function consumePasswordReset(
  db: D1Database, token: string, nowMs = Date.now(),
): Promise<{ userId: string } | null> {
  const row = await db.prepare('SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?')
    .bind(await hashEmailToken(token)).first<TokenRow>();
  await db.prepare('DELETE FROM password_resets WHERE token_hash = ?').bind(await hashEmailToken(token)).run();
  if (!row || row.expires_at <= new Date(nowMs).toISOString()) return null;
  return { userId: row.user_id };
}

/** Marks the address as owned. Empty means unverified; a timestamp means verified. */
export async function markEmailVerified(db: D1Database, userId: string, now = new Date().toISOString()) {
  await db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at = ''")
    .bind(now, userId).run();
}
