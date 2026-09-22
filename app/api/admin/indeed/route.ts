import { ensureSchema, indeedConfiguration } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { indeedCoverage, indeedStatus } from '@/lib/indeed/collection';

/** Read-only readiness plus the caller's own per-query coverage. This check never spends an upstream request. */
export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const config = indeedConfiguration(request, true);
  if (!config.access.localExecution) return Response.json({ error: 'Local access only.' }, { status: 403 });
  return Response.json({ ...(await indeedStatus(session.db, config)), coverage: await indeedCoverage(session.db, session.user.id) },
    { headers: { 'cache-control': 'no-store' } });
}
