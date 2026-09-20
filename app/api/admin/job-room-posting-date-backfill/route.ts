import { ensureSchema } from '@/db/runtime';
import { rateLimit, requireSession } from '@/lib/guard';
import { backfillJobRoomPostingDates } from '@/lib/job-room-backfill';

export async function POST(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db, user } = session;
  const limited = rateLimit(`job-room-posted-at-backfill:${user.id}`, 4, 60 * 60_000);
  if (limited) return limited;

  const report = await backfillJobRoomPostingDates(db, user.id);
  return Response.json(report);
}
