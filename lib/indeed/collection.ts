import { createIndeedClient } from './client';
import { indeedReadiness } from './auth';
import { normalizeIndeed } from './normalize';
import { defaultIndeedSettings, indeedActiveRoles, indeedQueryIdentity, indeedSearchLocation, indeedSearchRadiusMiles, INDEED_QUERY_VERSION,
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
 * The provider receives a DATE sort and an approximate dateOnIndeed lookback;
 * a bounded live request accepted this shape on 2026-09-23. The local
 * datePublished gate remains authoritative for returned rows. Index age and
 * publication age can differ, so this is not proof of exhaustive coverage.
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

/**
 * Active safety ceiling (#126): 200 rows per role per country, 800 across
 * NL+CH. Eight validated 25-row pages reach 200 without assuming 100-row
 * pages work. This is a maximum, never a target, quota or coverage guarantee.
 * The lease covers 32 worst-case 20-second requests plus delays.
 */
export const INDEED_FINAL_BUDGET: IndeedCollectorBudget = {
  perQueryMaxRows: 200, totalMaxRows: 800, pageSize: 25, maxRequestsPerQuery: 8,
  maxTotalRequests: 32, leaseMs: 900_000, cooldownMs: 60_000,
};
export const INDEED_RUNNING_BUDGET: IndeedCollectorBudget = INDEED_FINAL_BUDGET;

/** Initial recency window: the last 168 hours. #115 later accepts checkpoint windows. */
export const INDEED_INITIAL_WINDOW_MS = 168 * 3_600_000;

/**
 * Repeat-click reuse (#115): an identical query with a successful check newer
 * than this reuses its results with no upstream request. Short and documented
 * on purpose — a reuse never extends its own freshness (the stored check time
 * is left alone), so this cannot become a hidden indefinite cache. Manual
 * refresh past this age, and any settings change (which yields a new query
 * identity), searches again. Cooldown and refusal still gate before reuse.
 */
export const INDEED_REUSE_FRESHNESS_MS = 15 * 60_000;

/**
 * Bounded overlap for incremental windows (#115): a later search starts this
 * far before the previous successful coverage boundary, so jobs indexed late
 * still surface. Small relative to the 168-hour initial window, and the same
 * for every query — never widened to fill a cap.
 */
export const INDEED_COVERAGE_OVERLAP_MS = 6 * 3_600_000;

interface IndeedCoverageRow {
  query_key: string; user_id: string; country: string; role: string; location: string;
  radius_miles: number; covered_through_ms: number; window_start_ms: number;
  status: string; last_check: string; last_success: string; updated_at: string;
}

async function readCoverage(db: D1Database, queryKey: string): Promise<IndeedCoverageRow | null> {
  const row = await db.prepare('SELECT * FROM indeed_coverage WHERE query_key = ?')
    .bind(queryKey).first<IndeedCoverageRow>().catch(() => null);
  return row ?? null;
}

async function writeCoverage(db: D1Database, row: {
  queryKey: string; userId: string; country: string; role: string; location: string; radiusMiles: number;
  coveredThroughMs: number; windowStartMs: number; status: 'complete' | 'incomplete';
  lastCheck: string; lastSuccess: string;
}): Promise<void> {
  await db.prepare(`INSERT INTO indeed_coverage
    (query_key, user_id, country, role, location, radius_miles, covered_through_ms, window_start_ms, status, last_check, last_success, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(query_key) DO UPDATE SET covered_through_ms = excluded.covered_through_ms,
      window_start_ms = excluded.window_start_ms, status = excluded.status,
      last_check = excluded.last_check, last_success = excluded.last_success, updated_at = excluded.updated_at`)
    .bind(row.queryKey, row.userId, row.country, row.role, row.location, row.radiusMiles,
      row.coveredThroughMs, row.windowStartMs, row.status, row.lastCheck, row.lastSuccess, row.lastCheck).run();
}

/**
 * Per-query coverage for the admin panel (#116). The caller's own rows only,
 * ordered for display. Empty on databases predating migration 27.
 */
export interface IndeedCoverageSummary {
  country: string; role: string; location: string; radiusMiles: number;
  windowStartMs: number; coveredThroughMs: number; status: string;
  lastCheck: string; lastSuccess: string;
}

export async function indeedCoverage(db: D1Database, userId: string): Promise<IndeedCoverageSummary[]> {
  // Plain column names: D1/Miniflare do not reliably preserve camelCase AS
  // aliases, so the shaping happens here, with safe fallbacks throughout.
  const rows = await db.prepare(`SELECT country, role, location, radius_miles,
      window_start_ms, covered_through_ms, status, last_check, last_success
    FROM indeed_coverage WHERE user_id = ? AND query_key LIKE ? ORDER BY country, role`)
    .bind(userId, `indeed/v${INDEED_QUERY_VERSION}\n%`).all<{
      country: unknown; role: unknown; location: unknown; radius_miles: unknown;
      window_start_ms: unknown; covered_through_ms: unknown; status: unknown;
      last_check: unknown; last_success: unknown;
    }>().catch(() => ({ results: [] as never[] }));
  return rows.results.map((row) => ({
    country: typeof row.country === 'string' ? row.country : '',
    role: typeof row.role === 'string' ? row.role : '',
    location: typeof row.location === 'string' ? row.location : '',
    radiusMiles: typeof row.radius_miles === 'number' ? row.radius_miles : 0,
    windowStartMs: typeof row.window_start_ms === 'number' ? row.window_start_ms : 0,
    coveredThroughMs: typeof row.covered_through_ms === 'number' ? row.covered_through_ms : 0,
    status: typeof row.status === 'string' ? row.status : 'incomplete',
    lastCheck: typeof row.last_check === 'string' ? row.last_check : '',
    lastSuccess: typeof row.last_success === 'string' ? row.last_success : '',
  }));
}

export async function collectIndeed(db: D1Database, config: Configuration,
  terms: string[], signal?: AbortSignal, fetcher: typeof fetch = fetch,
  countries: readonly IndeedCountry[] = ['NL', 'CH'],
  settings: IndeedSettings = defaultIndeedSettings(),
  budget: IndeedCollectorBudget = INDEED_RUNNING_BUDGET,
  windowStartMs?: number,
  // Account-scoped checkpoints (#115). Empty (the default for older callers
  // and unit tests) disables checkpoint read/write: every query uses the
  // initial window and nothing is persisted.
  userId = '',
): Promise<Record<IndeedCountry, IndeedBatchResult>> {
  const runStartMs = Date.now();
  const initialWindowStart = windowStartMs ?? runStartMs - INDEED_INITIAL_WINDOW_MS;
  const empty = (): IndeedBatchResult => ({ jobs: [], status: 'disabled', message: '', roles: [], retrieved: 0, rejected: 0, duplicates: 0, requests: 0 });
  const results = { NL: empty(), CH: empty() };
  const selectedCountries = (['NL', 'CH'] as const).filter(country => countries.includes(country));
  if (!selectedCountries.length) return results;
  const status = await indeedStatus(db, config);
  if (!['ready', 'connected'].includes(status.state)) {
    for (const value of Object.values(results)) {
      value.status = status.state === 'disabled' ? 'disabled' : status.state === 'refused' ? 'blocked' : 'unavailable';
      // A second click while the same run is active attaches here instead of
      // sending duplicate requests: the lease guarantees one upstream run, and
      // this message (surfaced by #116) says the click joined it.
      value.message = status.state === 'busy'
        ? 'A search is already running; this click attached to it instead of sending duplicate requests.'
        : `Indeed: ${status.state.replaceAll('_', ' ')}.${status.retryAfterSeconds ? ` Retry after ${status.retryAfterSeconds} seconds.` : ''}`;
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
  try {
    for (const country of selectedCountries) {
      const value = results[country];
      value.status = 'complete';
      const seen = new Set<string>();
      let queryCappedNote = '';
      const reuseNotes: string[] = [];
      let earliestWindow = Number.POSITIVE_INFINITY;
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
        // Durable per-query coverage (#115). The key folds owner, role,
        // country, place, provider radius and query version, so any settings
        // change starts fresh coverage rather than reusing another query's.
        const queryKey = userId
          ? indeedQueryIdentity({ userId, country, role: term, location, radiusMiles })
          : '';
        const prior = queryKey ? await readCoverage(db, queryKey) : null;
        const priorCheckMs = prior ? Date.parse(prior.last_check) : NaN;
        if (prior && prior.last_success === prior.last_check && Number.isFinite(priorCheckMs)
          && runStartMs - priorCheckMs < INDEED_REUSE_FRESHNESS_MS) {
          // Recent identical click: reuse even an incomplete bounded sample
          // with no upstream request. An error/refusal cannot be cached here.
          // Stored times are deliberately left alone, so a
          // reuse can never extend its own freshness into an indefinite cache.
          value.roles.push(term);
          if (prior.status !== 'complete') value.status = 'partial';
          reuseNotes.push(`Reused recent ${prior.status} check of "${term}" from ${prior.last_check}; no upstream request.`);
          continue;
        }
        const rawWindowStart = prior?.status === 'complete' && prior.covered_through_ms > 0
          // Incremental: since the previous successful boundary, minus a
          // bounded overlap for late indexing.
          ? prior.covered_through_ms - INDEED_COVERAGE_OVERLAP_MS
          // Incomplete or failed: retry the same window, never less. Coverage
          // advances only on success, so this cannot skip what was missed.
          : prior && prior.window_start_ms > 0 ? prior.window_start_ms : initialWindowStart;
        // A partial check retries the same recent window, but never grows an
        // unlimited historical backlog after days of capped searches.
        const queryWindowStart = Math.max(rawWindowStart, runStartMs - INDEED_INITIAL_WINDOW_MS);
        earliestWindow = Math.min(earliestWindow, queryWindowStart);
        // Request granularity: whole pages, so the per-query and whole-run
        // ceilings bind at page boundaries without mid-query cursor threading.
        const calls = Math.max(1, Math.min(budget.maxRequestsPerQuery,
          Math.ceil(budget.perQueryMaxRows / budget.pageSize),
          Math.ceil(wholeRunRemaining / budget.pageSize)));
        if (requestsMade) await delay(500);
        const response = await client.search({ country, keywords: term,
          location, radiusMiles, sort: 'DATE',
          hoursOld: Math.max(1, Math.min(168, Math.ceil((runStartMs - queryWindowStart) / 3_600_000))),
          pageSize: budget.pageSize, maxJobs: budget.perQueryMaxRows, maxRequests: calls, signal });
        value.roles.push(term);
        value.requests += response.requestsMade;
        requestsMade += response.requestsMade;
        value.retrieved += response.responseRows;
        totalUpstream += response.responseRows;
        value.rejected += response.rejectedRows;
        value.duplicates += response.duplicateRows;
        for (const record of response.jobs) {
          if (record.postedAtMs != null && record.postedAtMs < queryWindowStart) { value.rejected++; continue; }
          const parsed = normalizeIndeed(record, country);
          if (!parsed) { value.rejected++; continue; }
          if (seen.has(parsed.sourceUrl)) { value.duplicates++; continue; }
          seen.add(parsed.sourceUrl); value.jobs.push(parsed);
        }
        const exhausted = response.reason === 'end_of_results';
        if (queryKey) {
          const attemptAt = new Date().toISOString();
          await writeCoverage(db, {
            queryKey, userId, country, role: term, location, radiusMiles,
            coveredThroughMs: exhausted ? runStartMs : (prior?.covered_through_ms ?? 0),
            windowStartMs: queryWindowStart,
            status: exhausted ? 'complete' : 'incomplete',
            lastCheck: attemptAt,
            lastSuccess: (response.reason === 'end_of_results'
              || (response.reason === 'budget_exhausted' && response.jobs.length > 0))
              ? attemptAt : (prior?.last_success ?? ''),
          });
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
      const windowNote = earliestWindow === Number.POSITIVE_INFINITY
        ? 'No query ran for this country.'
        : `Only jobs posted since ${new Date(earliestWindow).toISOString()} are kept; older rows drop, undated rows stay.`;
      value.message = `${value.requests} request(s), ${value.retrieved} returned row(s). ${stopped || queryCappedNote || 'Bounded sample; more results may exist.'} ${windowNote} ${reuseNotes.join(' ')}Description completeness unverified.${terms.length > selected.length ? ' Only the first two role keywords were searched.' : ''}`;
    }
    return results;
  } finally {
    await db.prepare(`UPDATE indeed_control SET lease_token = '', lease_until = 0,
      cooldown_until = max(cooldown_until, ?) WHERE id = 'indeed' AND lease_token = ?`)
      .bind(Date.now() + budget.cooldownMs, token).run();
  }
}
