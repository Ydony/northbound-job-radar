import { authSecrets, emailConfiguration, ensureSchema } from '@/db/runtime';
import { createSessionValue, hashPassword, isLocalBootstrapRequest, sessionCookie, verifyPassword } from '@/lib/auth';
import { accountDeletionStatements } from '@/lib/account-deletion';
import { removeUserVacancyState } from '@/lib/catalogue';
import { emailConfigured, issueEmailVerification, sendEmailViaResend, verificationEmail,
  verificationLinkFor } from '@/lib/email';
import { rateLimit, requireSession } from '@/lib/guard';
import { findUserById, findUserByEmail, isValidEmail, normalizeEmail, passwordProblem, revokeSessions } from '@/lib/users';

function isSecureRequest(request: Request) {
  return new URL(request.url).protocol === 'https:'
    || request.headers.get('x-forwarded-proto') === 'https';
}

export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { user } = session;
  return Response.json({ account: user });
}

/** Change email and/or password. Both require the current password, so a borrowed session cannot take over an account. */
export async function PATCH(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;

  const limited = rateLimit(`account:${user.id}`, 10, 15 * 60_000);
  if (limited) return limited;

  const body = await request.json().catch(() => ({})) as {
    currentPassword?: unknown; newEmail?: unknown; newPassword?: unknown;
  };
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id)
    .first<{ password_hash: string }>();
  if (!row || !await verifyPassword(currentPassword, row.password_hash)) {
    return Response.json({ error: 'Your current password is not correct.' }, { status: 403 });
  }

  const updates: string[] = [];
  const bindings: unknown[] = [];
  let changedEmail = '';

  if (body.newEmail !== undefined) {
    const newEmail = normalizeEmail(body.newEmail);
    if (!isValidEmail(newEmail)) return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
    const clash = await findUserByEmail(db, newEmail);
    if (clash && clash.id !== user.id) {
      return Response.json({ error: 'That address is already registered.' }, { status: 409 });
    }
    updates.push('email = ?');
    bindings.push(newEmail);
    // A new address is unproven until it is confirmed, so it starts unverified like a signup.
    if (newEmail !== user.email) {
      updates.push("email_verified_at = ''");
      changedEmail = newEmail;
    }
  }

  if (body.newPassword !== undefined) {
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const problem = passwordProblem(newPassword);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    updates.push('password_hash = ?');
    bindings.push(await hashPassword(newPassword));
  }

  if (!updates.length) return Response.json({ error: 'Nothing to change.' }, { status: 400 });
  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...bindings, user.id).run();
  // Any outstanding reset links become useless once the password changes.
  await db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id).run();

  let verificationEmailSent = false;
  let verificationToken = '';
  if (changedEmail) {
    await db.prepare('DELETE FROM email_verifications WHERE user_id = ?').bind(user.id).run();
    const verification = await issueEmailVerification(db, user.id);
    const emailConfig = emailConfiguration();
    if (emailConfigured(emailConfig)) {
      const sent = await sendEmailViaResend(emailConfig,
        verificationEmail(changedEmail, verificationLinkFor(request, verification.token)));
      verificationEmailSent = sent.sent;
    } else if (isLocalBootstrapRequest(request)) {
      verificationToken = verification.token;
    }
  }

  // Changing the password signs out every other device, then re-issues a cookie for this one.
  await revokeSessions(db, user.id);
  const fresh = await findUserById(db, user.id);
  const { sessionSecret } = authSecrets();
  const refreshed = await createSessionValue(user.id, sessionSecret, fresh?.session_epoch ?? 1);
  return Response.json({
    ok: true,
    ...(changedEmail
      ? { verificationRequired: true, verificationEmailSent,
        ...(verificationToken ? { verificationToken } : {}) }
      : {}),
  }, {
    headers: { 'set-cookie': sessionCookie(refreshed, isSecureRequest(request)) },
  });
}

/** Deletes the account and everything it owns. The last administrator is refused so an installation cannot be locked out. */
export async function DELETE(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;

  const body = await request.json().catch(() => ({})) as { currentPassword?: unknown; confirm?: unknown };
  if (body.confirm !== 'DELETE') {
    return Response.json({ error: 'Account deletion was not confirmed.' }, { status: 400 });
  }
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id)
    .first<{ password_hash: string }>();
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (!row || !await verifyPassword(currentPassword, row.password_hash)) {
    return Response.json({ error: 'Your current password is not correct.' }, { status: 403 });
  }
  if (user.role === 'admin') {
    const admins = await db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'")
      .first<{ total: number }>();
    if ((admins?.total ?? 0) <= 1) {
      return Response.json({ error: 'You are the only administrator. Promote someone else first.' }, { status: 409 });
    }
  }

  await db.batch(accountDeletionStatements(db, user.id, user.email));
  // INT-04 (#163): forget this account's catalogue state. The shared catalogue keeps
  // rows other accounts still hold; only rows nobody holds are removed.
  await removeUserVacancyState(db, user.id);
  return Response.json({ ok: true }, {
    headers: { 'set-cookie': sessionCookie('', isSecureRequest(request), 0) },
  });
}
