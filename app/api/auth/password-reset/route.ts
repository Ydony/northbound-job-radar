import { bindings, emailConfiguration, ensureSchema } from '@/db/runtime';
import { isLocalBootstrapRequest, isSameOrigin } from '@/lib/auth';
import { emailConfigured, issuePasswordReset, passwordResetEmail, passwordResetLinkFor,
  sendEmailViaResend } from '@/lib/email';
import { clientIp, durableRateLimit } from '@/lib/guard';
import { findUserByEmail, isValidEmail, normalizeEmail } from '@/lib/users';

async function recordAttempt(db: D1Database, email: string, ip: string, kind: string) {
  await db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), email, ip, kind, new Date().toISOString()).run();
}

/**
 * Requests a password-reset email. Always answers the same way so a stranger cannot probe
 * which addresses have accounts — the dormant `password_resets` table finally gets used.
 */
export async function POST(request: Request) {
  await ensureSchema();
  if (!isSameOrigin(request)) {
    return Response.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  const { db } = bindings();
  const ip = clientIp(request);
  const body = await request.json().catch(() => ({})) as { email?: unknown };
  const email = normalizeEmail(body.email);

  // Per address slows a targeted attack on one mailbox, per IP slows spraying across many.
  // Held in the database rather than in memory so the count survives a worker recycle.
  const limited = await durableRateLimit(db, `reset:ip:${ip}`, 5, 15 * 60_000)
    ?? await durableRateLimit(db, `reset:email:${email}`, 5, 15 * 60_000);
  if (limited) {
    await recordAttempt(db, email, ip, 'throttled');
    return limited;
  }

  const emailConfig = emailConfiguration();
  if (isValidEmail(email)) {
    const row = await findUserByEmail(db, email);
    if (row && row.status === 'active') {
      const reset = await issuePasswordReset(db, row.id);
      await recordAttempt(db, email, ip, 'reset-request');
      if (emailConfigured(emailConfig)) {
        const sent = await sendEmailViaResend(emailConfig,
          passwordResetEmail(email, passwordResetLinkFor(request, reset.token)));
        // The response stays identical either way - it must, or it becomes an
        // account-existence oracle - so the outcome is recorded rather than returned.
        await recordAttempt(db, email, ip, sent.sent ? 'email-sent' : 'email-failed');
      } else if (isLocalBootstrapRequest(request)) {
        // Local-only convenience, mirroring registration: with no sender configured there is
        // no email to click, so the token is handed back on loopback.
        return Response.json({ ok: true, resetToken: reset.token });
      }
    }
  }
  return Response.json({ ok: true });
}
