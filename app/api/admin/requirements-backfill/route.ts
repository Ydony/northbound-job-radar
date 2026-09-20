import { ensureSchema } from '@/db/runtime';
import { rateLimit, requireSession } from '@/lib/guard';
import { backfillFlattenedDescriptions } from '@/lib/requirements-backfill';

/**
 * Administrator-only maintenance, mirroring the Job-Room backfill (#29).
 *
 * It re-reads employer boards, so it is not something an ordinary account may trigger, and the
 * hourly limit is what stops a repeated press turning a maintenance pass into a source of load.
 * The work is scoped to the calling administrator's own rows; it never touches another account.
 */
export async function POST(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db, user } = session;
  const limited = rateLimit(`requirements-backfill:${user.id}`, 4, 60 * 60_000);
  if (limited) return limited;

  const report = await backfillFlattenedDescriptions(db, user.id);
  return Response.json(report);
}
