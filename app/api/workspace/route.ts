import { ensureSchema } from '@/db/runtime';
import { ownedDataDeletionStatements } from '@/lib/account-deletion';
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

  await db.batch(ownedDataDeletionStatements(db, user.id));
  return Response.json({ ok: true });
}
