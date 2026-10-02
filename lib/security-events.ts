/**
 * Minimal security-event log (T44, F12).
 *
 * `auth_events` is the only security log. Each row carries the smallest facts
 * needed to detect abuse after the fact: which address was tried, from which
 * IP, what happened, who did it (administrator actions only), and when.
 * Never job content, passwords, tokens, or provider refusal text — Resend's
 * refusal can quote the address it refused, and this table is not scoped to
 * one account, so the reason stays out (see tests/email.test.ts).
 *
 * Retention comes from T38: 30 days, enforced by the `expire_auth_events`
 * migration and the purge in `db/runtime.ts` `ensureSchema()`. Reads are
 * administrator-only via `GET /api/admin/security-events`.
 */

export const SECURITY_EVENT_RETENTION_DAYS = 30;

/** Every kind this log may hold. Anything else is refused, never stored. */
export const SECURITY_EVENT_KINDS = [
  // Sign-in outcomes.
  'login',
  'failed',
  'register',
  'register-duplicate',
  'unverified',
  // Abuse-limit hits (the lockout signal: the durable limiter refused the attempt).
  'throttled',
  'bot-rejected',
  // Recovery / verification.
  'reset-request',
  'reset-confirm',
  'reset-invalid',
  'verify',
  'verify-invalid',
  // Delivery outcomes only, never the provider's reason.
  'email-sent',
  'email-failed',
  // Self-service credential changes (PATCH /api/account).
  'password-change',
  'email-change',
  // Administrator actions on another account (actor holds the administrator).
  'admin-disable',
  'admin-enable',
  'admin-promote',
  'admin-demote',
  'admin-set-password',
  'admin-delete-account',
] as const;

export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

const KIND_SET = new Set<string>(SECURITY_EVENT_KINDS);

export function isSecurityEventKind(value: string): value is SecurityEventKind {
  return KIND_SET.has(value);
}

export interface SecurityEvent {
  id: string;
  email: string;
  ip: string;
  kind: string;
  actor: string;
  createdAt: string;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Parses rows written before the `actor` column existed, when administrator
 * actions were stored as `admin:<action> by <actor>` inside `kind`.
 */
export function normalizeSecurityEvent(row: {
  id: string;
  email: string;
  ip: string;
  kind: string;
  actor?: string | null;
  created_at: string;
}): SecurityEvent {
  const legacy = row.kind.match(/^admin:([a-z-]+) by (.+)$/);
  if (legacy && !row.actor) {
    return {
      id: row.id,
      email: row.email,
      ip: row.ip,
      kind: `admin-${legacy[1]}`,
      actor: legacy[2],
      createdAt: row.created_at,
    };
  }
  return {
    id: row.id,
    email: row.email,
    ip: row.ip,
    kind: row.kind,
    actor: row.actor ?? '',
    createdAt: row.created_at,
  };
}

export interface RecordSecurityEventInput {
  email?: string;
  ip?: string;
  kind: string;
  /** Administrator who performed the action; empty for self-service events. */
  actor?: string;
}

/**
 * Records one minimal security event. Refuses unknown kinds so a typo can
 * never silently widen this log, and truncates identifiers so an oversized
 * input cannot bloat the table. Never pass passwords, tokens, or refusal
 * text here — the allow-list keeps the shape minimal, the caller keeps the
 * content minimal.
 */
export async function recordSecurityEvent(
  db: D1Database,
  input: RecordSecurityEventInput,
): Promise<void> {
  if (!isSecurityEventKind(input.kind)) {
    throw new Error(`Refusing to log unknown security event kind: ${input.kind}`);
  }
  const email = truncate(input.email ?? '', 320);
  const ip = truncate(input.ip ?? '', 64);
  const actor = truncate(input.actor ?? '', 320);
  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        'INSERT INTO auth_events (id, email, ip, kind, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(id, email, ip, input.kind, actor, stamp)
      .run();
  } catch {
    // Databases upgraded before migration 32 have no `actor` column yet; the
    // migration backfills it on the next boot, but an event happening on this
    // boot must not be lost. Administrator attribution for those rows falls
    // back to the legacy `admin:<action> by <actor>` kind encoding.
    const legacyKind = actor ? input.kind.replace(/^admin-/, 'admin:') + ` by ${actor}` : input.kind;
    await db
      .prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, email, ip, legacyKind, stamp)
      .run();
  }
}

export interface SecurityAlert {
  level: 'burst' | 'watch';
  key: string;
  message: string;
  count: number;
  windowMinutes: number;
}

interface BurstRule {
  key: string;
  message: string;
  kinds: readonly string[];
  threshold: number;
  windowMinutes: number;
  level: SecurityAlert['level'];
}

/**
 * Burst rules for the alert path. Thresholds are deliberately low because this
 * is a small installation: ten failed sign-ins in 15 minutes is not normal use
 * here, and five token guesses is someone working through a list.
 */
export const SECURITY_BURST_RULES: BurstRule[] = [
  {
    key: 'failed-signin-burst',
    message: 'Many failed sign-ins in a short window — possible password guessing.',
    kinds: ['failed'],
    threshold: 10,
    windowMinutes: 15,
    level: 'burst',
  },
  {
    key: 'throttle-burst',
    message: 'Rate limits are firing repeatedly — an automated caller is being held back.',
    kinds: ['throttled'],
    threshold: 5,
    windowMinutes: 15,
    level: 'burst',
  },
  {
    key: 'token-probing',
    message: 'Many invalid verification/reset links — possible token guessing.',
    kinds: ['reset-invalid', 'verify-invalid'],
    threshold: 5,
    windowMinutes: 15,
    level: 'burst',
  },
  {
    key: 'admin-action-burst',
    message: 'Unusually many administrator actions in an hour — confirm they were intended.',
    kinds: [
      'admin-disable',
      'admin-enable',
      'admin-promote',
      'admin-demote',
      'admin-set-password',
      'admin-delete-account',
    ],
    threshold: 5,
    windowMinutes: 60,
    level: 'watch',
  },
];

/**
 * Counts recent rows per rule and returns the rules currently firing. Reads
 * only counts, never row contents, so the alert check itself discloses nothing.
 * Legacy `admin:<action> by <actor>` rows are matched with a LIKE prefix.
 */
export async function evaluateSecurityAlerts(db: D1Database, now = Date.now()): Promise<SecurityAlert[]> {
  const alerts: SecurityAlert[] = [];
  for (const rule of SECURITY_BURST_RULES) {
    const since = new Date(now - rule.windowMinutes * 60 * 1000).toISOString();
    let count = 0;
    for (const kind of rule.kinds) {
      if (kind.startsWith('admin:')) continue;
      if (kind.startsWith('admin-')) {
        // Matches both the current `admin-*` kinds and legacy `admin:* by *` rows.
        const legacyPrefix = kind.replace(/^admin-/, 'admin:');
        const row = await db
          .prepare(
            `SELECT COUNT(*) AS total FROM auth_events WHERE created_at >= ? AND (kind = ? OR kind LIKE ?)`,
          )
          .bind(since, kind, `${legacyPrefix}%`)
          .first<{ total: number }>();
        count += row?.total ?? 0;
      } else {
        const row = await db
          .prepare('SELECT COUNT(*) AS total FROM auth_events WHERE created_at >= ? AND kind = ?')
          .bind(since, kind)
          .first<{ total: number }>();
        count += row?.total ?? 0;
      }
    }
    if (count >= rule.threshold) {
      alerts.push({
        level: rule.level,
        key: rule.key,
        message: rule.message,
        count,
        windowMinutes: rule.windowMinutes,
      });
    }
  }
  return alerts;
}
