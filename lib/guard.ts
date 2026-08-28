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
 * Caps abusive or accidental repetition. A search fans out to every configured source, so repeated
 * calls would hammer third-party sites and burn the Adzuna and Careerjet quotas; sign-in attempts
 * are capped to slow password guessing. In-memory per instance, which is enough here and never
 * blocks on storage.
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
