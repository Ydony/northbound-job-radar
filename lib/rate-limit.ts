/**
 * Rate limiting: a cheap in-memory cap plus a durable database cap, layered with
 * Cloudflare's native edge Rate Limiting binding where one is configured (#171).
 *
 * This module is deliberately pure: it imports nothing, so unit tests can import it
 * directly under Node. `lib/guard.ts` re-exports the public helpers for routes.
 */

interface RateWindow {
  count: number;
  resetAt: number;
}

const windows = new Map<string, RateWindow>();

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
export function rateLimit(key: string, limit: number, windowMs: number): Response | null {
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
    return Response.json(
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
 * The count is a single atomic `INSERT ... ON CONFLICT ... RETURNING` statement, so concurrent
 * requests cannot both read the same count and both slip under the limit: each attempt takes its
 * own number (1, 2, 3, ...) and only attempts numbered at or below the limit pass. The counter
 * deliberately keeps counting past the limit inside a window, so a rejected attempt is still
 * recorded rather than silently discarded.
 *
 * Fails **closed** on a database error (503). Refusing attempts during a storage fault is the
 * documented trade for an authentication gate: admitting unlimited password guesses because the
 * counter is down would turn a minor fault into an open door. The native edge limiter below stays
 * fail-open, so a fault in one layer never takes sign-in down on its own while the other holds.
 */
export async function durableRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
): Promise<Response | null> {
  const now = Date.now();
  const unavailable = () => Response.json(
    { error: 'The sign-in service is temporarily unavailable. Try again shortly.' },
    { status: 503, headers: { 'retry-after': '60' } },
  );
  try {
    const row = await db.prepare(`INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
      RETURNING count, reset_at`)
      .bind(key, now + windowMs, now, now).first<RateLimitRow>();
    if (!row) return unavailable();

    if (row.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((row.reset_at - now) / 1000));
      return Response.json(
        { error: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.` },
        { status: 429, headers: { 'retry-after': String(retryAfter) } },
      );
    }

    // Clear expired rows opportunistically when this attempt opened a fresh window, so the sweep
    // is rare and never runs on the hot path of a blocked attempt.
    if (row.count === 1) {
      await db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now).run();
    }
    return null;
  } catch {
    return unavailable();
  }
}

/** Structural shape of Cloudflare's native Workers Rate Limiting binding. */
export interface NativeRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The native edge limiter, layered in front of the database limiter on auth endpoints.
 *
 * The binding enforces its counters at the edge, atomically per Cloudflare location, without a
 * database round trip — but it is explicitly permissive and eventually consistent, and its window
 * can only be 10 or 60 seconds, so it cannot express the 15-minute sign-in budgets. It is a burst
 * brake, not the accounting: the database limiter behind it keeps the exact per-address and
 * per-account windows.
 *
 * Fails **open** on a binding error. That is safe only because the database limiter behind it is
 * fail-closed: at least one layer always says no. A missing binding (local development without the
 * `ratelimits` configuration) skips this layer entirely.
 */
export async function nativeRateLimit(
  binding: NativeRateLimiter | null | undefined,
  key: string,
): Promise<Response | null> {
  if (!binding) return null;
  try {
    const outcome = await binding.limit({ key });
    if (outcome?.success === false) {
      return Response.json(
        { error: 'Too many requests. Try again in a minute.' },
        { status: 429, headers: { 'retry-after': '60' } },
      );
    }
    return null;
  } catch {
    return null;
  }
}
