import { authSecrets, bindings } from '@/db/runtime';
import { isSameOrigin, readCookie, readSessionValue } from './auth';
import { findUserById, userFromRow, type UserRecord } from './users';

// Rate limiting lives in lib/rate-limit.ts — a pure module with no runtime imports, so unit tests
// can import it directly under Node. Routes keep importing the helpers from here unchanged.
export { durableRateLimit, nativeRateLimit, rateLimit, type NativeRateLimiter } from './rate-limit';

export interface Session {
  user: UserRecord;
  db: D1Database;
}

export type Guarded = { session: Session; response?: never } | { session?: never; response: Response };

/**
 * Every API route starts here. The app is closed by default: no valid session means no data, and a
 * missing signing secret refuses to serve rather than falling open, so a half-configured deployment
 * cannot expose anybody's saved jobs.
 */
export async function requireSession(request: Request, options: { adminOnly?: boolean } = {}): Promise<Guarded> {
  const { sessionSecret } = authSecrets();
  if (!sessionSecret) {
    return { response: Response.json({ error: 'This installation is not configured. Set SESSION_SECRET and restart.' }, { status: 503 }) };
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
    return { response: Response.json({ error: 'Cross-origin request refused.' }, { status: 403 }) };
  }

  const claims = await readSessionValue(readCookie(request), sessionSecret);
  if (!claims) return { response: Response.json({ error: 'Sign in to continue.' }, { status: 401 }) };

  const { db } = bindings();
  const row = await findUserById(db, claims.userId);
  // A cookie issued before the account's epoch was raised is refused, which is what makes
  // "sign out everywhere" and a post-breach revocation actually take effect.
  if (row && (row.session_epoch ?? 1) !== claims.epoch) {
    return { response: Response.json({ error: 'This session has been signed out.' }, { status: 401 }) };
  }
  // Re-read the account on every request so disabling someone takes effect immediately rather than
  // waiting for their cookie to expire.
  if (!row || row.status !== 'active') {
    return { response: Response.json({ error: 'This account is not active.' }, { status: 403 }) };
  }
  const user = userFromRow(row);
  if (options.adminOnly && user.role !== 'admin') {
    return { response: Response.json({ error: 'Administrator access required.' }, { status: 403 }) };
  }
  return { session: { user, db } };
}

export function clientIp(request: Request) {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'local';
}
