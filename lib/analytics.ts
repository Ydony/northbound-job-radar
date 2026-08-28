/**
 * Visit counting with no tracking.
 *
 * The only questions answered are "how many visits today" and "how many distinct people". No IP,
 * user agent, page, referrer or account is ever stored. Same-day de-duplication uses a marker
 * derived from a secret that changes every day, and yesterday's markers are deleted as soon as the
 * day rolls over, so two visits by the same person on different days cannot be connected and a
 * marker cannot be worked back to a person.
 */

const encoder = new TextEncoder();

export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * A truncated HMAC over the day plus a coarse client fingerprint. Truncation is deliberate: it is
 * enough to de-duplicate a day's traffic while making the value ambiguous between visitors.
 */
export async function visitMarker(day: string, ip: string, userAgent: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(`${secret}:${day}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ip}|${userAgent}`));
  return [...new Uint8Array(signature).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface DailyVisits {
  day: string;
  totalVisits: number;
  uniqueVisitors: number;
}

/** Records one visit. Safe to call on every page load; failures are swallowed so counting can never break a page. */
export async function recordVisit(db: D1Database, ip: string, userAgent: string, secret: string, now = new Date()) {
  const day = dayKey(now);
  const marker = await visitMarker(day, ip, userAgent, secret);
  try {
    // Retaining only today's markers is what keeps this non-trackable.
    await db.prepare('DELETE FROM visit_markers WHERE day < ?').bind(day).run();
    const inserted = await db.prepare('INSERT OR IGNORE INTO visit_markers (day, marker) VALUES (?, ?)')
      .bind(day, marker).run();
    const isNewVisitor = (inserted.meta.changes ?? 0) > 0;
    await db.prepare(`INSERT INTO daily_visits (day, total_visits, unique_visitors) VALUES (?, 1, ?)
      ON CONFLICT(day) DO UPDATE SET total_visits = total_visits + 1,
        unique_visitors = unique_visitors + ?`)
      .bind(day, isNewVisitor ? 1 : 0, isNewVisitor ? 1 : 0).run();
  } catch {
    // Counting is never worth failing a request over.
  }
}

export async function readDailyVisits(db: D1Database, days = 30): Promise<DailyVisits[]> {
  const rows = await db.prepare('SELECT day, total_visits, unique_visitors FROM daily_visits ORDER BY day DESC LIMIT ?')
    .bind(days).all<{ day: string; total_visits: number; unique_visitors: number }>();
  return rows.results.map((row) => ({
    day: row.day,
    totalVisits: row.total_visits,
    uniqueVisitors: row.unique_visitors,
  }));
}
