import { createIndeedClient } from './client';
import { indeedReadiness } from './auth';
import { normalizeIndeed } from './normalize';
import { defaultIndeedSettings, indeedActiveRoles, indeedSearchLocation, indeedSearchRadiusMiles,
  type IndeedSettings } from './settings';
import type { IndeedCountry } from './contracts';
import type { ParsedJob } from '../jobsch';
import { delay } from '../jobsch';
import type { SourceRunStatus } from '../types';

type Configuration = Parameters<typeof createIndeedClient>[0];
interface Control { paused: number; cooldown_until: number; lease_until: number; last_success: string }
export interface IndeedBatchResult {
  jobs: ParsedJob[]; status: SourceRunStatus; message: string; roles: string[];
  retrieved: number; rejected: number; duplicates: number; requests: number;
}
export type IndeedStatus = { state: string; lastSuccess: string; retryAfterSeconds: number };

export async function indeedStatus(db: D1Database, config: Configuration): Promise<IndeedStatus> {
  const readiness = indeedReadiness(config.access, config.credentials);
  const base = { lastSuccess: '', retryAfterSeconds: 0 };
  if (readiness !== 'ready') return { ...base, state: readiness };
  const row = await db.prepare("SELECT * FROM indeed_control WHERE id = 'indeed'").first<Control>();
  if (!row) return { ...base, state: 'unavailable' };
  const retryAfterSeconds = Math.max(0, Math.ceil((row.cooldown_until - Date.now()) / 1000));
  return { lastSuccess: row.last_success, retryAfterSeconds,
    state: row.paused ? 'refused' : retryAfterSeconds ? 'cooldown' : row.lease_until > Date.now() ? 'busy'
      : row.last_success ? 'connected' : 'ready' };
}

/** One lease and a bounded number of requests across both countries and all terms.
 *
 * Place and distance come from the account's Indeed settings (#113). A missing
 * settings value reads as defaults, so callers that predate the table keep the
 * previous hardcoded behaviour. Only the first two distinct role queries are
 * sent; the shared five role inputs are unchanged.
 *
 * Row ceilings count UPSTREAM returned rows, not kept jobs (#114): duplicates,
 * rejected rows and jobs older than the window all consume the budget. The cap
 * is enforced at request granularity (whole pages), so a run can overshoot by
 * less than one page; with the FINAL multiples below it lands exactly.
 *
 * Recency is enforced LOCALLY by posted date, because the transport asks for
 * RELEVANCE order and newest-first support is unverified (Codex #118 must
 * supply evidence before any upstream date/newest claim). Under relevance
 * ordering, stopping at the "window end" mid-paging would be unsound — old and
 * new rows interleave — so the collector pages to budget or exhaustion and
 * drops out-of-window rows. Jobs with unknown dates are kept: absence of a
 * date is not evidence of age.
 */
export interface IndeedCollectorBudget {
  /** Upstream returned rows per role query per country. */
  perQueryMaxRows: number;
  /** Upstream returned rows for the whole click, both countries. */
  totalMaxRows: number;
  pageSize: number;
  maxRequestsPerQuery: number;
  /** Whole-click request backstop; the lease and cooldown scale with it. */
  maxTotalRequests: number;
  leaseMs: number;
  cooldownMs: number;
}

/** The live budget. Unchanged by #114 except the new 168-hour window filter. */
export const INDEED_RUNNING_BUDGET: IndeedCollectorBudget = {
  perQueryMaxRows: 25, totalMaxRows: 100, pageSize: 25, maxRequestsPerQuery: 1,
  maxTotalRequests: 4, leaseMs: 180_000, cooldownMs: 60_000,
};

/**
 * The eventual design #126 activates (200 rows per role per country, 800 across
 * NL+CH). NOT live: 8 pages of the validated 25-row size reach 200 without
 * assuming the unevaluated 100-row page works. Lease covers 32 worst-case
 * 20-second requests plus delays. Synthetic tests only, until #126.
 */
export const INDEED_FINAL_BUDGET: IndeedCollectorBudget = {
  perQueryMaxRows: 200, totalMaxRows: 800, pageSize: 25, maxRequestsPerQuery: 8,
  maxTotalRequests: 32, leaseMs: 900_000, cooldownMs: 60_000,
};

/** Initial recency window: the last 168 hours. #115 later accepts checkpoint windows. */
export const INDEED_INITIAL_WINDOW_MS = 168 * 3_600_000;

export async function collectIndeed(db: D1Database, config: Configuration,
  terms: string[], signal?: AbortSignal, fetcher: typeof fetch = fetch,
  countries: readonly IndeedCountry[] = ['NL', 'CH'],
  settings: IndeedSettings = defaultIndeedSettings(),
  budget: IndeedCollectorBudget = INDEED_RUNNING_BUDGET,
  windowStartMs: number = Date.now() - INDEED_INITIAL_WINDOW_MS,
): Promise<Record<IndeedCountry, IndeedBatchResult>> {
  const empty = (): IndeedBatchResult => ({ jobs: [], status: 'disabled', message: '', roles: [], retrieved: 0, rejected: 0, duplicates: 0, requests: 0 });
  const results = { NL: empty(), CH: empty() };
  const selectedCountries = (['NL', 'CH'] as const).filter(country => countries.includes(country));
  if (!selectedCountries.length) return results;
  const status = await indeedStatus(db, config);
  if (!['ready', 'connected'].includes(status.state)) {
    for (const value of Object.values(results)) {
      value.status = status.state === 'disabled' ? 'disabled' : status.state === 'refused' ? 'blocked' : 'unavailable';
      value.message = `Indeed: ${status.state.replaceAll('_', ' ')}.${status.retryAfterSeconds ? ` Retry after ${status.retryAfterSeconds} seconds.` : ''}`;
    }
    return results;
  }
  const token = crypto.randomUUID();
  const now = Date.now();
  const locked = await db.prepare(`UPDATE indeed_control SET lease_token = ?, lease_until = ?
    WHERE id = 'indeed' AND paused = 0 AND cooldown_until <= ? AND lease_until <= ?`)
    .bind(token, now + budget.leaseMs, now, now).run();
  if (!locked.meta.changes) {
    for (const value of Object.values(results)) { value.status = 'unavailable'; value.message = 'Indeed is busy, paused or cooling down.'; }
    return results;
  }
  // A crash retains the lease; a normal finish also imposes a fixed cooldown.
  const client = createIndeedClient(config, fetcher);
  const selected = indeedActiveRoles(terms);
  let stopped = '';
  let requestsMade = 0;
  let totalUpstream = 0;
  const windowNote = `Only jobs posted since ${new Date(windowStartMs).toISOString()} are kept; older or undated rows are handled as documented.`;
  try {
    for (const country of selectedCountries) {
      const value = results[country];
      value.status = 'complete';
      const seen = new Set<string>();
      let queryCappedNote = '';
      const location = indeedSearchLocation(country, settings);
      const radiusMiles = indeedSearchRadiusMiles(country, settings);
      for (const term of selected) {
        if (stopped || signal?.aborted) {
          if (signal?.aborted && !stopped) stopped = 'cancelled';
          value.status = value.jobs.length ? 'partial' : 'unavailable';
          break;
        }
        if (requestsMade >= budget.maxTotalRequests) {
          stopped = `whole-run request cap (${budget.maxTotalRequests})`;
          value.status = value.jobs.length ? 'partial' : 'unavailable';
          break;
        }
        const wholeRunRemaining = budget.totalMaxRows - totalUpstream;
        if (wholeRunRemaining <= 0) {
          stopped = `whole-run row cap (${budget.totalMaxRows} upstream rows)`;
          value.status = value.jobs.length ? 'partial' : 'unavailable';
          break;
        }
        // Request granularity: whole pages, so the per-query and whole-run
        // ceilings bind at page boundaries without mid-query cursor threading.
        const calls = Math.max(1, Math.min(budget.maxRequestsPerQuery,
          Math.ceil(budget.perQueryMaxRows / budget.pageSize),
          Math.ceil(wholeRunRemaining / budget.pageSize)));
        if (requestsMade) await delay(500);
        const response = await client.search({ country, keywords: term,
          location, radiusMiles,
          pageSize: budget.pageSize, maxJobs: budget.perQueryMaxRows, maxRequests: calls, signal });
        value.roles.push(term);
        value.requests += response.requestsMade;
        requestsMade += response.requestsMade;
        value.retrieved += response.responseRows;
        totalUpstream += response.responseRows;
        value.rejected += response.rejectedRows;
        value.duplicates += response.duplicateRows;
        for (const record of response.jobs) {
          if (record.postedAtMs != null && record.postedAtMs < windowStartMs) { value.rejected++; continue; }
          const parsed = normalizeIndeed(record, country);
          if (!parsed) { value.rejected++; continue; }
          if (seen.has(parsed.sourceUrl)) { value.duplicates++; continue; }
          seen.add(parsed.sourceUrl); value.jobs.push(parsed);
        }
        const queryCapped = response.hasMore && response.responseRows >= budget.perQueryMaxRows;
        if (queryCapped) queryCappedNote = `row cap (${budget.perQueryMaxRows} per query upstream rows); more results may exist upstream`;
        // A per-query cap only ends that query; later queries keep their own
        // budget. Only the whole-run cap stops the run: nothing is left for
        // the queries after it.
        if (response.hasMore && totalUpstream >= budget.totalMaxRows) {
          stopped = `row cap (${budget.totalMaxRows} whole run upstream rows); more results may exist upstream`;
        }
        if (response.outcome !== 'complete' || value.rejected || terms.length > selected.length) value.status = 'partial';
        if (queryCappedNote) value.status = value.jobs.length ? 'partial' : 'unavailable';
        if (response.reason === 'access_refused' || response.reason === 'redirect_refused' || response.reason === 'invalid_response') {
          stopped = 'access refused or unexpected response; paused pending operator review';
          await db.prepare("UPDATE indeed_control SET paused = 1 WHERE id = 'indeed' AND lease_token = ?").bind(token).run();
          value.status = value.jobs.length ? 'partial' : 'blocked';
        } else if (response.reason === 'rate_limited') {
          stopped = 'rate limited';
          const until = Date.now() + Math.max(60, response.retryAfterSeconds ?? 60) * 1000;
          await db.prepare("UPDATE indeed_control SET cooldown_until = max(cooldown_until, ?) WHERE id = 'indeed' AND lease_token = ?").bind(until, token).run();
          value.status = value.jobs.length ? 'partial' : 'unavailable';
        } else if (!['end_of_results', 'budget_exhausted'].includes(response.reason)) {
          stopped = response.reason.replaceAll('_', ' '); value.status = value.jobs.length ? 'partial' : 'failed';
        } else {
          await db.prepare("UPDATE indeed_control SET last_success = ? WHERE id = 'indeed' AND lease_token = ?")
            .bind(new Date().toISOString(), token).run();
        }
      }
      value.message = `${value.requests} request(s), ${value.retrieved} returned row(s). ${stopped || queryCappedNote || 'Bounded sample; more results may exist.'} ${windowNote} Description completeness unverified.${terms.length > selected.length ? ' Only the first two role keywords were searched.' : ''}`;
    }
    return results;
  } finally {
    await db.prepare(`UPDATE indeed_control SET lease_token = '', lease_until = 0,
      cooldown_until = max(cooldown_until, ?) WHERE id = 'indeed' AND lease_token = ?`)
      .bind(Date.now() + budget.cooldownMs, token).run();
  }
}
