import { bindings, ensureSchema } from '@/db/runtime';
import { hashPassword, isSameOrigin } from '@/lib/auth';
import { consumePasswordReset, markEmailVerified } from '@/lib/email';
<import { clientIp, durableRateLimit, noStoreJson } from '@/lib/guard';
import { recordSecurityEvent } from '@/lib/security-events';
import { findUserById, passwordProblem, revokeSessions } from '@/lib/users';

async function recordAttempt(db: D1Database, email: string, ip: string, kind: string) {
  await recordSecurityEvent(db, { email, ip, kind });
}

/**
 * Redeems a reset link for a new password. The token works once: it is deleted before it is
 * honoured, so a replayed link is already gone. A successful reset also proves the address,
 * so the account leaves verified.
 */
export async function POST(request: Request) {
  await ensureSchema();
  if (!isSameOrigin(request)) {
    return noStoreJson({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  const { db } = bindings();
  const ip = clientIp(request);
  const limited = await durableRateLimit(db, `reset-confirm:ip:${ip}`, 10, 15 * 60_000);
  if (limited) {
    await recordAttempt(db, '', ip, 'throttled');
    return limited;
  }

  const body = await request.json().catch(() => ({})) as { token?: unknown; newPassword?: unknown };
  const token = typeof body.token === 'string' ? body.token : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  const problem = passwordProblem(newPassword);
  if (problem) return noStoreJson({ error: problem }, { status: 400 });
  if (!token) return noStoreJson({ error: 'This link is invalid or has expired.' }, { status: 400 });

  const consumed = await consumePasswordReset(db, token);
  if (!consumed) {
    await recordAttempt(db, '', ip, 'reset-invalid');
    return noStoreJson({ error: 'This link is invalid or has expired.' }, { status: 400 });
  }
  const user = await findUserById(db, consumed.userId);
  // Deliberately the same shape as an invalid link: never reveal the account is gone.
  if (!user || user.status !== 'active') {
    return noStoreJson({ error: 'This link is invalid or has expired.' }, { status: 400 });
  }
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(newPassword), user.id).run();
  // Every other reset link for this account dies with the password change.
  await db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id).run();
  await markEmailVerified(db, user.id);
  // A password chosen through email recovery signs out every other device.
  await revokeSessions(db, user.id);
  await recordAttempt(db, user.email, ip, 'reset-confirm');
  return noStoreJson({ ok: true });
}
