/**
 * INT-06 (#165): Cloudflare Cron Trigger wiring for the bounded public refresh.
 *
 * The collector itself (`lib/public-refresh.ts`) knows nothing about adapters:
 * fetchers are injected. This module is the one place that maps eligible public
 * keys onto real adapter calls, and the mapping is gated by INT-01's registry —
 * resolving an admin-only, disabled or unknown key throws before any adapter is
 * touched. Every resolved fetcher uses the bulk search path only; the
 * per-advert detail-fetch path is never called from here, which keeps the
 * whole refresh on authorized-API bulk sources.
 *
 * Refresh terms (role keywords) come from `PUBLIC_REFRESH_TERMS`, set by the
 * owner at deploy time. When it is empty the handler still runs — leases,
 * freshness and truthful per-source reports — but wires no fetchers, so no
 * upstream source is contacted. Terms are an explicit deployment choice, not a
 * default the code invents.
 *
 * The handler is fail-closed twice: the cron schedule exists only in the prod
 * worker config, and the handler no-ops unless `PUBLIC_REFRESH_ENABLED` is
 * exactly `'true'`. Enabling it is an owner-supervised deploy step, out of
 * scope here; dev/test never set it and their tests inject synthetic fetchers.
 *
 * `Retry-After` limitation, stated plainly: adapters throw plain Errors that
 * carry the status but not the response headers, so a real 429 cools down for
 * the durable default rather than the header's exact value. The contract
 * honors precise `Retry-After` wherever a fetcher supplies it (proven with
 * synthetic fetchers); capturing the header from real adapters needs their
 * cooperation and is future work, not a silent gap.
 */

import { jobSourceAdapters } from './job-adapters';
import type { AggregatorCredentials } from './job-aggregators';
import { sourcePolicyFor } from './source-policy';
import {
  claimQueuedRefresh,
  clearQueuedRefresh,
  runPublicRefresh,
  type PublicRefreshFetch,
  type PublicRefreshReport,
} from './public-refresh';

/** Blank credentials: every public-eligible source is unauthenticated, so the
 * refresh never needs the keyed integrations (those are admin-only). */
const BLANK_CREDENTIALS: AggregatorCredentials = {
  adzunaAppId: '',
  adzunaAppKey: '',
  careerjetApiKey: '',
  careerjetReferer: '',
  careerjetUserIp: '',
};

/** Owner-configured refresh terms: comma-separated role keywords. */
export function parseRefreshTerms(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((term) => term.trim()).filter((term) => term.length > 0);
}

/**
 * Map one public key onto its bulk fetcher. Throws for anything that is not a
 * currently public-eligible source — admin-only, disabled, unknown — and for
 * adapters without a bulk search path, so the refresh can never be pointed at
 * a detail-fetching source by configuration drift.
 */
export function resolvePublicRefreshFetcher(sourceKey: string, terms: string[]): PublicRefreshFetch {
  const policy = sourcePolicyFor(sourceKey);
  if (!policy || policy.audience !== 'public' || !policy.enabled) {
    throw new Error(`Public refresh refused for "${sourceKey}": not a public-eligible enabled source.`);
  }
  const adapter = jobSourceAdapters.find((entry) => entry.key === sourceKey);
  if (!adapter?.searchDetailed) {
    throw new Error(`Public refresh refused for "${sourceKey}": no bulk search path; page fetching stays admin-only.`);
  }
  const searchDetailed = adapter.searchDetailed;
  return async () => {
    const jobs = await searchDetailed(terms, '', BLANK_CREDENTIALS);
    return {
      adverts: jobs.map((job) => ({ sourceUrl: job.sourceUrl, title: job.title })),
      nextCursor: '',
    };
  };
}

/** Fetchers for every eligible key. Empty terms wire nothing: the run reports
 * `unavailable` per source instead of contacting anything. */
export function buildPublicRefreshFetchers(terms: string[]): Record<string, PublicRefreshFetch> {
  if (!terms.length) return {};
  const fetchers: Record<string, PublicRefreshFetch> = {};
  for (const adapter of jobSourceAdapters) {
    const policy = sourcePolicyFor(adapter.key);
    if (!policy || policy.audience !== 'public' || !policy.enabled) continue;
    if (!adapter.searchDetailed) continue;
    fetchers[adapter.key] = resolvePublicRefreshFetcher(adapter.key, terms);
  }
  return fetchers;
}

export interface CronRefreshInput {
  db: D1Database;
  enabled: boolean;
  terms: string[];
  /** Test seam: synthetic fetchers replace adapter resolution (dev/test only). */
  fetchers?: Record<string, PublicRefreshFetch>;
  now?: number;
  onBatch?: (sourceKey: string, batch: { adverts: { sourceUrl: string; title: string }[]; nextCursor: string }) => void | Promise<void>;
}

export interface CronRefreshOutcome {
  enabled: boolean;
  claimedQueue: boolean;
  report: PublicRefreshReport;
}

/**
 * One cron tick. Claims a coalesced on-demand refresh when one is queued, then
 * runs the bounded pass over eligible public sources. Item persistence is the
 * INT-05 seam (`onBatch`); this handler records locks, cursors, cooldowns and
 * freshness either way.
 */
export async function handlePublicRefreshCron(input: CronRefreshInput): Promise<CronRefreshOutcome> {
  if (!input.enabled) {
    return { enabled: false, claimedQueue: false, report: { results: [], ignoredKeys: [] } };
  }
  const claimedQueue = await claimQueuedRefresh(input.db);
  const fetchers = input.fetchers ?? buildPublicRefreshFetchers(input.terms);
  const report = await runPublicRefresh(input.db, fetchers,
    input.now !== undefined || input.onBatch ? { now: input.now, onBatch: input.onBatch } : {});
  if (claimedQueue) await clearQueuedRefresh(input.db);
  return { enabled: true, claimedQueue, report };
}
