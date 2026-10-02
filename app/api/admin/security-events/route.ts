import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import {
  evaluateSecurityAlerts,
  isSecurityEventKind,
  normalizeSecurityEvent,
  SECURITY_EVENT_RETENTION_DAYS,
} from '@/lib/security-events';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

interface RawSecurityRow {
  id: string;
  email: string;
  ip: string;
  kind: string;
  actor?: string | null;
  created_at: string;
}

/**
 * Administrator-only security log viewer (T44).
 *
 * Returns minimal events only — id, address tried, IP, what happened, which
 * administrator acted, and when. Never job content, passwords, tokens, or
 * provider refusal text: those are never stored, so they cannot leak here.
 * `alerts` is the burst path: currently firing rules with counts, so a burst
 * of failures or throttles is visible without reading every row.
 */
export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db } = session;

  const url = new URL(request.url);
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const kindFilter = url.searchParams.get('kind') ?? '';
  if (kindFilter !== '' && !isSecurityEventKind(kindFilter)) {
    return Response.json({ error: 'Unknown event kind.' }, { status: 400 });
  }
  const sinceParam = url.searchParams.get('since') ?? '';
  const since = sinceParam !== '' ? new Date(sinceParam) : null;
  if (sinceParam !== '' && (since === null || Number.isNaN(since.getTime()))) {
    return Response.json({ error: 'Invalid since timestamp.' }, { status: 400 });
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (kindFilter !== '') {
    if (kindFilter.startsWith('admin-')) {
      // Both encodings: current `admin-*` rows and legacy `admin:* by *` rows.
      conditions.push('(kind = ? OR kind LIKE ?)');
      values.push(kindFilter, `${kindFilter.replace(/^admin-/, 'admin:')}%`);
    } else {
      conditions.push('kind = ?');
      values.push(kindFilter);
    }
  }
  if (since) {
    conditions.push('created_at >= ?');
    values.push(since.toISOString());
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // One statement per prepare(): the count and the page are separate queries.
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM auth_events ${where}`)
    .bind(...values)
    .first<{ total: number }>();
  const rows = await db
    .prepare(
      `SELECT id, email, ip, kind, created_at FROM auth_events ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...values, limit)
    .all<RawSecurityRow>();

  // Databases upgraded before migration 32 have no `actor` column; the reader
  // understands the legacy kind encoding so old rows still attribute correctly.
  let withActor = rows.results;
  try {
    const actorRows = await db
      .prepare(
        `SELECT id, email, ip, kind, actor, created_at FROM auth_events ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(...values, limit)
      .all<RawSecurityRow>();
    withActor = actorRows.results;
  } catch {
    withActor = rows.results;
  }

  const alerts = await evaluateSecurityAlerts(db);

  return Response.json(
    {
      events: withActor.map((row) => normalizeSecurityEvent(row)),
      total: totalRow?.total ?? withActor.length,
      retention: {
        days: SECURITY_EVENT_RETENTION_DAYS,
        purgedOnBoot: true,
        note: 'Security events hold the address tried, the IP, and what happened — never job content, passwords, tokens, or provider refusal text — and are deleted automatically after 30 days.',
      },
      alerts,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
