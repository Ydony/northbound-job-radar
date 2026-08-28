import { NextResponse } from 'next/server';
import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';

export async function DELETE(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user, files } = session;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.confirm !== 'RESET') {
    return NextResponse.json({ error: 'Workspace reset was not confirmed.' }, { status: 400 });
  }

  const cvs = await db.prepare('SELECT object_key FROM cvs WHERE user_id = ?').bind(user.id).all<{ object_key: string }>();
  const objectKeys = cvs.results.map((cv) => cv.object_key).filter(Boolean);
  if (objectKeys.length) await files.delete(objectKeys);
  await db.batch([
    db.prepare('DELETE FROM language_feedback WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM jobs WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM cvs WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM search_settings WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM search_roles WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM dismissed_jobs WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM search_run_sources WHERE run_id IN (SELECT id FROM search_runs WHERE user_id = ?)').bind(user.id),
    db.prepare('DELETE FROM search_runs WHERE user_id = ?').bind(user.id),
  ]);
  return NextResponse.json({ ok: true });
}
