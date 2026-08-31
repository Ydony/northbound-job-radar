import { NextResponse } from 'next/server';
import { authSecrets, bindings } from '@/db/runtime';
import { isSameOrigin, readCookie, readSessionValue } from './auth';
import { findUserById, userFromRow, type UserRecord } from './users';

export interface Session {
  user: UserRecord;
  db: D1Database;
  files: R2Bucket;
}

export type Guarded = { session: Session; response?: never } | { session?: never; response: NextResponse };

/**
 * Every API route starts here. The app is closed by default: no valid session means no data, and a
 * missing signing secret refuses to serve rather than falling open, so a half-configured deployment
 * cannot expose anybody's CV.
 */
export async function requireSession(request: Request, options: { adminOnly?: boolean } = {}): Promise<Guarded> {
  const { sessionSecret } = authSecrets();
  if (!sessionSecret) {
    return { response: NextResponse.json({ error: 'This installation is not configured. Set SESSION_SECRET and restart.' }, { status: 503 }) };
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
    return { response: NextResponse.json({ error: 'Cross-origin request refused.' }, { status: 403 }) };
  }

  const claims = await readSessionValue(readCookie(request), sessionSecret);
  if (!claims) return { response: NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 }) };

  const { db, files } = bindings();
  const row = await findUserById(db, claims.userId);
  // A cookie issued before the account's epoch was raised is refused, which is what makes
  // "sign out everywhere" and a post-breach revocation actually take effect.
  if (row && (row.session_epoch ?? 1) !== claims.epoch) {
    return { response: NextResponse.json({ error: 'This session has been signed out.' }, { status: 401 }) };
  }
  // Re-read the account on every request so disabling someone takes effect immediately rather than
  // waiting for their cookie to expire.
  if (!row || row.status !== 'active') {
    return { response: NextResponse.json({ error: 'This account is not active.' }, { status: 403 }) };
  }
  const user = userFromRow(row);
  if (options.adminOnly && user.role !== 'admin') {
    return { response: NextResponse.json({ error: 'Administrator access required.' }, { status: 403 }) };
  }
  return { session: { user, db, files } };
}

interface RateWindow {
  count: number;
  resetAt: number;
}

const windows = new Map<string, RateWindow>();

export function clientIp(request: Request) {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'local';
}

/**
 * Caps abusive or accidental repetition, in memory.
 *
 * Fast, and enough for the quota-protection cases: a search fans out to every configured source, so
 * repeated calls would hammer third-party sites and burn the Adzuna and Careerjet quotas.
 *
 * **Not enough for sign-in.** These counters live in the worker process and reset whenever it
 * recycles, which on Cloudflare happens routinely and is not something an attacker has to arrange.
 * Against the single account this app has, on a URL about to be posted publicly, a counter that
 * forgets is close to no counter at all. Use `durableRateLimit` there.
 */
export function rateLimit(key: string, limit: number, windowMs: number): NextResponse | null {
  const now = Date.now();
  if (windows.size > 5000) {
    for (const [entry, window] of windows) if (window.resetAt <= now) windows.delete(entry);
  }
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (current.count >= limit) {
    const retryAfter = Math.ceil((current.resetAt - now) / 1000);
    return NextResponse.json(
      { error: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.` },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }
  current.count += 1;
  return null;
}


interface RateLimitRow {
  count: number;
  reset_at: number;
}

/**
 * The same cap, held in the database so it survives the worker recycling.
 *
 * Used for sign-in, where forgetting the count is the whole problem: an attempt spread across
 * process restarts would never have reached the in-memory limit. Every other caller is protecting
 * a quota rather than an account and can keep the cheaper in-memory version.
 *
 * Fails **open** on a database error. That is a deliberate trade: a rate limiter that takes the
 * application down when storage hiccups turns a minor fault into an outage, and sign-in is also
 * protected by password hashing that is deliberately slow. It is a second line, not the only one.
 */
export async function durableRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
): Promise<NextResponse | null> {
  const now = Date.now();
  try {
    const existing = await db.prepare('SELECT count, reset_at FROM rate_limits WHERE bucket = ?')
      .bind(key).first<RateLimitRow>();

    if (!existing || existing.reset_at <= now) {
      await db.prepare(`INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
        ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at`)
        .bind(key, now + windowMs).run();
      // Clear expired rows opportunistically rather than on a schedule, and only when a window
      // rolls over, so the sweep is rare and never runs on the hot path of a blocked attempt.
      await db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now).run();
      return null;
    }

    if (existing.count >= limit) {
      const retryAfter = Math.ceil((existing.reset_at - now) / 1000);
      return NextResponse.json(
        { error: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.` },
        { status: 429, headers: { 'retry-after': String(retryAfter) } },
      );
    }

    await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?').bind(key).run();
    return null;
  } catch {
    return null;
  }
}
