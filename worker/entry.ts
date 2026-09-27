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
 *
 * VPS-04 (#197): the self-hosted counterpart of this tick is
 * `scripts/run-refresh.mjs`, fired by `deploy/ikbeneenappel-refresh.timer` at
 * the same 6-hour cadence. This export stays for the Cloudflare path until
 * cutover (#201) — only one of the two mechanisms must ever be live against
 * the same database.
 */
import vinextEntry from 'vinext/server/app-router-entry';
import { ensureSchema, installRuntimeEnv } from '../db/runtime';
import { handlePublicRefreshCron, parseRefreshTerms } from '../lib/public-refresh-scheduler';

/**
 * VPS-02 (#195): this module is the ONLY place that imports `cloudflare:workers`, and it is
 * never part of the self-hosted bundle. `db/runtime.ts` used to import it directly, which meant
 * the standalone build could not even be loaded by Node — the ESM loader rejects the
 * `cloudflare:` scheme before any application code runs.
 *
 * Installing it at module scope, before the first request is served, keeps every `env.FOO` read
 * in `db/runtime.ts` working exactly as it did.
 */
export default {
  /**
   * Cloudflare hands `env` to the handler, so nothing here needs to import it — and that
   * matters more than it sounds. `vinext build` emits this same module as the server entry
   * for BOTH targets, so a static `import { env } from 'cloudflare:workers'` anywhere in this
   * file lands in the self-hosted bundle too, where Node's loader rejects the `cloudflare:`
   * scheme before a line of application code runs. Taking it from the argument keeps the
   * bundle loadable under plain Node, where `db/runtime.ts` falls back to `process.env`.
   */
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    installRuntimeEnv(env as unknown as Record<string, unknown>);
    // vinext types its own entry against the asset-serving env it cares about; this passes the
    // real Cloudflare env straight through, unchanged, exactly as `fetch: vinextEntry.fetch` did.
    return vinextEntry.fetch(request, env as unknown as Parameters<typeof vinextEntry.fetch>[1], ctx);
  },
  scheduled(_event: ScheduledEvent, env: Cloudflare.Env, ctx: ExecutionContext) {
    // A Cron tick can reach a fresh isolate before any fetch has run, so install here too.
    installRuntimeEnv(env as unknown as Record<string, unknown>);
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
