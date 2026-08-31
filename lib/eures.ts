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
 * - **Completeness.** The search response carries the whole advertisement, median ~2,000-3,300
 *   characters. It does not truncate, which is precisely what makes Adzuna (capped at 500) and
 *   Careerjet (279) unscreenable — a language requirement lives near the end of an ad, so a
 *   preview leaves the filter deciding on text that never contained the answer.
 * - **Standing.** The endpoint path is literally `/public/`, `robots.txt` does not disallow
 *   `/eures/`, and content on europa.eu is licensed CC BY 4.0 under the Commission's reuse
 *   decision of 12 December 2011 — reuse permitted with attribution. Nothing here depends on
 *   working around an access control, and the portal exists specifically so that people can find
 *   work in another member state.
 *
 * The advertisement text itself belongs to the employer who wrote it. It is read to screen jobs
 * for one signed-in person and is never republished, which is the same footing as every other
 * source the app reads.
 */
const SEARCH_ENDPOINT = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search?lang=en';
const DETAIL_URL = 'https://europa.eu/eures/portal/jv-se/jv-details';
const PAGE_SIZE = 50;

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
  /** Languages the advertisement itself is published in — not the languages it requires. */
  availableLanguages?: string[];
}

export interface EuresParsedJob extends ParsedJob {
  adLanguages: string[];
}

/**
 * NUTS region codes are not place names, so they are only worth keeping as a locality hint
 * alongside the country. "CH031" is Basel, but nothing here resolves it, and inventing a name
 * would be worse than leaving the country: duplicate matching compares locations, and a wrong
 * city would split one advertisement into two cards.
 */
function locationFrom(locationMap: Record<string, (string | null)[]> | undefined, fallback: string) {
  const entries = Object.entries(locationMap ?? {});
  if (!entries.length) return fallback;
  const [country, regions] = entries[0];
  const region = regions?.find((value): value is string => Boolean(value));
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
  const response = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      page,
      resultsPerPage: PAGE_SIZE,
      // The only ordering the endpoint accepts; BY_PUBLICATION_DESC is rejected as malformed.
      sortSearch: 'BEST_MATCH',
      locationCodes: [countryCodes[country]],
      keywords: term.trim() ? [{ keyword: term.trim(), specificSearchCode: 'EVERYWHERE' }] : [],
    }),
  });
  if (!response.ok) throw new Error(`EURES request failed (${response.status}).`);
  const payload = await response.json() as { jvs?: EuresJob[] };
  return payload.jvs ?? [];
}

/**
 * One request returns 50 complete advertisements, so a run costs a handful of requests rather than
 * one per job — the same shape as the other bulk sources, and the reason this scales without any
 * per-advertisement fetching.
 */
export async function searchEures(
  terms: string[],
  country: Exclude<JobCountry, 'unknown'>,
  pagesPerTerm = 2,
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
      if (jobs.length < PAGE_SIZE) break;
    }
  }
  return [...byUrl.values()];
}
