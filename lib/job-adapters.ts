import { searchAdzuna, searchCareerjet, type AggregatorCredentials } from './job-aggregators';
import { searchJobRoom } from './job-room';
import { delay, extractJobPosting, interleaveUnique, stripHtml, type ParsedJob } from './jobsch';
import type { JobCountry, SourceRunStatus } from './types';

const USER_AGENT = 'Northbound/0.1 personal job-search companion';
const REQUEST_DELAY_MS = 1200;

export interface JobSourceAdapter {
  key: string;
  name: string;
  country: JobCountry;
  availability: 'enabled' | 'blocked' | 'disabled' | 'unavailable';
  availabilityMessage: string;
  search?: (terms: string[], location: string) => Promise<string[]>;
  fetchDetail?: (url: string) => Promise<ParsedJob | null>;
  /** Sources whose search response already carries whole advertisements: one request yields many jobs, with no per-job fetch. */
  searchDetailed?: (terms: string[], location: string, credentials: AggregatorCredentials) => Promise<ParsedJob[]>;
  /** Keyed integrations report themselves unavailable until the user supplies free credentials. */
  hasCredentials?: (credentials: AggregatorCredentials) => boolean;
}

async function fetchHtml(url: string, sourceName: string) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
  if (!response.ok) throw new Error(`${sourceName} request failed (${response.status}).`);
  return response.text();
}

function uniqueMatches(html: string, pattern: RegExp, makeUrl: (match: RegExpMatchArray) => string) {
  const urls = new Set<string>();
  for (const match of html.matchAll(pattern)) urls.add(makeUrl(match));
  return [...urls];
}

function normalizePostedAt(value: string | undefined) {
  if (!value) return '';
  const european = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (european) return `${european[3]}-${european[2]}-${european[1]}`;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value.slice(0, 40) : date.toISOString();
}

function decodeLooseJsonString(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\//g, '/');
  }
}

export function postingToParsed(sourceUrl: string, html: string, fallbackLocation: string): ParsedJob | null {
  const posting = extractJobPosting(html);
  if (posting?.title && posting.description) {
    const address = posting.jobLocation?.address;
    return {
      sourceUrl,
      title: posting.title,
      company: posting.hiringOrganization?.name ?? '',
      location: [address?.addressLocality, address?.addressRegion, address?.postalCode, address?.addressCountry]
        .filter(Boolean).join(' ') || fallbackLocation,
      descriptionHtml: posting.description,
      postedAt: normalizePostedAt(posting.datePosted),
    };
  }

  // Undutchables currently publishes a JobPosting block whose HTML description can contain
  // unescaped quotes. Restrict relaxed extraction to that one JSON-LD block so unrelated
  // page data can never be absorbed into a title or description.
  const blocks = [...html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((block) => /"@type"\s*:\s*"JobPosting"/i.test(block));
  for (const block of blocks) {
    const title = block.match(/"title"\s*:\s*"([\s\S]*?)"\s*,\s*"description"/i)?.[1];
    const description = block.match(/"description"\s*:\s*"([\s\S]*?)"\s*,\s*"datePosted"/i)?.[1];
    if (!title || !description || title.length > 500) continue;
    const company = block.match(/"hiringOrganization"[\s\S]{0,800}?"name"\s*:\s*"([^"]*)"/i)?.[1] ?? '';
    const addressParts = [
      block.match(/"addressLocality"\s*:\s*"([^"]*)"/i)?.[1],
      block.match(/"addressRegion"\s*:\s*"([^"]*)"/i)?.[1],
      block.match(/"postalCode"\s*:\s*"([^"]*)"/i)?.[1],
      block.match(/"addressCountry"\s*:\s*"([^"]*)"/i)?.[1],
    ].filter(Boolean).map((value) => decodeLooseJsonString(value!));
    const postedAt = block.match(/"datePosted"\s*:\s*"([^"]*)"/i)?.[1] ?? '';
    return {
      sourceUrl,
      title: decodeLooseJsonString(title),
      company: decodeLooseJsonString(company),
      location: addressParts.join(' ') || fallbackLocation,
      descriptionHtml: decodeLooseJsonString(description),
      postedAt: normalizePostedAt(postedAt),
    };
  }
  return null;
}

async function fetchStructuredDetail(url: string, sourceName: string, fallbackLocation: string) {
  try {
    return postingToParsed(url, await fetchHtml(url, sourceName), fallbackLocation);
  } catch {
    return null;
  }
}

function jobCloudSearchAdapter(options: {
  key: string;
  name: string;
  baseUrl: string;
  termParameter: string;
  locationParameter: string;
  detailPattern: RegExp;
  detailUrl: (match: RegExpMatchArray) => string;
}) {
  return async (terms: string[], location: string) => {
    const groups: string[][] = [];
    for (const [index, term] of terms.entries()) {
      if (index > 0) await delay(REQUEST_DELAY_MS);
      const url = new URL(options.baseUrl);
      url.searchParams.set(options.termParameter, term);
      if (location.trim()) url.searchParams.set(options.locationParameter, location.trim());
      const html = await fetchHtml(url.toString(), options.name);
      groups.push(uniqueMatches(html, options.detailPattern, options.detailUrl));
    }
    return interleaveUnique(groups);
  };
}

async function listingLinks(url: string, sourceName: string, pattern: RegExp, origin: string) {
  const html = await fetchHtml(url, sourceName);
  return uniqueMatches(html, pattern, (match) => new URL(match[1], origin).toString())
    .filter((entry) => !/\/p\d+\/?$/i.test(new URL(entry).pathname));
}

const roleTitleNouns = new Set(['analyst', 'manager', 'specialist', 'consultant', 'engineer', 'lead', 'director', 'architect']);

function normalizedWords(value: string) {
  return value.toLocaleLowerCase('en').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((word) => word.length > 2);
}

export function candidateUrlMatchesRoles(url: string, roles: string[]) {
  if (!roles.length) return true;
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return false; }
  const pathWords = new Set(normalizedWords(path));
  return roles.some((role) => {
    const words = normalizedWords(role);
    if (!words.length) return false;
    const noun = [...words].reverse().find((word) => roleTitleNouns.has(word));
    if (noun) return pathWords.has(noun);
    return words.every((word) => pathWords.has(word));
  });
}

const jobsChSearch = jobCloudSearchAdapter({
  key: 'jobs.ch',
  name: 'jobs.ch',
  baseUrl: 'https://www.jobs.ch/en/vacancies/',
  termParameter: 'term',
  locationParameter: 'location',
  detailPattern: /https:\/\/www\.jobs\.ch\/en\/vacancies\/detail\/([0-9a-f-]{36})\//gi,
  detailUrl: (match) => `https://www.jobs.ch/en/vacancies/detail/${match[1].toLowerCase()}/`,
});

const jobupSearch = jobCloudSearchAdapter({
  key: 'jobup.ch',
  name: 'jobup.ch',
  baseUrl: 'https://www.jobup.ch/en/jobs/',
  termParameter: 'term',
  locationParameter: 'location',
  detailPattern: /https:\/\/www\.jobup\.ch\/en\/jobs\/detail\/([0-9a-f-]{36})\//gi,
  detailUrl: (match) => `https://www.jobup.ch/en/jobs/detail/${match[1].toLowerCase()}/`,
});

const jobScoutSearch = jobCloudSearchAdapter({
  key: 'jobscout24.ch',
  name: 'JobScout24',
  baseUrl: 'https://www.jobscout24.ch/en/jobs/',
  termParameter: 'what',
  locationParameter: 'where',
  detailPattern: /href="\/en\/job\/([0-9a-f-]{36})\/"/gi,
  detailUrl: (match) => `https://www.jobscout24.ch/en/job/${match[1].toLowerCase()}/`,
});

export const jobSourceAdapters: JobSourceAdapter[] = [
  {
    key: 'job-room.ch', name: 'Job-Room (arbeit.swiss)', country: 'switzerland', availability: 'enabled',
    availabilityMessage: 'Official Swiss public employment service; unauthenticated public search API with employer-declared language requirements.',
    searchDetailed: (terms) => searchJobRoom(terms),
  },
  {
    key: 'adzuna-ch', name: 'Adzuna Switzerland', country: 'switzerland', availability: 'enabled',
    availabilityMessage: 'Authorized aggregator API. Add a free ADZUNA_APP_ID and ADZUNA_APP_KEY to enable it.',
    searchDetailed: (terms, location, credentials) => searchAdzuna(terms, location, 'switzerland', credentials),
    hasCredentials: (credentials) => Boolean(credentials.adzunaAppId && credentials.adzunaAppKey),
  },
  {
    key: 'adzuna-nl', name: 'Adzuna Netherlands', country: 'netherlands', availability: 'enabled',
    availabilityMessage: 'Authorized aggregator API. Add a free ADZUNA_APP_ID and ADZUNA_APP_KEY to enable it.',
    searchDetailed: (terms, location, credentials) => searchAdzuna(terms, location, 'netherlands', credentials),
    hasCredentials: (credentials) => Boolean(credentials.adzunaAppId && credentials.adzunaAppKey),
  },
  {
    key: 'careerjet-ch', name: 'Careerjet Switzerland', country: 'switzerland', availability: 'enabled',
    availabilityMessage: 'Authorized aggregator API. Add a free CAREERJET_AFFID to enable it.',
    searchDetailed: (terms, location, credentials) => searchCareerjet(terms, location, 'switzerland', credentials),
    hasCredentials: (credentials) => Boolean(credentials.careerjetAffiliateId),
  },
  {
    key: 'careerjet-nl', name: 'Careerjet Netherlands', country: 'netherlands', availability: 'enabled',
    availabilityMessage: 'Authorized aggregator API. Add a free CAREERJET_AFFID to enable it.',
    searchDetailed: (terms, location, credentials) => searchCareerjet(terms, location, 'netherlands', credentials),
    hasCredentials: (credentials) => Boolean(credentials.careerjetAffiliateId),
  },
  {
    key: 'jobs.ch', name: 'jobs.ch', country: 'switzerland', availability: 'enabled',
    availabilityMessage: 'Capped public-page adapter; JobCloud permission has not been granted.',
    search: jobsChSearch,
    fetchDetail: (url) => fetchStructuredDetail(url, 'jobs.ch', 'Switzerland'),
  },
  {
    key: 'jobup.ch', name: 'jobup.ch', country: 'switzerland', availability: 'enabled',
    availabilityMessage: 'Capped public-page adapter; JobCloud permission has not been granted.',
    search: jobupSearch,
    fetchDetail: (url) => fetchStructuredDetail(url, 'jobup.ch', 'Switzerland'),
  },
  {
    key: 'jobscout24.ch', name: 'JobScout24', country: 'switzerland', availability: 'enabled',
    availabilityMessage: 'Capped public-page adapter; JobCloud permission has not been granted.',
    search: jobScoutSearch,
    fetchDetail: (url) => fetchStructuredDetail(url, 'JobScout24', 'Switzerland'),
  },
  {
    key: 'iamexpat.nl', name: 'IamExpat', country: 'netherlands', availability: 'enabled',
    availabilityMessage: 'Capped public-page adapter; current public listings only.',
    search: async (terms) => (await listingLinks('https://www.iamexpat.nl/career/jobs-netherlands', 'IamExpat',
      /href=["']([^"']*\/career\/jobs-netherlands\/[^"'?]+\/[^"'?]+)["']/gi, 'https://www.iamexpat.nl'))
      .filter((url) => candidateUrlMatchesRoles(url, terms)),
    fetchDetail: (url) => fetchStructuredDetail(url, 'IamExpat', 'Netherlands'),
  },
  {
    key: 'undutchables.nl', name: 'Undutchables', country: 'netherlands', availability: 'enabled',
    availabilityMessage: 'Capped public listing adapter; query-string search is not used.',
    search: async (terms) => (await listingLinks('https://undutchables.nl/vacancies', 'Undutchables',
      /href=["'](https:\/\/undutchables\.nl\/vacancies\/[^"'?]+)["']/gi, 'https://undutchables.nl'))
      .filter((url) => candidateUrlMatchesRoles(url, terms)),
    fetchDetail: (url) => fetchStructuredDetail(url, 'Undutchables', 'Netherlands'),
  },
  {
    key: 'indeed-ch', name: 'Indeed Switzerland', country: 'switzerland', availability: 'blocked',
    availabilityMessage: 'Not searched: Indeed prohibits automated access without written permission and returned HTTP 403.',
  },
  {
    key: 'indeed-nl', name: 'Indeed Netherlands', country: 'netherlands', availability: 'blocked',
    availabilityMessage: 'Not searched: Indeed prohibits automated access without written permission and returned HTTP 403.',
  },
  {
    key: 'nationalevacaturebank.nl', name: 'Nationale Vacaturebank', country: 'netherlands', availability: 'unavailable',
    availabilityMessage: 'Not searched: automated access returned HTTP 403; no authorized feed is configured.',
  },
  {
    key: 'iamsterdam.com', name: 'I amsterdam', country: 'netherlands', availability: 'disabled',
    availabilityMessage: 'Not searched: this is a job-search guide, not a vacancy feed.',
  },
];

export function sourceStatusForAvailability(availability: JobSourceAdapter['availability']): SourceRunStatus {
  return availability === 'enabled' ? 'complete' : availability;
}

export function descriptionMatchesRoles(job: ParsedJob, roles: string[]) {
  if (!roles.length) return true;
  const titleWords = new Set(normalizedWords(job.title));
  const textWords = new Set(normalizedWords(`${job.title} ${stripHtml(job.descriptionHtml)}`));
  return roles.some((role) => {
    const words = normalizedWords(role);
    if (!words.length) return false;
    const noun = [...words].reverse().find((word) => roleTitleNouns.has(word));
    if (noun) {
      const qualifiers = words.filter((word) => word !== noun);
      return titleWords.has(noun) && (!qualifiers.length || qualifiers.some((word) => textWords.has(word)));
    }
    return words.every((word) => textWords.has(word));
  });
}

export { REQUEST_DELAY_MS };
