import { authSecrets, bindings, emailConfiguration, ensureSchema, turnstileSecrets } from '@/db/runtime';
import { clearedSessionCookie, createSessionValue, isLocalBootstrapRequest, isSameOrigin, sessionCookie } from '@/lib/auth';
import { emailConfigured, issueEmailVerification, sendEmailViaResend, verificationEmail,
  verificationLinkFor } from '@/lib/email';
import { clientIp, durableRateLimit, nativeRateLimit } from '@/lib/guard';
import { TURNSTILE_TEST_SECRET_ALWAYS_PASS, verifyTurnstileToken } from '@/lib/turnstile';
import { authenticate, countUsers, createUser, findUserByEmail, isValidEmail, normalizeEmail,
  passwordProblem, touchLastSeen } from '@/lib/users';

function isSecureRequest(request: Request) {
  return new URL(request.url).protocol === 'https:'
    || request.headers.get('x-forwarded-proto') === 'https';
}

async function recordAttempt(db: D1Database, email: string, ip: string, kind: string) {
  await db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), email, ip, kind, new Date().toISOString()).run();
}

/**
 * Turnstile bot check for registration (#171). The secret key is owner-set and read from the
 * environment only; without one the committed test keys stand in, and those accept everyone, so
 * they are honored on this computer alone. A non-local host without a real secret refuses
 * registration rather than pretending to check bots. Returns a refusal response, or null to
 * continue. Fails closed: an unverifiable token never registers.
 */
async function verifyRegistrationBot(
  request: Request,
  db: D1Database,
  email: string,
  ip: string,
  token: unknown,
): Promise<Response | null> {
  const { secretKey } = turnstileSecrets();
  if (!secretKey && !isLocalBootstrapRequest(request)) {
    return Response.json({ error: 'Registration is not available on this installation.' }, { status: 503 });
  }
  const verification = await verifyTurnstileToken(token, {
    secretKey: secretKey || TURNSTILE_TEST_SECRET_ALWAYS_PASS,
    remoteIp: ip,
  });
  if (!verification.ok) {
    await recordAttempt(db, email, ip, 'bot-rejected');
    return Response.json({ error: 'The bot check did not pass. Reload and try again.' }, { status: 400 });
  }
  return null;
}

export async function POST(request: Request) {
  await ensureSchema();
  if (!isSameOrigin(request)) {
    return Response.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  const { sessionSecret } = authSecrets();
  if (!sessionSecret) {
    return Response.json({ error: 'This installation is not configured. Set SESSION_SECRET and restart.' }, { status: 503 });
  }

  const ip = clientIp(request);
  const body = await request.json().catch(() => ({})) as { email?: unknown; password?: unknown; action?: unknown; turnstileToken?: unknown };
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const action = body.action === 'register' ? 'register' : 'login';
  const { db, authRateLimiter } = bindings();

  // Three layers, cheapest first. The native edge limiter brakes bursts per location without a
  // database round trip; the two database buckets below keep the exact 15-minute budgets — per
  // address to slow a targeted attack on one account, per IP to slow spraying across many.
  // Registration is capped hardest because it is the only endpoint that creates state.
  // Either layer can refuse on its own. Held in the database rather than in memory. These
  // counters used to reset whenever the worker recycled, which on Cloudflare is routine and
  // needs no help from an attacker - so an attempt spread over restarts would never have
  // reached the limit at all.
  const edgeLimited = await nativeRateLimit(authRateLimiter, `auth:${ip}`);
  if (edgeLimited) {
    await recordAttempt(db, email, ip, 'throttled');
    return edgeLimited;
  }
  const limited = await durableRateLimit(db, `auth:ip:${ip}`, action === 'register' ? 5 : 20, 15 * 60_000)
    ?? await durableRateLimit(db, `auth:email:${email}`, 10, 15 * 60_000);
  if (limited) {
    await recordAttempt(db, email, ip, 'throttled');
    return limited;
  }

  if (!isValidEmail(email)) return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });

  if (action === 'register') {
    const problem = passwordProblem(password);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const botCheck = await verifyRegistrationBot(request, db, email, ip, body.turnstileToken);
    if (botCheck) return botCheck;
    // Registration is closed by default once the owner exists, so a public deployment cannot be
    // signed up to by strangers. Set ALLOW_SIGNUPS=true to open it.
    const existing = await countUsers(db);
    if (existing === 0 && !isLocalBootstrapRequest(request)) {
      // Otherwise the first stranger to discover an empty hosted database becomes its admin,
      // even though registration is "closed". Hosting needs an out-of-band admin bootstrap.
      return Response.json({ error: 'Administrator setup is available only on this computer.' }, { status: 403 });
    }
    if (existing > 0 && (authSecrets().allowSignups ?? '') !== 'true') {
      return Response.json({ error: 'Registration is closed on this installation.' }, { status: 403 });
    }
    if (await findUserByEmail(db, email)) {
      // Deliberately the same shape as a successful registration: telling a stranger which
      // addresses already have accounts is an enumeration oracle.
      await recordAttempt(db, email, ip, 'register-duplicate');
      return Response.json({ error: 'That address cannot be registered. If it is yours, sign in instead.' }, { status: 400 });
    }
    const { user, claimedLegacyWorkspace } = await createUser(db, email, password);
    await recordAttempt(db, email, ip, 'register');
    if (user.emailVerified) {
      // The installer account only: created on this computer, with remote first-signup
      // blocked, so there is no address to prove. It signs straight in as before.
      const value = await createSessionValue(user.id, sessionSecret, user.sessionEpoch);
      return Response.json({ ok: true, role: user.role, claimedLegacyWorkspace }, {
        headers: { 'set-cookie': sessionCookie(value, isSecureRequest(request)) },
      });
    }
    // Every later account starts unverified and gets no session until the address is
    // confirmed through the emailed token. Sending is best-effort: without a configured
    // sender the account still exists and the caller is told the email did not go out.
    const verification = await issueEmailVerification(db, user.id);
    const emailConfig = emailConfiguration();
    let verificationEmailSent = false;
    if (emailConfigured(emailConfig)) {
      const sent = await sendEmailViaResend(emailConfig,
        verificationEmail(email, verificationLinkFor(request, verification.token)));
      verificationEmailSent = sent.sent;
    }
    return Response.json({
      ok: true,
      verificationRequired: true,
      verificationEmailSent,
      // Local-only convenience: with no sender configured there is no email to click, so the
      // token is handed back on loopback. Never present on a reachable host.
      ...(!emailConfigured(emailConfig) && isLocalBootstrapRequest(request)
        ? { verificationToken: verification.token }
        : {}),
    });
  }

  // A login token is verified only when the owner configured a real secret: the login form
  // carries no bot widget, so a token here is an opt-in hardening signal, not a requirement.
  if (typeof body.turnstileToken === 'string' && body.turnstileToken.length > 0) {
    const { secretKey } = turnstileSecrets();
    if (secretKey) {
      const check = await verifyTurnstileToken(body.turnstileToken, { secretKey, remoteIp: ip });
      if (!check.ok) return Response.json({ error: 'The bot check did not pass. Reload and try again.' }, { status: 400 });
    }
  }

  const user = await authenticate(db, email, password);
  if (!user) {
    await recordAttempt(db, email, ip, 'failed');
    // Deliberately vague: never reveal whether the address exists or the account is disabled.
    return Response.json({ error: 'Incorrect email or password.' }, { status: 401 });
  }
  if (!user.emailVerified) {
    // The password was right, so this caller owns the credential — telling them the address
    // is unconfirmed reveals nothing to a stranger. Unverified accounts get no session.
    await recordAttempt(db, email, ip, 'unverified');
    return Response.json({
      error: 'Check your email for a verification link before signing in.',
      needsVerification: true,
    }, { status: 403 });
  }
  await Promise.all([touchLastSeen(db, user.id), recordAttempt(db, email, ip, 'login')]);
  const value = await createSessionValue(user.id, sessionSecret, user.sessionEpoch);
  return Response.json({ ok: true, role: user.role }, {
    headers: { 'set-cookie': sessionCookie(value, isSecureRequest(request)) },
  });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  return Response.json({ ok: true }, {
    headers: { 'set-cookie': clearedSessionCookie(isSecureRequest(request)) },
  });
}
