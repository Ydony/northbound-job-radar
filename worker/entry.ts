/**
 * Worker entry: the vinext app's fetch handler plus the INT-06 (#165) bounded
 * public-refresh scheduled handler.
 *
 * Cloudflare delivers Cron Trigger ticks to the `scheduled` export of the
 * worker entry, and this project's entry is otherwise the vinext app router.
 * This wrapper keeps that fetch behavior untouched and adds the refresh tick
 * beside it. The tick itself lives in `lib/public-refresh-scheduler.ts` and is
 * fail-closed: without `PUBLIC_REFRESH_ENABLED === 'true'` (prod-only, owner
 * supervised) it does nothing, and without owner-configured
 * `PUBLIC_REFRESH_TERMS` it contacts no upstream source.
 *
 * This module runs in the worker only. Unit tests import the scheduler, never
 * this entry (it pulls `db/runtime.ts`, which needs the worker runtime).
 */
import vinextEntry from 'vinext/server/app-router-entry';
import { ensureSchema } from '../db/runtime';
import { handlePublicRefreshCron, parseRefreshTerms } from '../lib/public-refresh-scheduler';

export default {
  fetch: vinextEntry.fetch,
  scheduled(_event: ScheduledEvent, env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await ensureSchema();
      return handlePublicRefreshCron({
        db: env.DB,
        enabled: env.PUBLIC_REFRESH_ENABLED === 'true',
        terms: parseRefreshTerms(env.PUBLIC_REFRESH_TERMS),
      });
    })());
  },
};
