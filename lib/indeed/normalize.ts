import { analyzeLanguage, type LanguageResult } from '../analysis';
import { stripHtml, type ParsedJob } from '../jobsch';
import type { IndeedCountry, IndeedRecord } from './contracts';

export function isIndeedUrl(value: string) {
  try { return /(^|\.)indeed\.(com|nl|ch)$/i.test(new URL(value).hostname); }
  catch { return false; }
}

/**
 * A teaser that ends in a link rather than an ellipsis. The shared gate already catches the
 * ellipsis form; this is the one truncation shape it has no reason to carry.
 *
 * Only ever tested against the tail of an advertisement: "read more about our benefits" is
 * ordinary copy in the middle of one.
 */
const TRUNCATION_LINK = /\b(?:read|show|see) more\b|\bcontinue reading\b|\bview (?:the )?(?:full|complete|entire)\b/i;

/**
 * Indeed advertisements go through the same gate as every other source.
 *
 * This used to force `unknown` on everything the gate did not block, because the API's
 * description field carried no completeness guarantee. The effect was an asymmetry nothing
 * justified: the app trusted this text enough to *reject* a job on it - 8 of the 27
 * advertisements in the first live run were correctly excluded as Dutch, German or French,
 * each with a specific reason - while never trusting it enough to *accept* one. No Indeed
 * job could reach the matches list, whatever it said.
 *
 * The shared gate already withholds a pass from text it cannot vouch for: under
 * MIN_CHARS_TO_CONFIRM_ENGLISH characters, or ending in an ellipsis, it returns `unknown`
 * on its own. That protection was written for the EURES advertisements that arrive cut at
 * ~2,000 characters, and it applies here unchanged.
 *
 * Measured over those 27 advertisements: 2,692 to 8,200 characters, mean 5,115, not one
 * truncation marker among them, and every one ending on a real document boundary -
 * equal-opportunity boilerplate, a privacy statement, a reference code, a recruiter's
 * address. No teaser appeared in the sample, so treating every advertisement as a suspected
 * teaser was costing every verdict and buying nothing.
 */
export function languageForIndeed(description: string, title: string): LanguageResult {
  const result = analyzeLanguage(description, title);
  // A block needs no completeness guarantee. The evidence that disqualifies the advertisement
  // is in the text already read, and more of it could not un-say what was found.
  if (result.status === 'blocked') return result;
  if (TRUNCATION_LINK.test(description.trimEnd().slice(-200))) {
    return { status: 'unknown',
      summary: 'Not enough of the advertisement was published to confirm English is sufficient: it ends with a link to the rest, so a language requirement after the cut cannot be ruled out. Open the original to check.',
      signals: [...result.signals, 'The Indeed description ends with a link to the rest of the advertisement.'] };
  }
  return result;
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
