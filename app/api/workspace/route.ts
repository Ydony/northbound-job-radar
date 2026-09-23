import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';

export async function DELETE(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.confirm !== 'RESET') {
    return Response.json({ error: 'Workspace reset was not confirmed.' }, { status: 400 });
  }

  await db.batch([
    db.prepare('DELETE FROM language_feedback WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM jobs WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM search_settings WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM search_roles WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM indeed_settings WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM indeed_coverage WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM dismissed_jobs WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM rejected_listings WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM search_run_sources WHERE run_id IN (SELECT id FROM search_runs WHERE user_id = ?)').bind(user.id),
    db.prepare('DELETE FROM search_runs WHERE user_id = ?').bind(user.id),
  ]);
  return Response.json({ ok: true });
}
