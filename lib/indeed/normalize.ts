import { analyzeLanguage, type LanguageResult } from '../analysis';
import { stripHtml, type ParsedJob } from '../jobsch';
import type { IndeedCountry, IndeedRecord } from './contracts';

export function isIndeedUrl(value: string) {
  try { return /(^|\.)indeed\.(com|nl|ch)$/i.test(new URL(value).hostname); }
  catch { return false; }
}

/** No trusted full-advertisement guarantee exists for this experimental transport. */
export function languageForIndeed(description: string, title: string): LanguageResult {
  const result = analyzeLanguage(description, title);
  if (result.status === 'blocked') return result;
  return { status: 'unknown', summary: 'Description completeness is unverified. Check the original advertisement before assuming English is sufficient.',
    signals: [...result.signals, 'Indeed API description; completeness not established.'] };
}

export function normalizeIndeed(record: IndeedRecord, country: IndeedCountry): ParsedJob | null {
  if (record.country !== country || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.key)) return null;
  try {
    const title = stripHtml(record.title).trim();
    if (!title || title.length > 240 || record.descriptionHtml.length > 120_000) return null;
    stripHtml(record.descriptionHtml); // Reject malformed entities before the shared parser runs.
    const sourceUrl = new URL('/viewjob', country === 'NL' ? 'https://nl.indeed.com' : 'https://ch.indeed.com');
    sourceUrl.searchParams.set('jk', record.key);
    return { sourceUrl: sourceUrl.href, title, company: stripHtml(record.employer),
      location: [stripHtml(record.city), country === 'NL' ? 'Netherlands' : 'Switzerland'].filter(Boolean).join(', '),
      // Keep original blocks/lists until the common server-side HTML-to-text conversion.
      descriptionHtml: record.descriptionHtml,
      postedAt: record.postedAtMs !== null && Number.isFinite(record.postedAtMs)
        && record.postedAtMs >= 0 && record.postedAtMs <= 8.64e15 ? new Date(record.postedAtMs).toISOString() : '' };
  } catch { return null; }
}
