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

function postingToParsed(sourceUrl: string, html: string, fallbackLocation: string): ParsedJob | null {
  const posting = extractJobPosting(html);
  if (posting?.title && posting.description) {
    const address = posting.jobLocation?.address;
    return {
      sourceUrl,
      title: posting.title,
      company: posting.hiringOrganization?.name ?? '',
      location: [address?.addressLocality, address?.addressRegion, address?.postalCode]
        .filter(Boolean).join(' ') || fallbackLocation,
      descriptionHtml: posting.description,
      postedAt: normalizePostedAt(posting.datePosted),
    };
  }

  // Undutchables currently publishes a JobPosting block whose HTML description can contain
  // unescaped quotes. Use field boundaries as a conservative fallback when JSON.parse fails.
  const title = html.match(/"title"\s*:\s*"([\s\S]*?)"\s*,\s*"description"/i)?.[1];
  const description = html.match(/"description"\s*:\s*"([\s\S]*?)"\s*,\s*"datePosted"/i)?.[1];
  if (!title || !description) return null;
  const company = html.match(/"hiringOrganization"[\s\S]{0,500}?"name"\s*:\s*"([^"]*)"/i)?.[1] ?? '';
  const location = html.match(/"addressLocality"\s*:\s*"([^"]*)"/i)?.[1] ?? fallbackLocation;
  const postedAt = html.match(/"datePosted"\s*:\s*"([^"]*)"/i)?.[1] ?? '';
  return { sourceUrl, title, company, location, descriptionHtml: description, postedAt: normalizePostedAt(postedAt) };
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
    search: () => listingLinks('https://www.iamexpat.nl/career/jobs-netherlands', 'IamExpat',
      /href=["']([^"']*\/career\/jobs-netherlands\/[^"'?]+\/[^"'?]+)["']/gi, 'https://www.iamexpat.nl'),
    fetchDetail: (url) => fetchStructuredDetail(url, 'IamExpat', 'Netherlands'),
  },
  {
    key: 'undutchables.nl', name: 'Undutchables', country: 'netherlands', availability: 'enabled',
    availabilityMessage: 'Capped public listing adapter; query-string search is not used.',
    search: () => listingLinks('https://undutchables.nl/vacancies', 'Undutchables',
      /href=["'](https:\/\/undutchables\.nl\/vacancies\/[^"'?]+)["']/gi, 'https://undutchables.nl'),
    fetchDetail: (url) => fetchStructuredDetail(url, 'Undutchables', 'Netherlands'),
  },
  {
    key: 'indeed-ch', name: 'Indeed Switzerland', country: 'switzerland', availability: 'blocked',
    availabilityMessage: 'Not searched: Indeed prohibits automated access without written permission and returned HTTP 403.',
  },
  {
    key: 'job-room.ch', name: 'Job-Room', country: 'switzerland', availability: 'unavailable',
    availabilityMessage: 'Not searched: the published API is for employers posting jobs, not public job-seeker search.',
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
  const text = `${job.title} ${stripHtml(job.descriptionHtml)}`.toLocaleLowerCase('en');
  return roles.some((role) => role.toLocaleLowerCase('en').split(/\s+/).filter((word) => word.length > 2)
    .some((word) => text.includes(word)));
}

export { REQUEST_DELAY_MS };
