const SEARCH_URL = 'https://www.jobs.ch/en/vacancies/';
const DETAIL_ID_PATTERN = /vacancies\/detail\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export const RESULTS_PAGE = 1;
export const MAX_NEW_JOBS_PER_RUN = 8;
const REQUEST_DELAY_MS = 1500;

export interface ParsedJob {
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  descriptionHtml: string;
}

interface JobPostingLd {
  '@type'?: string;
  title?: string;
  description?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressRegion?: string; postalCode?: string } };
}

export function isJobsChUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && (parsed.hostname === 'jobs.ch' || parsed.hostname === 'www.jobs.ch');
  } catch {
    return false;
  }
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function interleaveUnique(groups: string[][]) {
  const result: string[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      const value = group[index];
      if (value && !seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
    }
  }
  return result;
}

export function stripHtml(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchUrl(term: string, page: number) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('term', term);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

async function fetchHtml(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
  if (!response.ok) throw new Error(`jobs.ch request failed (${response.status}).`);
  return response.text();
}

/** Server-rendered search results page: extract unique job-detail links. No JS execution needed. */
export async function fetchSearchResultIds(term: string, page = RESULTS_PAGE): Promise<string[]> {
  const html = await fetchHtml(buildSearchUrl(term, page));
  const ids = new Set<string>();
  for (const match of html.matchAll(DETAIL_ID_PATTERN)) ids.add(match[1].toLowerCase());
  return [...ids].map((id) => `https://www.jobs.ch/en/vacancies/detail/${id}/`);
}

function extractJobPosting(html: string): JobPostingLd | null {
  const blocks = html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const parsed: unknown = JSON.parse(block[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && (candidate as JobPostingLd)['@type'] === 'JobPosting') {
          return candidate as JobPostingLd;
        }
      }
    } catch {
      // Malformed or unrelated block; keep looking.
    }
  }
  return null;
}

/** Server-rendered job detail page: pull the schema.org JobPosting JSON-LD block (the same structured data job aggregators consume) rather than scraping arbitrary DOM. Returns null on any parse failure so one bad listing never fails a batch. */
export async function fetchJobDetail(sourceUrl: string): Promise<ParsedJob | null> {
  if (!isJobsChUrl(sourceUrl)) return null;
  let html: string;
  try {
    html = await fetchHtml(sourceUrl);
  } catch {
    return null;
  }
  const posting = extractJobPosting(html);
  if (!posting?.title || !posting.description) return null;
  const address = posting.jobLocation?.address;
  const location = [address?.addressRegion, address?.postalCode].filter(Boolean).join(' ') || 'Switzerland';
  return {
    sourceUrl,
    title: posting.title,
    company: posting.hiringOrganization?.name ?? '',
    location,
    descriptionHtml: posting.description,
  };
}

export { REQUEST_DELAY_MS };
