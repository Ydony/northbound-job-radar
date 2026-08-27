import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';

export async function DELETE(request: Request) {
  await ensureSchema();
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.confirm !== 'RESET') {
    return NextResponse.json({ error: 'Workspace reset was not confirmed.' }, { status: 400 });
  }

  const { db, files } = bindings();
  const cvs = await db.prepare('SELECT object_key FROM cvs').all<{ object_key: string }>();
  const objectKeys = cvs.results.map((cv) => cv.object_key).filter(Boolean);
  if (objectKeys.length) await files.delete(objectKeys);
  await db.batch([
    db.prepare('DELETE FROM language_feedback'),
    db.prepare('DELETE FROM jobs'),
    db.prepare('DELETE FROM cvs'),
    db.prepare('DELETE FROM search_settings'),
  ]);
  return NextResponse.json({ ok: true });
}
