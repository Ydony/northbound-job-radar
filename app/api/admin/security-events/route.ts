import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { detectSecurityBursts, isSecurityEventKind, SECURITY_BURST_WINDOW_MINUTES,
  SECURITY_EVENT_RETENTION_DAYS, type SecurityEvent } from '@/lib/security-events';

/**
 * Minimal security-event reader, administrator only (T44).
 *
 * Returns the most recent `auth_events` rows — the address tried, the client
 * address, what happened, and when — plus the burst summary that is the alert
 * path. There is deliberately no detail column anywhere in this table, so there
 * is no job content, token, password or refusal text to leak; ordinary accounts
 * are refused before any row is read.
 *
 * Query parameters (all optional):
 * - `limit`: rows returned, default 100, capped at 500.
 * - `kind`: restrict to one allowlisted kind (or one legacy `admin:*` action).
 * - `since`: ISO timestamp; only rows at or after it are returned.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db } = session;

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const kind = url.searchParams.get('kind') ?? '';
  if (kind !== '' && !isSecurityEventKind(kind)) {
    return Response.json({ error: 'Unknown event kind.' }, { status: 400 });
  }
  const since = url.searchParams.get('since') ?? '';
  if (since !== '' && Number.isNaN(Date.parse(since))) {
    return Response.json({ error: 'The since timestamp is not valid.' }, { status: 400 });
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (kind !== '') {
    conditions.push('kind = ?');
    values.push(kind);
  }
  if (since !== '') {
    conditions.push('created_at >= ?');
    values.push(new Date(since).toISOString());
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const events = await db.prepare(
    `SELECT id, email, ip, kind, created_at FROM auth_events ${where} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...values, limit).all<SecurityEvent>();

  // The burst summary scans the recent window, not just the returned page, so a
  // narrow `kind`/`since` filter cannot hide an ongoing burst from the reader.
  const windowStart = new Date(Date.now() - 60 * 60_000).toISOString();
  const recent = await db.prepare(
    'SELECT email, ip, kind, created_at FROM auth_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 2000',
  ).bind(windowStart).all<Pick<SecurityEvent, 'email' | 'ip' | 'kind' | 'created_at'>>();

  return Response.json({
    events: events.results,
    retention: {
      days: SECURITY_EVENT_RETENTION_DAYS,
      note: `Security events hold the address tried, the client address, what happened, and when — never job content or secrets — and are automatically deleted after ${SECURITY_EVENT_RETENTION_DAYS} days.`,
    },
    alerts: detectSecurityBursts(recent.results),
    burstWindowMinutes: SECURITY_BURST_WINDOW_MINUTES,
  });
}
