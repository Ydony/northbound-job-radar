import { NextResponse } from 'next/server';
import { authSecrets, bindings, ensureSchema } from '@/db/runtime';
import { clearedSessionCookie, createSessionValue, isSameOrigin, sessionCookie } from '@/lib/auth';
import { clientIp, durableRateLimit } from '@/lib/guard';
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

export async function POST(request: Request) {
  await ensureSchema();
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  const { sessionSecret } = authSecrets();
  if (!sessionSecret) {
    return NextResponse.json({ error: 'This installation is not configured. Set SESSION_SECRET and restart.' }, { status: 503 });
  }

  const ip = clientIp(request);
  const body = await request.json().catch(() => ({})) as { email?: unknown; password?: unknown; action?: unknown };
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const action = body.action === 'register' ? 'register' : 'login';
  const { db } = bindings();

  // Two limits: per address slows a targeted attack on one account, per IP slows spraying across
  // many. Registration is capped hardest because it is the only endpoint that creates state.
  // Held in the database rather than in memory. These counters used to reset whenever the worker
  // recycled, which on Cloudflare is routine and needs no help from an attacker - so an attempt
  // spread over restarts would never have reached the limit at all.
  const limited = await durableRateLimit(db, `auth:ip:${ip}`, action === 'register' ? 5 : 20, 15 * 60_000)
    ?? await durableRateLimit(db, `auth:email:${email}`, 10, 15 * 60_000);
  if (limited) {
    await recordAttempt(db, email, ip, 'throttled');
    return limited;
  }

  if (!isValidEmail(email)) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });

  if (action === 'register') {
    const problem = passwordProblem(password);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    // Registration is closed by default once the owner exists, so a public deployment cannot be
    // signed up to by strangers. Set ALLOW_SIGNUPS=true to open it.
    const existing = await countUsers(db);
    if (existing > 0 && (authSecrets().allowSignups ?? '') !== 'true') {
      return NextResponse.json({ error: 'Registration is closed on this installation.' }, { status: 403 });
    }
    if (await findUserByEmail(db, email)) {
      // Deliberately the same shape as a successful registration: telling a stranger which
      // addresses already have accounts is an enumeration oracle.
      await recordAttempt(db, email, ip, 'register-duplicate');
      return NextResponse.json({ error: 'That address cannot be registered. If it is yours, sign in instead.' }, { status: 400 });
    }
    const { user, claimedLegacyWorkspace } = await createUser(db, email, password);
    await recordAttempt(db, email, ip, 'register');
    const value = await createSessionValue(user.id, sessionSecret, user.sessionEpoch);
    return NextResponse.json({ ok: true, role: user.role, claimedLegacyWorkspace }, {
      headers: { 'set-cookie': sessionCookie(value, isSecureRequest(request)) },
    });
  }

  const user = await authenticate(db, email, password);
  if (!user) {
    await recordAttempt(db, email, ip, 'failed');
    // Deliberately vague: never reveal whether the address exists or the account is disabled.
    return NextResponse.json({ error: 'Incorrect email or password.' }, { status: 401 });
  }
  await Promise.all([touchLastSeen(db, user.id), recordAttempt(db, email, ip, 'login')]);
  const value = await createSessionValue(user.id, sessionSecret, user.sessionEpoch);
  return NextResponse.json({ ok: true, role: user.role }, {
    headers: { 'set-cookie': sessionCookie(value, isSecureRequest(request)) },
  });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  return NextResponse.json({ ok: true }, {
    headers: { 'set-cookie': clearedSessionCookie(isSecureRequest(request)) },
  });
}
