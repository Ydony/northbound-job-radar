import { delay, type ParsedJob } from './jobsch';
import type { JobCountry } from './types';

/**
 * FreeHire — an open-source IT job aggregator with a documented public read API
 * (INT-07, #166).
 *
 * The integration uses one endpoint only: `GET /agent/jobs/search`, the
 * full-description search "for programmatic/agent consumers". Unlike the plain
 * `/jobs/search` (truncated index previews, Adzuna-style), each hit carries the
 * complete advertisement verbatim in `description`, so one request per 100 jobs
 * replaces per-job detail fetching entirely.
 *
 * Standing to read it, verified 2026-09-24 against the live service:
 *
 * - No authentication on any job/search/facet/company endpoint; no key, no login.
 * - `robots.txt` names bots and agents explicitly, refuses HTML crawling in favour
 *   of "one unauthenticated JSON call", and points at this endpoint by example.
 * - `llms.txt` repeats the invitation with a rate budget (600 req/min ordinary
 *   reads, 300/min for the agent search) and asks callers to send an identifying
 *   User-Agent — which this module does. Nothing checks it; it lets them warn
 *   before a limit changes instead of meeting a 429 cold.
 * - The terms of service (2026-08-10) prohibit "scraping beyond our documented
 *   API" — which permits documented API use — and say nothing about
 *   redistributing results to end users.
 *
 * That silence is why the eligible-source allowlist below exists
 * (PUBLIC_ADMIN_INTEGRATION_PLAN.md §2): the catalogue mixes direct employer
 * ATS feeds with re-served aggregators (EURES, Adzuna, WhatJobs-*) and boards
 * this project has never reviewed (Workday, SmartRecruiters, Oracle, ...).
 * Only upstream `source` values this project already treats as public employer
 * feeds (docs/SOURCE_POLICY.md §2 — the same seven ATS platforms the local
 * adapters read) are accepted. Everything else is refused at ingest, and the
 * `source` filter is re-checked client-side because the API ignores unknown
 * params rather than refusing them: a dropped filter would otherwise look like
 * a genuinely broad result and ingest the entire unreviewed catalogue.
 *
 * Reading and republishing stay separate questions (SOURCE_POLICY.md §1). The
 * advertisement text is the employer's, so it is screened server-side and never
 * republished: the public tier shows facts, our verdict and a link. No display,
 * caching or attribution conditions were found in the terms or API docs; direct
 * confirmation of redistribution is still outstanding and must be asked for
 * before launch.
 */
const AGENT_SEARCH_ENDPOINT = 'https://freehire.me/api/v1/agent/jobs/search';
const FREEHIRE_JOB_URL = 'https://freehire.me/jobs';
const FREEHIRE_USER_AGENT = 'IkBenEenAppel/0.1 (+https://github.com/Ydony/northbound-job-radar)';

/** The API maximum. One page carries up to 100 whole advertisements. */
export const FREEHIRE_PAGE_SIZE = 100;
/**
 * How far into a term's results to read: 400 advertisements per role keyword,
 * inside the plan's 200–400 evaluation window per source and country (§4).
 * The loop still stops at the first short page, so narrow terms cost one request.
 */
export const MAX_FREEHIRE_PAGES_PER_TERM = 4;
/** Fixed pause between search pages. Well under the published 300/min budget. */
export const FREEHIRE_REQUEST_DELAY_MS = 400;

/**
 * Upstream `source` values accepted at ingest. Exactly the ATS platforms whose
 * employer-board endpoints this project already treats as published for
 * aggregators (SOURCE_POLICY.md §2) — FreeHire is such an aggregator.
 * Everything else the catalogue carries (re-served EURES/Adzuna/WhatJobs rows,
 * unreviewed boards such as Workday or SmartRecruiters, manually added rows
 * from unknown provenance) is excluded. Expanding this list is a per-source
 * terms review, not a config tweak.
 */
export const FREEHIRE_ELIGIBLE_SOURCES = [
  'greenhouse',
  'lever',
  'ashby',
  'recruitee',
  'personio',
  'teamtailor',
  'workable',
] as const;

/** Lowercase ISO-3166 alpha-2, matching the adapter keys `freehire-ch` / `freehire-nl`. */
const countryCodes: Record<Exclude<JobCountry, 'unknown'>, string> = {
  switzerland: 'CH',
  netherlands: 'NL',
};

/** The wire fields this integration reads. Anything else is ignored. */
export interface FreehireJob {
  public_slug?: string;  source?: string;
  manually_added?: boolean;
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  countries?: string[];
  posted_at?: string;
  closed_at?: string | null;
  enrichment?: { posting_language?: string; [key: string]: unknown };
  /** The wire carries more (skills, cities, salary bands, ...); none of it is read. */
  [key: string]: unknown;
}

export interface FreehireParsedJob extends ParsedJob {
  /** The upstream feed the row came from (`greenhouse`, `lever`, ...). */
  upstreamSource: string;
  /** The employer's own posting URL, as FreeHire reports it. */
  upstreamUrl: string;
}

export function isEligibleFreehireSource(source: string | undefined): boolean {
  if (!source) return false;
  const normalized = source.trim().toLowerCase();
  return (FREEHIRE_ELIGIBLE_SOURCES as readonly string[]).includes(normalized);
}

/** Whether the record names the target country. Values arrive lowercase; compare safely. */
export function freehireJobTargetsCountry(job: FreehireJob, country: Exclude<JobCountry, 'unknown'>): boolean {
  const want = countryCodes[country].toLowerCase();
  return (job.countries ?? []).some((code) => code.trim().toLowerCase() === want);
}

export function freehireJobToParsedJob(job: FreehireJob, fallbackLocation: string): FreehireParsedJob | null {
  const slug = (job.public_slug ?? '').trim();
  const title = (job.title ?? '').replace(/\s+/g, ' ').trim();
  const description = (job.description ?? '').trim();
  // Search serves open postings only; a closed row is never a new job.
  if (!slug || !title || !description || job.closed_at != null) return null;
  return {
    sourceUrl: `${FREEHIRE_JOB_URL}/${encodeURIComponent(slug)}`,
    title,
    company: (job.company ?? '').trim(),
    location: (job.location ?? '').trim() || fallbackLocation,
    descriptionHtml: description,
    postedAt: job.posted_at ?? '',
    upstreamSource: (job.source ?? '').trim(),
    upstreamUrl: (job.url ?? '').trim(),
  };
}

interface FreehireSearchPage {
  data?: FreehireJob[];
  meta?: { total?: number; ignored_params?: unknown };
}

async function searchPage(params: URLSearchParams): Promise<FreehireSearchPage> {
  const response = await fetch(`${AGENT_SEARCH_ENDPOINT}?${params}`, {
    headers: { accept: 'application/json', 'user-agent': FREEHIRE_USER_AGENT },
  });
  // A refusal is a stop signal, never retried: 403/429 mean stop, and a 5xx here
  // fails this term rather than hammering a struggling service.
  if (!response.ok) throw new Error(`FreeHire request failed (${response.status}).`);
  return (await response.json()) as FreehireSearchPage;
}

/**
 * Whole advertisements, already filtered to the adapter's country and the
 * eligible upstream allowlist. Like the other bulk sources this costs a handful
 * of requests per term rather than one per job.
 */
export async function searchFreehire(
  terms: string[],
  country: Exclude<JobCountry, 'unknown'>,
  pagesPerTerm = MAX_FREEHIRE_PAGES_PER_TERM,
): Promise<FreehireParsedJob[]> {
  const queries = terms.length ? terms : [''];
  const byUrl = new Map<string, FreehireParsedJob>();
  const fallback = country === 'switzerland' ? 'Switzerland' : 'Netherlands';
  let firstTerm = true;
  for (const term of queries) {
    for (let page = 0; page < pagesPerTerm; page += 1) {
      if (!firstTerm || page > 0) await delay(FREEHIRE_REQUEST_DELAY_MS);
      firstTerm = false;
      const params = new URLSearchParams({
        countries: countryCodes[country],
        posting_language: 'en',
        source: FREEHIRE_ELIGIBLE_SOURCES.join(','),
        limit: String(FREEHIRE_PAGE_SIZE),
        offset: String(page * FREEHIRE_PAGE_SIZE),
      });
      if (term.trim()) params.set('q', term.trim());
      const payload = await searchPage(params);
      // The API ignores params it does not read instead of refusing them. A
      // dropped `source` or `countries` filter would ingest the unreviewed
      // catalogue looking like a real result, so a warning about our own params
      // fails the term rather than importing it.
      const ignored = Array.isArray(payload.meta?.ignored_params) ? payload.meta!.ignored_params! : [];
      if (ignored.length) {
        throw new Error(`FreeHire ignored request params (${ignored.join(', ')}); refusing the page.`);
      }
      const jobs = payload.data ?? [];
      for (const job of jobs) {
        // Re-checked client-side for the same reason: never trust the filter.
        if (!isEligibleFreehireSource(job.source)) continue;
        if (!freehireJobTargetsCountry(job, country)) continue;
        const parsed = freehireJobToParsedJob(job, fallback);
        if (parsed && !byUrl.has(parsed.sourceUrl)) byUrl.set(parsed.sourceUrl, parsed);
      }
      if (jobs.length < FREEHIRE_PAGE_SIZE) break;
    }
  }
  return [...byUrl.values()];
}
