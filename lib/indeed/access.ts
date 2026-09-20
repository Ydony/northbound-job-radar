import { isIndeedUrl } from './normalize';

export const INDEED_SOURCE_KEYS = ['indeed', 'indeed-ch', 'indeed-nl', 'indeed.com', 'www.indeed.com',
  'nl.indeed.com', 'ch.indeed.com', 'indeed.nl', 'indeed.ch'];
export function isIndeedRecord(key: string, url: string) {
  return INDEED_SOURCE_KEYS.includes(key.toLowerCase()) || isIndeedUrl(url);
}

/** Code-owned column names only; covers legacy rows whose source key was missing/wrong. */
export function indeedSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `(${prefix}source_key IN ('indeed','indeed-ch','indeed-nl','indeed.com','www.indeed.com','nl.indeed.com','ch.indeed.com','indeed.nl','indeed.ch')
    OR lower(${prefix}source_url) LIKE 'https://indeed.com/%'
    OR lower(${prefix}source_url) LIKE 'https://%.indeed.com/%'
    OR lower(${prefix}source_url) LIKE 'https://indeed.nl/%'
    OR lower(${prefix}source_url) LIKE 'https://%.indeed.nl/%'
    OR lower(${prefix}source_url) LIKE 'https://indeed.ch/%'
    OR lower(${prefix}source_url) LIKE 'https://%.indeed.ch/%')`;
}

export function isLoopbackRequest(request: Request) {
  const url = new URL(request.url);
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && (url.protocol === 'http:' || url.protocol === 'https:');
}
