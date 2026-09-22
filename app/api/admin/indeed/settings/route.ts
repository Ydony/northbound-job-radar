import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { cleanIndeedSettingsInput, indeedSettingsFromRow } from '@/lib/indeed/settings';

/**
 * IND-Next 1: admin-only Indeed place and distance.
 *
 * Account-scoped: every query is WHERE user_id = the session user, so no
 * account can read or modify another's settings by direct API or guessed ID.
 * Ordinary accounts are refused with 403 before any database read; the UI
 * (#116) and /api/state likewise withhold these settings from them.
 *
 * Kilometres are the stored and user-facing unit; collection converts to the
 * provider's integer miles. Environment state stays isolated because dev and
 * test use separate D1 files; nothing here copies between them.
 */
export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db, user } = session;
  const row = await db.prepare(
    'SELECT nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at FROM indeed_settings WHERE user_id = ?')
    .bind(user.id).first<{
      nl_location: unknown; nl_radius_km: unknown; ch_location: unknown; ch_radius_km: unknown; updated_at: unknown;
    }>().catch(() => null);
  return Response.json({ settings: indeedSettingsFromRow(row) },
    { headers: { 'cache-control': 'no-store' } });
}

export async function PUT(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db, user } = session;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  let cleaned;
  try {
    cleaned = cleanIndeedSettingsInput(body);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Invalid Indeed settings.' }, { status: 400 });
  }
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO indeed_settings (user_id, nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET nl_location = excluded.nl_location,
      nl_radius_km = excluded.nl_radius_km, ch_location = excluded.ch_location,
      ch_radius_km = excluded.ch_radius_km, updated_at = excluded.updated_at`)
    .bind(user.id, cleaned.nlLocation, cleaned.nlRadiusKm, cleaned.chLocation, cleaned.chRadiusKm, now).run();
  const row = await db.prepare(
    'SELECT nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at FROM indeed_settings WHERE user_id = ?')
    .bind(user.id).first<{
      nl_location: unknown; nl_radius_km: unknown; ch_location: unknown; ch_radius_km: unknown; updated_at: unknown;
    }>();
  return Response.json({ settings: indeedSettingsFromRow(row) });
}
