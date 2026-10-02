/**
 * Minimal security-event log (T44).
 *
 * `auth_events` already recorded sign-in outcomes, verification/reset outcomes and
 * administrator actions; what was missing was the boundary around it: which kinds
 * may ever be written (so no job content, token, password or refusal text can end
 * up in the table), how long rows live, who may read them, and what counts as a
 * burst worth looking at.
 *
 * - Retention comes from T38: 30 days, enforced by migration 9
 *   (`expire_auth_events`) and the purge in `ensureSchema()` (`db/runtime.ts`).
 *   This module only names the window so the reader endpoint and the privacy
 *   copy cannot drift from it.
 * - Access is administrator-only: the only reader is
 *   `GET /api/admin/security-events`, behind `requireSession(adminOnly)`.
 * - There is no dedicated lockout state; the abuse-limit hit (`throttled`) IS
 *   the lockout signal, and the burst summary below is the alert path.
 *
 * The table carries exactly four facts per row — the address tried, the client
 * address, what happened, and when — plus a random id. There is deliberately no
 * detail column: anything free-form eventually carries a secret or a refusal
 * that quotes one (see `tests/email.test.ts`, "recorded without ever recording
 * the reason").
 */

export const SECURITY_EVENT_RETENTION_DAYS = 30;

/** Window the burst summary looks at. Short enough to page someone, long enough to see spraying. */
export const SECURITY_BURST_WINDOW_MINUTES = 15;

/**
 * Every kind that may be written to `auth_events`. Anything else is refused by
 * `recordSecurityEvent` rather than stored.
 *
 * Administrator actions keep their historical shape (`admin:disable`,
 * `admin:enable`, `admin:promote`, `admin:demote`, `admin:set-password`,
 * `admin:delete-account`, with the actor appended as `admin:<action> by <email>`
 * by `app/api/admin/route.ts`). `isSecurityEventKind` accepts both the bare
 * kind and that legacy attribution suffix; new writes outside the admin route
 * must use the bare kind.
 */
export const SECURITY_EVENT_KINDS = [
  // Sign-in success / failure.
  'login',
  'failed',
  'unverified',
  'register',
  'register-duplicate',
  'bot-rejected',
  // Abuse-limit hits (durable and native limiters, plus the account-route cap).
  'throttled',
  // Recovery and verification outcomes. The token itself is never stored.
  'reset-request',
  'reset-confirm',
  'reset-invalid',
  'verify',
  'verify-invalid',
  // Delivery outcomes only, never the provider's refusal text.
  'email-sent',
  'email-failed',
  // Self-service credential changes (PATCH /api/account).
  'password-change',
  'email-change',
  // Administrator actions on someone else's account.
  'admin:disable',
  'admin:enable',
  'admin:promote',
  'admin:demote',
  'admin:set-password',
  'admin:delete-account',
] as const;

export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

const ADMIN_ACTION_PATTERN = /^admin:(disable|enable|promote|demote|set-password|delete-account)( by .+)?$/;

const KIND_SET = new Set<string>(SECURITY_EVENT_KINDS);

/** True for a bare allowlisted kind or a legacy `admin:<action> by <actor>` attribution. */
export function isSecurityEventKind(kind: string): boolean {
  return KIND_SET.has(kind) || ADMIN_ACTION_PATTERN.test(kind);
}

export interface SecurityEvent {
  id: string;
  email: string;
  ip: string;
  kind: string;
  created_at: string;
}

/**
 * Writes one security event. Refuses unknown kinds rather than storing them, so
 * a future caller cannot smuggle job content, tokens or passwords into the log
 * by inventing a kind. Addresses are truncated to their longest real shape
 * (254 for an email, 45 for an IPv6 address) rather than rejected, so logging
 * itself can never break sign-in.
 */
export async function recordSecurityEvent(
  db: D1Database,
  event: { email: string; ip: string; kind: string },
): Promise<void> {
  if (!isSecurityEventKind(event.kind)) {
    throw new Error(`Refusing to record unknown security-event kind: ${event.kind}`);
  }
  await db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(
      crypto.randomUUID(),
      event.email.slice(0, 254),
      event.ip.slice(0, 45),
      event.kind,
      new Date().toISOString(),
    )
    .run();
}

export interface SecurityBurst {
  /** Machine-readable key, e.g. `failed-logins-for-address`. */
  key: string;
  /** What grouping tripped it, e.g. the address or IP — never a secret. */
  scope: string;
  /** Events counted inside the window. */
  count: number;
  /** ISO timestamp of the window start. */
  windowStart: string;
  /** What the administrator should do about it. */
  advice: string;
}

/**
 * Burst summary over recent rows: the alert path. Thresholds are deliberately
 * high enough that ordinary use never trips them — a handful of mistyped
 * passwords is not an incident — and low enough that password spraying or
 * token guessing stands out:
 *
 * - 10+ failed sign-ins against one address in 15 minutes: targeted guessing.
 * - 20+ failures/throttles from one IP in 15 minutes: spraying across accounts.
 * - 5+ invalid reset/verification tokens from one IP in 60 minutes: token guessing.
 */
export function detectSecurityBursts(
  events: Pick<SecurityEvent, 'email' | 'ip' | 'kind' | 'created_at'>[],
  nowMs: number = Date.now(),
): SecurityBurst[] {
  const bursts: SecurityBurst[] = [];
  const windowStart15 = new Date(nowMs - SECURITY_BURST_WINDOW_MINUTES * 60_000).toISOString();
  const windowStart60 = new Date(nowMs - 60 * 60_000).toISOString();

  const inWindow = (createdAt: string, start: string) => createdAt >= start;

  // Targeted guessing: failures against one address.
  const failedByEmail = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'failed' || !inWindow(event.created_at, windowStart15) || !event.email) continue;
    failedByEmail.set(event.email, (failedByEmail.get(event.email) ?? 0) + 1);
  }
  for (const [email, count] of failedByEmail) {
    if (count >= 10) {
      bursts.push({
        key: 'failed-logins-for-address',
        scope: email,
        count,
        windowStart: windowStart15,
        advice: 'Targeted password guessing against this address. Leave the rate limit in place; consider disabling the account if the owner is unreachable.',
      });
    }
  }

  // Spraying: failures or limit hits from one client address.
  const abuseByIp = new Map<string, number>();
  for (const event of events) {
    if ((event.kind !== 'failed' && event.kind !== 'throttled')
      || !inWindow(event.created_at, windowStart15) || !event.ip) continue;
    abuseByIp.set(event.ip, (abuseByIp.get(event.ip) ?? 0) + 1);
  }
  for (const [ip, count] of abuseByIp) {
    if (count >= 20) {
      bursts.push({
        key: 'abuse-from-address',
        scope: ip,
        count,
        windowStart: windowStart15,
        advice: 'Password spraying or credential stuffing from this address. The rate limit is holding; block the address at the edge if it persists.',
      });
    }
  }

  // Token guessing: invalid single-use links from one address.
  const guessingByIp = new Map<string, number>();
  for (const event of events) {
    if ((event.kind !== 'reset-invalid' && event.kind !== 'verify-invalid')
      || !inWindow(event.created_at, windowStart60) || !event.ip) continue;
    guessingByIp.set(event.ip, (guessingByIp.get(event.ip) ?? 0) + 1);
  }
  for (const [ip, count] of guessingByIp) {
    if (count >= 5) {
      bursts.push({
        key: 'token-guessing-from-address',
        scope: ip,
        count,
        windowStart: windowStart60,
        advice: 'Repeated guessing of single-use recovery links. Tokens are random and hashed at rest; no action needed unless the rate climbs.',
      });
    }
  }

  return bursts.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}
