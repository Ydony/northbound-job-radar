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
  postedAt: string;
}

export interface JobPostingLd {
  '@type'?: string;
  title?: string;
  description?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; postalCode?: string; addressCountry?: string } };
  datePosted?: string;
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

const namedEntities: Record<string, string> = {
  amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
};

/**
 * Turn HTML entities back into the characters they stand for.
 *
 * Feeds hand us titles with the tags already removed but the entities still encoded, so
 * "Senior Cost &amp; Inventory Analyst" was displayed literally and — worse — did not match its
 * own duplicate spelled with a real ampersand. Titles never went through stripHtml, which is why
 * this decoding has to be callable on its own.
 */
export function decodeEntities(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name) => namedEntities[name.toLowerCase()] ?? match);
}

/**
 * Flatten HTML to text while keeping the line structure that makes an advertisement readable.
 *
 * This used to collapse every run of whitespace, which meant a `<ul>` of requirements arrived as
 * one unbroken paragraph — jobs.ch descriptions averaged 3,173 characters with no structure left
 * at all. Keeping list items and block boundaries as newlines is what makes it possible to show
 * requirements on a card, and it sharpens the language gate too: that splits on newlines when
 * deciding which cue belongs to which language mention, so bullets no longer bleed into each other.
 */
export function stripHtml(html: string) {
  const withBreaks = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|h[1-6]|ul|ol|li|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    // A bullet with nothing after it is a layout artefact of the source markup, not a requirement.
    .replace(/\n?• *(?=\n|$)/g, '')
    // One newline per break, uniformly: adjacent block tags each emit one, and a blank line
    // carries no meaning that the card cannot add back when it renders.
    .replace(/\n+/g, '\n')
    .trim();
}

export function buildSearchUrl(term: string, page: number, location = '') {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('term', term);
  if (location.trim()) url.searchParams.set('location', location.trim());
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

async function fetchHtml(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
  if (!response.ok) throw new Error(`jobs.ch request failed (${response.status}).`);
  return response.text();
}

/** Server-rendered search results page: extract unique job-detail links. No JS execution needed. */
export async function fetchSearchResultIds(term: string, page = RESULTS_PAGE, location = ''): Promise<string[]> {
  const html = await fetchHtml(buildSearchUrl(term, page, location));
  const ids = new Set<string>();
  for (const match of html.matchAll(DETAIL_ID_PATTERN)) ids.add(match[1].toLowerCase());
  return [...ids].map((id) => `https://www.jobs.ch/en/vacancies/detail/${id}/`);
}

function candidatesFromJsonLd(value: unknown): JobPostingLd[] {
  if (Array.isArray(value)) return value.flatMap(candidatesFromJsonLd);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [value as JobPostingLd, ...candidatesFromJsonLd(record['@graph'])];
}

export function extractJobPosting(html: string): JobPostingLd | null {
  const blocks = html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const parsed: unknown = JSON.parse(block[1]);
      const candidates = candidatesFromJsonLd(parsed);
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && (candidate as JobPostingLd)['@type'] === 'JobPosting') {
          return candidate as JobPostingLd;
        }
      }
    } catch {
      // Malformed or unrelated block; keep looking.
    }
  }
  for (const match of html.matchAll(/"children":"((?:\\.|[^"\\])*)"/g)) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`) as string;
      const parsed: unknown = JSON.parse(decoded);
      const posting = candidatesFromJsonLd(parsed).find((candidate) => candidate['@type'] === 'JobPosting');
      if (posting) return posting;
    } catch {
      // Not a JSON-LD children payload.
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
  const location = [address?.addressLocality, address?.addressRegion, address?.postalCode]
    .filter(Boolean).join(' ') || 'Switzerland';
  return {
    sourceUrl,
    title: posting.title,
    company: posting.hiringOrganization?.name ?? '',
    location,
    descriptionHtml: posting.description,
    postedAt: posting.datePosted ?? '',
  };
}

export { REQUEST_DELAY_MS };
