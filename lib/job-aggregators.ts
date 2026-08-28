import type { ParsedJob } from './jobsch';
import type { JobCountry } from './types';

/**
 * Aggregator APIs are authorized, keyed integrations rather than page fetching, but they return
 * short teaser descriptions. That is enough to discover and rank a vacancy; it is usually not
 * enough evidence for a confident `pass`, so these jobs normally land in Review by design.
 */
export const AGGREGATOR_SNIPPET_NOTE = 'Aggregator listing: the API returns a short teaser, so language evidence is limited.';

const ADZUNA_COUNTRY: Record<Exclude<JobCountry, 'unknown'>, string> = { switzerland: 'ch', netherlands: 'nl' };
const CAREERJET_LOCALE: Record<Exclude<JobCountry, 'unknown'>, string> = { switzerland: 'en_CH', netherlands: 'en_NL' };
const RESULTS_PER_PAGE = 50;

export interface AggregatorCredentials {
  adzunaAppId?: string;
  adzunaAppKey?: string;
  careerjetAffiliateId?: string;
}

interface AdzunaResult {
  redirect_url?: string;
  title?: string;
  description?: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
}

interface CareerjetResult {
  url?: string;
  title?: string;
  description?: string;
  company?: string;
  locations?: string;
  date?: string;
}

function fallbackLocation(country: Exclude<JobCountry, 'unknown'>) {
  return country === 'switzerland' ? 'Switzerland' : 'Netherlands';
}

export async function searchAdzuna(
  terms: string[],
  location: string,
  country: Exclude<JobCountry, 'unknown'>,
  credentials: AggregatorCredentials,
  pages = 1,
): Promise<ParsedJob[]> {
  if (!credentials.adzunaAppId || !credentials.adzunaAppKey) return [];
  const byUrl = new Map<string, ParsedJob>();
  for (const term of terms.length ? terms : ['']) {
    for (let page = 1; page <= pages; page += 1) {
      const url = new URL(`https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY[country]}/search/${page}`);
      url.searchParams.set('app_id', credentials.adzunaAppId);
      url.searchParams.set('app_key', credentials.adzunaAppKey);
      url.searchParams.set('results_per_page', String(RESULTS_PER_PAGE));
      url.searchParams.set('content-type', 'application/json');
      if (term.trim()) url.searchParams.set('what', term.trim());
      if (location.trim()) url.searchParams.set('where', location.trim());
      const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Adzuna request failed (${response.status}).`);
      const payload = await response.json() as { results?: AdzunaResult[] };
      const results = payload.results ?? [];
      for (const entry of results) {
        if (!entry.redirect_url || !entry.title) continue;
        byUrl.set(entry.redirect_url, {
          sourceUrl: entry.redirect_url,
          title: entry.title,
          company: entry.company?.display_name ?? '',
          location: entry.location?.display_name || fallbackLocation(country),
          descriptionHtml: entry.description ?? '',
          postedAt: entry.created ?? '',
        });
      }
      if (results.length < RESULTS_PER_PAGE) break;
    }
  }
  return [...byUrl.values()];
}

export async function searchCareerjet(
  terms: string[],
  location: string,
  country: Exclude<JobCountry, 'unknown'>,
  credentials: AggregatorCredentials,
  pages = 1,
): Promise<ParsedJob[]> {
  if (!credentials.careerjetAffiliateId) return [];
  const byUrl = new Map<string, ParsedJob>();
  for (const term of terms.length ? terms : ['']) {
    for (let page = 1; page <= pages; page += 1) {
      const url = new URL('https://public.api.careerjet.net/search');
      url.searchParams.set('affid', credentials.careerjetAffiliateId);
      url.searchParams.set('locale_code', CAREERJET_LOCALE[country]);
      url.searchParams.set('pagesize', String(RESULTS_PER_PAGE));
      url.searchParams.set('page', String(page));
      url.searchParams.set('contracttype', 'p');
      if (term.trim()) url.searchParams.set('keywords', term.trim());
      if (location.trim()) url.searchParams.set('location', location.trim());
      const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Careerjet request failed (${response.status}).`);
      const payload = await response.json() as { jobs?: CareerjetResult[] };
      const jobs = payload.jobs ?? [];
      for (const entry of jobs) {
        if (!entry.url || !entry.title) continue;
        byUrl.set(entry.url, {
          sourceUrl: entry.url,
          title: entry.title,
          company: entry.company ?? '',
          location: entry.locations || fallbackLocation(country),
          descriptionHtml: entry.description ?? '',
          postedAt: entry.date ?? '',
        });
      }
      if (jobs.length < RESULTS_PER_PAGE) break;
    }
  }
  return [...byUrl.values()];
}
