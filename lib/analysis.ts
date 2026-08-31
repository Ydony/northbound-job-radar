import { matchLanguagePhrases } from './language-rules';

/**
 * `pass` means English was *confirmed* sufficient on a complete advertisement.
 * `unknown` means the advertisement was too short to tell — not that it looked fine.
 *
 * Those two used to be the same value, and conflating them is what made the good bucket
 * untrustworthy: 84% of everything marked English-sufficient rested on a 500-character Adzuna
 * preview, and a language requirement lives near the end of an ad, past that cut. The gate was
 * reporting "no requirement found" when it had never been shown the part that has one.
 */
export type LanguageStatus = 'pass' | 'unknown' | 'review' | 'blocked';

/**
 * Below this, a description is a preview rather than an advertisement, and cannot support a pass.
 *
 * Measured across the stored corpus: Adzuna hard-caps at exactly 500 characters and Careerjet at
 * 279, while real advertisements from jobs.ch, EURES and the ATS boards run to a few thousand.
 * 900 sits clear of both caps without demanding that every short-but-complete posting be doubted.
 *
 * This gate applies to `pass` only. Absence of evidence invalidates a clean bill of health, but it
 * does not invalidate a finding: German spotted in a teaser is still German, so `blocked` and
 * `review` stand on however much text produced them.
 */
export const MIN_CHARS_TO_CONFIRM_ENGLISH = 900;

export interface LanguageResult {
  status: LanguageStatus;
  summary: string;
  signals: string[];
}

export interface FitResult {
  score: number;
  matched: string[];
  missing: string[];
}

export interface CvInput {
  slot: 'a' | 'b';
  cvText: string;
  derivedRole: string;
}

export interface FitBySlot {
  fitScoreA: number;
  fitScoreB: number;
  bestCvSlot: 'a' | 'b' | '';
  matchedKeywords: string[];
  missingKeywords: string[];
}

/** Employer-declared language requirement, as published by sources that expose structured fields (currently Job-Room). */
export interface StructuredLanguageSkill {
  languageIsoCode: string;
  spokenLevel: string | null;
  writtenLevel: string | null;
}

const languageLevelRank: Record<string, number> = { NONE: 0, BASIC: 1, INTERMEDIATE: 2, PROFICIENT: 3 };
const workingLevel = languageLevelRank.INTERMEDIATE;
const localIsoCodes: Record<string, string> = { de: 'German', fr: 'French', it: 'Italian', nl: 'Dutch' };

function highestLevel(skill: StructuredLanguageSkill) {
  return Math.max(languageLevelRank[skill.spokenLevel ?? 'NONE'] ?? 0, languageLevelRank[skill.writtenLevel ?? 'NONE'] ?? 0);
}

/**
 * Employer-declared requirements beat prose heuristics, so this takes precedence when a source
 * publishes them. Returns null when nothing is declared, letting `analyzeLanguage` run instead.
 * An ad can be written in German while only requiring English, which the prose gate cannot tell.
 */
export function analyzeStructuredLanguages(skills: StructuredLanguageSkill[]): LanguageResult | null {
  const declared = skills.filter((skill) => skill.languageIsoCode && highestLevel(skill) > 0);
  if (!declared.length) return null;

  const required = declared.filter((skill) => highestLevel(skill) >= workingLevel);
  const requiredLocal = required
    .filter((skill) => localIsoCodes[skill.languageIsoCode.toLowerCase()])
    .map((skill) => localIsoCodes[skill.languageIsoCode.toLowerCase()]);
  const englishLevel = Math.max(0, ...declared
    .filter((skill) => skill.languageIsoCode.toLowerCase() === 'en')
    .map(highestLevel));
  const signals = [`Employer-declared: ${declared
    .map((skill) => `${localIsoCodes[skill.languageIsoCode.toLowerCase()] ?? skill.languageIsoCode.toUpperCase()} ${
      skill.spokenLevel ?? skill.writtenLevel ?? 'NONE'}`)
    .join(', ')}`];

  if (requiredLocal.length) {
    return {
      status: 'blocked',
      summary: `Excluded: the employer requires ${[...new Set(requiredLocal)].join(', ')} at working level.`,
      signals,
    };
  }
  if (englishLevel >= workingLevel) {
    return {
      status: 'pass',
      summary: 'English is sufficient; the employer lists English and no local language at working level.',
      signals,
    };
  }
  return {
    status: 'review',
    summary: 'Needs review: the employer lists no local language at working level, but does not list English either.',
    signals,
  };
}

const localLanguages = ['german', 'french', 'italian', 'dutch', 'deutsch', 'français', 'francais', 'italiano', 'nederlands'];

const englishMarkers = new Set([
  'and', 'are', 'as', 'at', 'be', 'business', 'candidate', 'company', 'customer', 'experience', 'for', 'from',
  'have', 'in', 'including', 'is', 'job', 'knowledge', 'management', 'of', 'our', 'position', 'project', 'requirements',
  'responsibilities', 'role', 'skills', 'team', 'the', 'this', 'to', 'we', 'will', 'with', 'work', 'you', 'your',
]);

const nonEnglishMarkers = new Set([
  'aufgaben', 'anforderungen', 'berufserfahrung', 'deine', 'der', 'die', 'ein', 'eine', 'erfahrung', 'für', 'kenntnisse',
  'mit', 'profil', 'sie', 'und', 'wir', 'à', 'avec', 'compétences', 'dans', 'de', 'des', 'du', 'expérience', 'le', 'les',
  'nous', 'poste', 'pour', 'profil', 'vous', 'con', 'esperienza', 'il', 'la', 'requisiti', 'ruolo', 'bij', 'de', 'een',
  'ervaring', 'functie', 'het', 'met', 'van', 'vereisten', 'voor', 'wij',
]);

const skillPhrases = [
  'account management', 'agile', 'aws', 'azure', 'business analysis', 'change management', 'communication', 'crm',
  'customer success', 'data analysis', 'docker', 'excel', 'figma', 'financial analysis', 'git', 'google analytics',
  'javascript', 'jira', 'kubernetes', 'leadership', 'machine learning', 'marketing', 'negotiation', 'node.js', 'notion',
  'people management', 'power bi', 'product management', 'project management', 'python', 'react', 'recruiting', 'sales',
  'sap', 'scrum', 'sql', 'stakeholder management', 'strategy', 'tableau', 'typescript', 'ux research',
];

const stopWords = new Set([
  'about', 'after', 'also', 'and', 'are', 'been', 'being', 'between', 'but', 'can', 'company', 'each', 'for', 'from',
  'have', 'into', 'job', 'more', 'most', 'not', 'our', 'role', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'through', 'very', 'what', 'when', 'where', 'which', 'will', 'with', 'work', 'would', 'you', 'your',
]);

function words(text: string) {
  return text.toLowerCase().normalize('NFKD').match(/[a-z][a-z0-9.+#-]{1,}/g) ?? [];
}
/**
 * Decide whether English alone is enough for one advertisement.
 *
 * Three stages, strictest first, and the order matters:
 *
 *   1. A phrase rule matched a language next to a requirement cue ("fluent in German", "Dutch is
 *      mandatory") — excluded outright. See lib/language-rules.ts for the wording.
 *   2. The advertisement is not written in English — excluded.
 *   3. A local language is named at all, in the title or the body — sent to review rather than
 *      passed, even when the text calls it optional. A person glancing at the wording costs a few
 *      seconds; applying for a job that was never open costs an evening.
 *
 * The title is read as well as the body. On aggregator teasers the description is a truncated
 * blurb, so "Online Data Analyst - German Language" carried its only real signal in the headline —
 * and passing that one as English-sufficient is the exact failure this project exists to avoid.
 */
export function analyzeLanguage(description: string, title = ''): LanguageResult {
  const fromTitle = matchLanguagePhrases(title);
  const fromBody = matchLanguagePhrases(description);
  const required = [...new Set([...fromTitle.required, ...fromBody.required])];
  const mentioned = [...new Set([...fromTitle.mentioned, ...fromBody.mentioned])];
  const optional = [...new Set([...fromTitle.optional, ...fromBody.optional])]
    .filter((language) => !required.includes(language));
  const evidence = [...fromTitle.evidence, ...fromBody.evidence].slice(0, 5);

  const signals: string[] = [];
  if (required.length) signals.push(`Mandatory: ${required.join(', ')}`);
  if (optional.length) signals.push(`Described as optional: ${optional.join(', ')}`);
  const unqualified = mentioned.filter((language) =>
    !required.includes(language) && !optional.includes(language));
  if (unqualified.length) signals.push(`Mentioned: ${unqualified.join(', ')}`);
  if (evidence.length) signals.push(`Wording: "${evidence.join('", "')}"`);

  if (required.length) {
    return {
      status: 'blocked' as const,
      summary: `Excluded: ${required.join(', ')} ${required.length > 1 ? 'appear' : 'appears'} to be required.`,
      signals,
    };
  }

  // A language in the title with no cue at all still excludes. A headline is not prose; it names
  // what the role is, so "German and Dutch speaking Sales Support" needs no supporting sentence.
  if (fromTitle.mentioned.length) {
    const named = fromTitle.mentioned.join(', ');
    return {
      status: 'blocked' as const,
      summary: `Excluded: the job title names ${named}.`,
      signals: [`Mandatory: ${named} (named in the job title)`, ...signals.filter((line) => !line.startsWith('Mentioned:'))],
    };
  }

  const tokens = words(description);
  const englishScore = tokens.filter((token) => englishMarkers.has(token)).length;
  const localScore = tokens.filter((token) => nonEnglishMarkers.has(token)).length;
  const enoughText = tokens.length >= 55;
  const clearlyEnglish = enoughText && englishScore >= 7 && englishScore >= localScore * 1.35;
  const clearlyLocal = enoughText && localScore >= 7 && localScore > englishScore * 0.8;

  if (clearlyLocal) {
    return {
      status: 'blocked' as const,
      summary: 'Excluded: the advertisement is not predominantly English.',
      signals: [...signals, 'Ad language: not English'],
    };
  }
  if (mentioned.length) {
    const named = mentioned.join(', ');
    return {
      status: 'review' as const,
      summary: optional.length === mentioned.length
        ? `Needs review: ${named} is described as optional — worth confirming in the ad.`
        : `Needs review: ${named} is mentioned without a clear requirement.`,
      signals,
    };
  }
  // Checked before the prose test, because it is the more precise account of the same doubt: a
  // 500-character preview does not fail an English check, there simply was not an advertisement
  // there to check. Saying "needs review" invites a person to go and read text that was never
  // published, while "not enough of the ad" tells them the truth and points at the source.
  if (description.trim().length < MIN_CHARS_TO_CONFIRM_ENGLISH) {
    return {
      status: 'unknown' as const,
      summary: 'Not enough of the advertisement was published to confirm English is sufficient. Open the original to check.',
      signals: [...signals, `Only ${description.trim().length} characters were available`],
    };
  }
  // Long enough to judge, but the prose does not read as English.
  if (!clearlyEnglish) {
    return {
      status: 'review' as const,
      summary: 'Needs review: there is not enough evidence that the full advertisement is in English.',
      signals,
    };
  }
  return {
    status: 'pass' as const,
    summary: 'English advertisement with no local-language requirement detected.',
    signals: ['Ad language: English'],
  };
}

export function scoreFit(description: string, title: string, cvText: string, targetRole: string): FitResult {
  if (!cvText.trim()) return { score: 0, matched: [] as string[], missing: [] as string[] };
  const jobLower = `${title} ${description}`.toLowerCase();
  const cvLower = cvText.toLowerCase();
  const phraseRequirements = skillPhrases.filter((phrase) => jobLower.includes(phrase));
  const frequency = new Map<string, number>();
  for (const token of words(`${title} ${title} ${description}`)) {
    if (token.length < 4 || stopWords.has(token) || englishMarkers.has(token) || localLanguages.includes(token)) continue;
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  const keywordRequirements = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .filter((token) => !phraseRequirements.some((phrase) => phrase.includes(token)))
    .slice(0, 14);
  const requirements = [...phraseRequirements, ...keywordRequirements].slice(0, 18);
  const matched = requirements.filter((item) => cvLower.includes(item));
  const missing = requirements.filter((item) => !cvLower.includes(item)).slice(0, 6);
  const overlap = requirements.length ? matched.length / requirements.length : 0;
  const titleTokens = words(title).filter((token) => token.length > 3 && !stopWords.has(token));
  const titleMatch = titleTokens.length ? titleTokens.filter((token) => cvLower.includes(token)).length / titleTokens.length : 0;
  const targetTokens = words(targetRole).filter((token) => token.length > 3 && !stopWords.has(token));
  const targetMatch = targetTokens.length ? targetTokens.filter((token) => jobLower.includes(token)).length / targetTokens.length : 0;
  const score = Math.round(Math.min(96, 8 + overlap * 58 + titleMatch * 20 + targetMatch * 10));
  return { score, matched: matched.slice(0, 8), missing };
}

/** Scores one job against every saved CV and reports which slot fits best, since a job can be a better match for the generalist CV than the specialist one (or vice versa). */
export function scoreFitAcrossCvs(description: string, title: string, cvs: CvInput[]): FitBySlot {
  const scored = cvs.map((cv) => ({ slot: cv.slot, ...scoreFit(description, title, cv.cvText, cv.derivedRole) }));
  const best = scored.reduce<typeof scored[number] | null>((acc, cur) => (!acc || cur.score > acc.score ? cur : acc), null);
  return {
    fitScoreA: scored.find((entry) => entry.slot === 'a')?.score ?? 0,
    fitScoreB: scored.find((entry) => entry.slot === 'b')?.score ?? 0,
    bestCvSlot: best?.slot ?? '',
    matchedKeywords: best?.matched ?? [],
    missingKeywords: best?.missing ?? [],
  };
}
