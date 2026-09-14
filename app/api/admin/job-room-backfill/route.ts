import { ensureSchema } from '@/db/runtime';
import { rateLimit, requireSession } from '@/lib/guard';
import { backfillJobRoomDescriptions } from '@/lib/job-room-backfill';

export async function POST(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db, user } = session;
  const limited = rateLimit(`job-room-backfill:${user.id}`, 4, 60 * 60_000);
  if (limited) return limited;

  const report = await backfillJobRoomDescriptions(db, user.id);
  return Response.json(report);
}
