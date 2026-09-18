/**
 * One short line per job saying what the employer is asking for.
 *
 * The card already answers "is this English?" and "what is it called?". It did not answer the
 * question that decides whether to open the ad at all: *can I do this job?* The requirements
 * expander answers it where an advertisement states requirements under a heading, but that is
 * only 22% of long advertisements (see lib/requirements.ts) — the rest showed the title, the
 * employer, the place and nothing about the work.
 *
 * So this falls back through three sources, best first, and says which one it used so the card
 * never presents a guess with the same confidence as a quotation:
 *
 * 1. `requirements` — the employer's own requirements list, already extracted under a heading.
 * 2. Sentences that explicitly state a requirement ("you have a degree in", "3+ years of"). Cue
 *    words only; a sentence is never included for being near the top of the ad.
 * 3. The first real sentence of the advertisement, once company boilerplate is skipped. This says
 *    what the job is rather than what is asked, and is labelled accordingly.
 *
 * lib/requirements.ts warns that lines lifted from marketing copy are worse than showing nothing,
 * because they look like an answer. That is why 2 needs an explicit cue and 3 is labelled.
 *
 * **Length is capped deliberately.** docs/SOURCE_POLICY.md §1 keeps the employer's advertisement
 * text on the server: what a client receives is facts, our own work, and a link. A short quotation
 * of this size is the same exception §1 already makes for requirement bullets — the length of a
 * search-result snippet, not a copy of the advertisement.
 */
import type { ExtractedRequirements } from './requirements';

export const MAX_EXCERPT_CHARS = 400;

export type ExcerptSource = 'requirements' | 'asked' | 'role';

export interface JobExcerpt {
  text: string;
  source: ExcerptSource;
}

/**
 * Phrases that mark a sentence as stating what the candidate must bring, in the four languages
 * these advertisements are written in. A bare "skills" or "profile" is deliberately absent: both
 * describe the company as often as the candidate.
 */
const askedCues = [
  // English. "you are" and "you're" were here and are deliberately gone: they matched the closing
  // "Contact Information If you are interested in becoming part of our team", which is not a
  // requirement and read as though the job asked for enthusiasm.
  'you have', 'you possess', 'you bring', 'you will need', 'you should have', 'we ask',
  'we expect', 'we are looking for', "we're looking for", 'looking for someone', 'experience in',
  'experience with', 'years of experience', 'degree in', 'background in', 'proficient',
  'proficiency', 'fluent in', 'familiar with', 'knowledge of', 'skilled in', 'must have',
  'required', 'qualifications', 'ideally you', 'ability to',
  // German
  'sie bringen', 'du bringst', 'sie haben', 'du hast', 'erfahrung in', 'erfahrung mit',
  'kenntnisse', 'abgeschlossenes studium', 'wir erwarten', 'vorausgesetzt',
  // Dutch
  'je hebt', 'jij hebt', 'je brengt', 'ervaring met', 'ervaring in', 'kennis van',
  'wij vragen', 'wij zoeken', 'je beschikt',
  // French / Italian
  'vous avez', 'vous êtes', 'expérience en', 'expérience dans', 'connaissance de',
  'esperienza in', 'conoscenza di', 'sei in grado',
];

/**
 * Section labels that arrive glued to the sentence after them, because stripping HTML turns
 * "<h3>Job Description</h3><p>We build…</p>" into one line. Removed from the front of a line so the
 * excerpt reads as a sentence rather than "Job Description We build…".
 */
const gluedSectionLabels = [
  'job description', 'job responsibilities', 'responsibilities', 'role description', 'description',
  'about the role', 'the role', 'your tasks', 'tasks', 'your mission', 'what you will do',
  'qualification path', 'qualifications', 'your profile', 'introduction', 'position',
  'stellenbeschreibung', 'ihre aufgaben', 'deine aufgaben', 'aufgaben', 'funktie', 'functieomschrijving',
];

/**
 * Prose about applying, not about qualifying. These carry requirement cues by accident — "If **you
 * have** any question, please do not hesitate to contact our Talent Acquisition Team" matched "you
 * have" and was shown as what the job asks for.
 */
const applyingProse = [
  'hesitate to contact', 'do not hesitate', 'please contact', 'get in touch', 'reach out to',
  'if you have any question', 'send your', 'send us your', 'apply via', 'apply through',
  'write an email', 'look forward to receiving', 'talent acquisition', 'our recruiter',
  'zögern sie nicht', 'kontaktieren sie', 'bewerben sie sich', 'neem contact op', 'solliciteer',
];

/** Sections that are not about the candidate at all. A line starting with one of these is dropped. */
const closingSectionLabels = [
  'contact information', 'contact', 'how to apply', 'apply now', 'application', 'we offer',
  'what we offer', 'benefits', 'about us', 'about the company',
  'wir bieten', 'unser angebot', 'kontakt', 'bewerbung', 'wij bieden', 'solliciteren',
];

/** Openers that describe the company rather than the job. Skipped when falling back to source 3. */
const boilerplateOpeners = [
  'about us', 'about the company', 'who we are', 'our story', 'our mission', 'company description',
  'über uns', 'uber uns', 'wer wir sind', 'unternehmen', 'over ons', 'wie wij zijn',
  'à propos', 'a propos', 'qui sommes nous', 'chi siamo',
];

function tidy(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Abbreviations that end in a full stop mid-sentence, which must not split the line. */
const ABBREVIATIONS = /(?<!\b(?:z\.?B|e\.?g|i\.?e|etc|bzw|u\.a|ca|resp|incl|approx|Dr|Mr|Ms|St)\.)/i;

/** Splits on sentence ends and on the line breaks a bullet list uses instead of full stops. */
function sentences(description: string) {
  return description
    .split(new RegExp(`\\n+|(?<=[.!?])${ABBREVIATIONS.source}\\s+`, 'i'))
    .map((line) => stripLabel(tidy(line).replace(/^[•*·●▪>-]\s*|^\d+[.)]\s*/, '').trim()))
    .filter(Boolean);
}

/** Removes a section label glued to the front of a line, keeping the sentence that followed it. */
function stripLabel(line: string) {
  const lower = line.toLowerCase();
  const label = gluedSectionLabels.find((candidate) => lower.startsWith(candidate));
  if (!label) return line;
  return line.slice(label.length).replace(/^\s*[::–—-]?\s*/, '').trim() || line;
}

function isAboutApplying(line: string) {
  const lower = line.toLowerCase();
  return closingSectionLabels.some((label) => lower.startsWith(label))
    || applyingProse.some((phrase) => lower.includes(phrase));
}

/** A fragment worth showing: long enough to say something, short enough not to be a paragraph. */
function isUsable(line: string) {
  return line.length >= 25 && line.length <= 300 && /[a-zà-ÿ]/i.test(line);
}

function looksLikeHeading(line: string) {
  return line.length <= 60 && !/[.!?]$/.test(line) && line.split(' ').length <= 6;
}

const SEPARATOR = ' · ';

/** Joins fragments until the cap, never cutting a fragment in half. */
function joinWithin(parts: string[], limit = MAX_EXCERPT_CHARS) {
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const addition = kept.length ? part.length + SEPARATOR.length : part.length;
    if (length + addition > limit) break;
    kept.push(part);
    length += addition;
  }
  if (kept.length) return kept.join(SEPARATOR);
  // Nothing fitted whole, so one fragment is trimmed at a word boundary rather than dropped.
  const first = parts[0] ?? '';
  if (first.length <= limit) return first;
  const cut = first.slice(0, limit - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).trim()}…`;
}

/**
 * What this employer is asking for, in one short line, or null when the advertisement says
 * nothing usable — which is a better card than an invented answer.
 */
export function jobExcerpt(
  description: string,
  requirements: ExtractedRequirements | null,
): JobExcerpt | null {
  if (requirements?.items.length) {
    return { text: joinWithin(requirements.items.map(tidy).filter(Boolean)), source: 'requirements' };
  }

  const lines = sentences(description);
  const asked = lines.filter((line) => {
    if (!isUsable(line) || looksLikeHeading(line) || isAboutApplying(line)) return false;
    const lower = line.toLowerCase();
    return askedCues.some((cue) => lower.includes(cue));
  });
  if (asked.length) return { text: joinWithin(asked), source: 'asked' };

  // Boilerplate is a section, not a line: "About us" is a heading and the company description sits
  // under it. Skipping only the heading leaves "We are a friendly company with a nice office" as
  // the answer to "can I do this job?".
  const afterBoilerplate: string[] = [];
  let inBoilerplate = false;
  for (const line of lines) {
    if (looksLikeHeading(line)) {
      const lower = line.toLowerCase();
      inBoilerplate = boilerplateOpeners.some((opener) => lower.startsWith(opener));
      continue;
    }
    if (inBoilerplate || !isUsable(line)) continue;
    afterBoilerplate.push(line);
  }
  if (afterBoilerplate.length) return { text: joinWithin(afterBoilerplate.slice(0, 2)), source: 'role' };
  return null;
}
