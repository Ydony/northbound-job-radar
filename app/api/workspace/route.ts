import { ensureSchema } from '@/db/runtime';
import { ownedDataDeletionStatements } from '@/lib/account-deletion';
import { removeUserVacancyState } from '@/lib/catalogue';
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
  // INT-04 (#163): forget this account's catalogue state. Catalogue rows another
  // account still holds survive; rows nobody holds are removed.
  await removeUserVacancyState(db, user.id);
  return Response.json({ ok: true });
}
