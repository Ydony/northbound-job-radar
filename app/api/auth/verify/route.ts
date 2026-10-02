import { authSecrets, bindings, emailConfiguration, ensureSchema } from '@/db/runtime';
import { createSessionValue, isLocalBootstrapRequest, isSameOrigin, sessionCookie } from '@/lib/auth';
import { consumeEmailVerification, emailConfigured, issueEmailVerification, markEmailVerified,
  sendEmailViaResend, verificationEmail, verificationLinkFor } from '@/lib/email';
import { clientIp, durableRateLimit, noStoreJson } from '@/lib/guard';
import { recordSecurityEvent } from '@/lib/security-events';
import { findUserByEmail, findUserById, isValidEmail, normalizeEmail } from '@/lib/users';

function isSecureRequest(request: Request) {
  return new URL(request.url).protocol === 'https:'
    || request.headers.get('x-forwarded-proto') === 'https';
}

async function recordAttempt(db: D1Database, email: string, ip: string, kind: string) {
  await recordSecurityEvent(db, { email, ip, kind });
}

/** Follows the emailed link: a single-use token proves the address and signs the account in. */
export async function GET(request: Request) {
  await ensureSchema();
  const { sessionSecret } = authSecrets();
  if (!sessionSecret) {
    return noStoreJson({ error: 'This installation is not configured. Set SESSION_SECRET and restart.' }, { status: 503 });
  }
  const { db } = bindings();
  const limited = await durableRateLimit(db, `verify-confirm:ip:${clientIp(request)}`, 20, 15 * 60_000);
  if (limited) {
    await recordAttempt(db, '', clientIp(request), 'throttled');
    return limited;
  }

  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) return noStoreJson({ error: 'This link is invalid or has expired.' }, { status: 400 });
  const consumed = await consumeEmailVerification(db, token);
  if (!consumed) {
    await recordAttempt(db, '', clientIp(request), 'verify-invalid');
    return noStoreJson({ error: 'This link is invalid or has expired.' }, { status: 400 });
  }
  const row = await findUserById(db, consumed.userId);
  if (!row || row.status !== 'active') {
    return noStoreJson({ error: 'This link is invalid or has expired.' }, { status: 400 });
  }
  await markEmailVerified(db, row.id);
  await recordAttempt(db, row.email, clientIp(request), 'verify');
  const value = await createSessionValue(row.id, sessionSecret, row.session_epoch ?? 1);
  return noStoreJson({ ok: true }, {
    headers: { 'set-cookie': sessionCookie(value, isSecureRequest(request)) },
  });
}

/**
 * Re-sends the verification email. Always answers the same way so a stranger cannot probe
 * which addresses are registered, verified, or even present.
 */
export async function POST(request: Request) {
  await ensureSchema();
  if (!isSameOrigin(request)) {
    return noStoreJson({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  const { db } = bindings();
  const ip = clientIp(request);
  const body = await request.json().catch(() => ({})) as { email?: unknown };
  const email = normalizeEmail(body.email);

  // Token guessing and mailbox flooding share one endpoint, so both get a durable cap: per
  // address slows targeting one mailbox, per IP slows spraying across many.
  const limited = await durableRateLimit(db, `verify:ip:${ip}`, 5, 15 * 60_000)
    ?? await durableRateLimit(db, `verify:email:${email}`, 5, 15 * 60_000);
  if (limited) {
    await recordAttempt(db, email, ip, 'throttled');
    return limited;
  }

  const emailConfig = emailConfiguration();
  if (isValidEmail(email)) {
    const row = await findUserByEmail(db, email);
    if (row && row.status === 'active' && !row.email_verified_at) {
      const verification = await issueEmailVerification(db, row.id);
      if (emailConfigured(emailConfig)) {
        const resent = await sendEmailViaResend(emailConfig,
          verificationEmail(email, verificationLinkFor(request, verification.token)));
        // Same rule as the reset route: the answer must not vary by address, so a delivery
        // failure is recorded for `GET /api/admin/email` rather than reported to the caller.
        await recordAttempt(db, email, ip, resent.sent ? 'email-sent' : 'email-failed');
      } else if (isLocalBootstrapRequest(request)) {
        // Local-only convenience, mirroring registration: with no sender configured there is
        // no email to click, so the token is handed back on loopback.
        return noStoreJson({ ok: true, verificationToken: verification.token });
      }
    }
  }
  return noStoreJson({ ok: true });
}
