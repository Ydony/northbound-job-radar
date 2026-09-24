import { nutsRegionName } from './nuts';
import type { ParsedJob } from './jobsch';
import type { JobCountry } from './types';

/**
 * EURES — the European Commission's own job mobility portal.
 *
 * This is the best-founded source in the project on every axis that matters here:
 *
 * - **Scale.** Two million advertisements across the EU/EEA; 245,000 for the Netherlands and
 *   41,900 for Switzerland, which participates through EFTA. Everything else the app reads is a
 *   rounding error next to it.
 * - **Completeness.** The search response carries the whole advertisement for most countries
 *   (median ~2,000-3,300 characters, CH/DE/AT/LU median 3,300–4,000) — unlike Adzuna (capped at
 *   500) and Careerjet (279), whose previews leave the filter deciding on text that never
 *   contained the answer. **Exception: the Netherlands.** Measured 2026-09-18: 666 of 740 stored
 *   EURES Netherlands descriptions are 1,900–2,100 characters (p50 1,954) and end with `...`,
 *   usually before the requirements section, and the public detail endpoint returns the same
 *   ~2,020 characters, so the cap is upstream (Dutch provider → EURES). Truncated text is
 *   incomplete evidence like a teaser: the language gate (`isTruncatedAdvertisement` in
 *   lib/analysis.ts) withholds `pass` on anything ending in `...`/`…`, while findings before the
 *   cut still stand.
 * - **Standing to read it.** The endpoint path is literally `/public/`, `robots.txt` does not
 *   disallow `/eures/`, and the EURES legal notice authorises reuse provided the European Labour
 *   Authority is credited. Nothing here works around an access control, and the portal exists
 *   specifically so that people can find work in another member state.
 *
 * **Reading it and republishing it are different questions**, and only the first is settled above.
 * The Commission's CC BY 4.0 licence covers content *owned by the EU* and says additional rights
 * may need clearing where content includes third-party works. An advertisement is written by the
 * employer, so it is a third-party work inside an EU-operated portal: ours to read and screen,
 * not ours to hand out.
 *
 * That distinction used to be satisfied by accident — there was one signed-in user and nothing was
 * published to anyone. It stops being satisfied by accident the moment a public tier exists, so it
 * is now a rule: see `docs/SOURCE_POLICY.md` §1. The public tier shows facts and our own verdict
 * plus a link to the original; the full text stays server-side, where it is only ever used to
 * decide whether English is enough.
 *
 * Attribution to the ELA is a condition of the permission and is implemented in
 * `lib/attribution.ts`: the credit renders under the job list whenever EURES jobs are on
 * screen (`needsElaAttribution` in `app/job-radar.tsx`) and `/sources` carries a
 * "Required attribution" section. `docs/SOURCE_POLICY.md` §4 records it as done.
 */
const SEARCH_ENDPOINT = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search?lang=en';
const DETAIL_URL = 'https://europa.eu/eures/portal/jv-se/jv-details';
export const EURES_PAGE_SIZE = 50;

/**
 * How far into a term's results to read.
 *
 * Raised from 2 on the same measurement that moved Job-Room (#95/#96): EURES does not
 * return results newest-first under `BEST_MATCH` — a live probe showed page 1 for "analyst"
 * spanning 2026-03-12 to 2026-09-04 and page 2 containing a 2022 outlier, a mix across
 * months on every page just like Job-Room's. Totals dwarf the window (2,192 for "analyst"
 * in CH, 12,306 in NL at the time of writing), so an advertisement posted yesterday can sit
 * past position 100 and never be discovered at all. Six pages cost six requests of about
 * half a second each, and the loop still stops at the first short page, so a term with
 * fewer results ends early.
 */
export const MAX_EURES_PAGES_PER_TERM = 6;

/**
 * Which ordering to ask the endpoint for, per country.
 *
 * Measured 2026-09-20, one live probe per country across three terms (analyst, engineer,
 * manager), 4–12 pages each — not assumed. `BY_PUBLICATION_DESC` and the other date-shaped
 * values are rejected as malformed (HTTP 400), but `MOST_RECENT` is accepted and returns the
 * same result set in a different order (identical totals). For Switzerland it is
 * newest-first in practice: every advertisement posted within the last 7 days sat on page 1
 * (12, 21 and 13 across the three terms) with nothing fresher on pages 2–12, against 0–4
 * scattered across 12 pages under `BEST_MATCH`. For the Netherlands it is not date-ordered
 * at all (page openers ran Jul/Aug/Sep/Aug), and `BEST_MATCH` surfaces roughly twice as many
 * fresh advertisements per page there (67 vs 39 fresh-of-300 for "analyst" over six pages,
 * consistent across all three terms) — so NL keeps it. Re-measure before changing this:
 * `MOST_RECENT` is undocumented and behaves differently per country for no stated reason.
 */
const sortByCountry: Record<Exclude<JobCountry, 'unknown'>, string> = {
  switzerland: 'MOST_RECENT',
  netherlands: 'BEST_MATCH',
};

export function euresSortFor(country: Exclude<JobCountry, 'unknown'>) {
  return sortByCountry[country];
}

/** Lowercase ISO-3166 alpha-2. Three-letter codes are accepted by the API but silently match nothing. */
const countryCodes: Record<Exclude<JobCountry, 'unknown'>, string> = {
  netherlands: 'nl',
  switzerland: 'ch',
};

interface EuresEmployer {
  name?: string;
}

interface EuresJob {
  id?: string;
  title?: string;
  description?: string;
  creationDate?: number;
  employer?: EuresEmployer;
  /** Country code to NUTS region codes, e.g. `{ "CH": ["CH031"] }` for Basel. */
  locationMap?: Record<string, (string | null)[]>;
  /**
   * Which translations of the advertisement exist — **not** the languages the job requires.
   *
   * The portal renders this as "Working languages: Dutch", which reads like a requirement and is
   * not one. Measured on 50 Netherlands listings: all 50 carried `["nl"]`, and 22 of them (44%)
   * contained no Dutch requirement anywhere in the text. One of those was a full 1,955-character
   * advertisement that never uses the word "Dutch" at all, and is a genuine English-only match.
   *
   * Treating this as a requirement would therefore discard almost half of the Dutch results,
   * including the ones worth having. It is carried through as `adLanguages` for display and
   * debugging only, and deliberately never reaches the language gate. See the test in
   * tests/eures.test.ts, which exists to keep it that way.
   */
  availableLanguages?: string[];
}

export interface EuresParsedJob extends ParsedJob {
  adLanguages: string[];
}

/**
 * Resolve the NUTS region code into a place name at ingest.
 *
 * EURES gives a code, not a name: `{ "NL": ["NL32B"] }`. Stored raw, that surfaces as "NL32B" on
 * the card and in any location facet, which is no use to anyone — it is Groot-Amsterdam. Resolving
 * here rather than at display time means the readable name is what gets stored, so duplicate
 * matching compares places rather than codes and an export carries something a person can read.
 *
 * Unknown codes fall back to their parent region and, failing that, to the country, because a
 * broader true answer beats a precise meaningless one.
 */
function locationFrom(locationMap: Record<string, (string | null)[]> | undefined, fallback: string) {
  const entries = Object.entries(locationMap ?? {});
  if (!entries.length) return fallback;
  const [country, regions] = entries[0];
  const region = regions?.find((value): value is string => Boolean(value));
  const name = region ? nutsRegionName(region) : '';
  if (name) return name;
  // Some postings carry a country and no region at all: `{ "CH": [null] }`. Showing the bare code
  // "CH" as a location is worse than saying Switzerland, so fall back to the country's name.
  if (!region) return fallback;
  return [region, country].filter(Boolean).join(' ') || fallback;
}

export function euresJobToParsedJob(job: EuresJob, fallbackLocation: string): EuresParsedJob | null {
  const title = (job.title ?? '').replace(/\s+/g, ' ').trim();
  const description = (job.description ?? '').trim();
  if (!job.id || !title || !description) return null;
  return {
    // The id is already base64url, so it is safe in a path, but encode it anyway rather than
    // assuming the portal will never change what it puts there.
    sourceUrl: `${DETAIL_URL}/${encodeURIComponent(job.id)}?lang=en`,
    title,
    company: job.employer?.name ?? '',
    location: locationFrom(job.locationMap, fallbackLocation),
    descriptionHtml: description,
    postedAt: job.creationDate ? new Date(job.creationDate).toISOString() : '',
    adLanguages: job.availableLanguages ?? [],
  };
}

async function searchPage(term: string, country: Exclude<JobCountry, 'unknown'>, page: number) {
  const sorts = [euresSortFor(country), 'BEST_MATCH'].filter((value, index, all) => all.indexOf(value) === index);
  let lastError = '';
  for (const sortSearch of sorts) {
    const response = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        page,
        resultsPerPage: EURES_PAGE_SIZE,
        sortSearch,
        locationCodes: [countryCodes[country]],
        keywords: term.trim() ? [{ keyword: term.trim(), specificSearchCode: 'EVERYWHERE' }] : [],
      }),
    });
    if (response.ok) {
      const payload = await response.json() as { jvs?: EuresJob[] };
      return payload.jvs ?? [];
    }
    lastError = `EURES request failed (${response.status}).`;
    // `MOST_RECENT` is undocumented: if it ever stops being accepted, fall back to the
    // documented relevance ordering rather than failing the country's whole search.
    if (sortSearch === 'BEST_MATCH') break;
  }
  throw new Error(lastError || 'EURES request failed.');
}

/**
 * One request returns 50 complete advertisements, so a run costs a handful of requests rather than
 * one per job — the same shape as the other bulk sources, and the reason this scales without any
 * per-advertisement fetching.
 */
export async function searchEures(
  terms: string[],
  country: Exclude<JobCountry, 'unknown'>,
  pagesPerTerm = MAX_EURES_PAGES_PER_TERM,
): Promise<EuresParsedJob[]> {
  const queries = terms.length ? terms : [''];
  const byUrl = new Map<string, EuresParsedJob>();
  const fallback = country === 'switzerland' ? 'Switzerland' : 'Netherlands';
  for (const term of queries) {
    for (let page = 1; page <= pagesPerTerm; page += 1) {
      const jobs = await searchPage(term, country, page);
      for (const job of jobs) {
        const parsed = euresJobToParsedJob(job, fallback);
        if (parsed && !byUrl.has(parsed.sourceUrl)) byUrl.set(parsed.sourceUrl, parsed);
      }
      if (jobs.length < EURES_PAGE_SIZE) break;
    }
  }
  return [...byUrl.values()];
}
