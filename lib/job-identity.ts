import type { JobCountry } from './types';

export interface JobIdentityInput {
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  postedAt?: string;
}

export interface SourceInfo {
  key: string;
  name: string;
  country: JobCountry;
}

const sources: Record<string, SourceInfo> = {
  'jobs.ch': { key: 'jobs.ch', name: 'jobs.ch', country: 'switzerland' },
  'www.jobs.ch': { key: 'jobs.ch', name: 'jobs.ch', country: 'switzerland' },
  'jobup.ch': { key: 'jobup.ch', name: 'jobup.ch', country: 'switzerland' },
  'www.jobup.ch': { key: 'jobup.ch', name: 'jobup.ch', country: 'switzerland' },
  'jobscout24.ch': { key: 'jobscout24.ch', name: 'JobScout24', country: 'switzerland' },
  'www.jobscout24.ch': { key: 'jobscout24.ch', name: 'JobScout24', country: 'switzerland' },
  'ch.indeed.com': { key: 'indeed-ch', name: 'Indeed Switzerland', country: 'switzerland' },
  'nl.indeed.com': { key: 'indeed-nl', name: 'Indeed Netherlands', country: 'netherlands' },
  'iamexpat.nl': { key: 'iamexpat.nl', name: 'IamExpat', country: 'netherlands' },
  'www.iamexpat.nl': { key: 'iamexpat.nl', name: 'IamExpat', country: 'netherlands' },
  'undutchables.nl': { key: 'undutchables.nl', name: 'Undutchables', country: 'netherlands' },
  'www.undutchables.nl': { key: 'undutchables.nl', name: 'Undutchables', country: 'netherlands' },
  'nationalevacaturebank.nl': { key: 'nationalevacaturebank.nl', name: 'Nationale Vacaturebank', country: 'netherlands' },
  'www.nationalevacaturebank.nl': { key: 'nationalevacaturebank.nl', name: 'Nationale Vacaturebank', country: 'netherlands' },
};

const trackingParameters = new Set(['fbclid', 'gclid', 'trk', 'trackingid']);
const swissLocations = /\b(?:switzerland|swiss|zürich|zurich|geneva|genève|basel|bern|lausanne|zug|lucerne|luzern|winterthur)\b/i;
const netherlandsLocations = /\b(?:netherlands|nederland|amsterdam|rotterdam|utrecht|eindhoven|den haag|the hague|haarlem|leiden|delft|breda)\b/i;
const outsideSupportedLocations = /\b(?:germany|deutschland|essen|belgium|belgie|belgique|france|luxembourg|austria|osterreich)\b/i;

function normalizedHost(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function normalizedIdentityText(value: string) {
  return value.toLocaleLowerCase('en')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function canonicalJobUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.startsWith('utm_') || trackingParameters.has(normalizedKey)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function sourceInfoForUrl(value: string, location = ''): SourceInfo {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const known = sources[host];
    if (known) {
      if (known.country === 'netherlands' && outsideSupportedLocations.test(location)) {
        return { ...known, country: 'unknown' };
      }
      return known;
    }
    const key = normalizedHost(host);
    const country: JobCountry = host.endsWith('.ch')
      ? 'switzerland'
      : host.endsWith('.nl')
        ? 'netherlands'
        : swissLocations.test(location)
          ? 'switzerland'
          : netherlandsLocations.test(location)
            ? 'netherlands'
            : 'unknown';
    return { key, name: key, country };
  } catch {
    return { key: 'unknown', name: 'Unknown source', country: 'unknown' };
  }
}

export function sourceJobIdFromUrl(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    const uuid = path.match(/(?:detail|job)\/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1];
    if (uuid) return uuid.toLowerCase();
    if (url.hostname.toLowerCase().includes('indeed.')) return url.searchParams.get('jk') ?? '';
    if (/iamexpat\.nl$/i.test(url.hostname)) return path.split('/').pop() ?? '';
    if (/undutchables\.nl$/i.test(url.hostname)) return path.startsWith('/vacancies/') ? path.split('/').pop() ?? '' : '';
    return '';
  } catch {
    return '';
  }
}

export function isGloballyStableSourceJobId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function jobIdentityFingerprint(input: JobIdentityInput) {
  const postedDay = input.postedAt ? input.postedAt.slice(0, 10) : '';
  const parts = [input.title, input.company, input.location, postedDay].map(normalizedIdentityText);
  if (parts.some((part) => !part)) return '';
  return `job-v1-${stableHash(parts.join('|'))}`;
}

export function countryLabel(country: JobCountry) {
  if (country === 'switzerland') return 'Switzerland';
  if (country === 'netherlands') return 'Netherlands';
  return 'Country unknown';
}
