export type LanguageStatus = 'pass' | 'review' | 'blocked';

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
const languagePattern = localLanguages.join('|');

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

const optionalWords = /\b(?:a plus|advantage|advantageous|an asset|beneficial|bonus|desirable|nice to have|not required|optional|preferred|would be helpful)\b/gi;
const requiredWords = /\b(?:advanced(?: level)?|at least|business[- ]fluent|excellent|fluency|fluent|good command|mandatory|minimum|must|required|requirement|strong|very good|working knowledge|proficien(?:t|cy)|native|b[12]|c[12])\b/gi;

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

function labelLanguage(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'deutsch') return 'German';
  if (['français', 'francais'].includes(normalized)) return 'French';
  if (normalized === 'italiano') return 'Italian';
  if (normalized === 'nederlands') return 'Dutch';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

interface Cue {
  start: number;
  end: number;
}

function cues(sentence: string, pattern: RegExp) {
  return [...sentence.matchAll(pattern)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function distanceToCue(languageStart: number, languageEnd: number, cue: Cue) {
  if (cue.end < languageStart) return languageStart - cue.end;
  if (cue.start > languageEnd) return cue.start - languageEnd;
  return 0;
}

function nearestDistance(languageStart: number, languageEnd: number, matches: Cue[]) {
  return matches.reduce((nearest, cue) => Math.min(nearest, distanceToCue(languageStart, languageEnd, cue)), Number.POSITIVE_INFINITY);
}

export function analyzeLanguage(description: string): LanguageResult {
  const tokens = words(description);
  const englishScore = tokens.filter((token) => englishMarkers.has(token)).length;
  const localScore = tokens.filter((token) => nonEnglishMarkers.has(token)).length;
  const sentences = description.split(/(?<=[.!?;\n])\s+/).map((part) => part.trim()).filter(Boolean);
  const mandatory = new Set<string>();
  const optional = new Set<string>();
  const ambiguous = new Set<string>();

  for (const sentence of sentences) {
    const matches = [...sentence.matchAll(new RegExp(`\\b(${languagePattern})\\b`, 'gi'))];
    const optionalCues = cues(sentence, optionalWords);
    const requiredCues = cues(sentence, requiredWords).filter((required) =>
      !optionalCues.some((optional) => required.start >= optional.start && required.end <= optional.end),
    );
    for (const match of matches) {
      const language = labelLanguage(match[1]);
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const optionalDistance = nearestDistance(start, end, optionalCues);
      const requiredDistance = nearestDistance(start, end, requiredCues);
      const associationLimit = 55;
      if (requiredDistance <= associationLimit && requiredDistance <= optionalDistance) mandatory.add(language);
      else if (optionalDistance <= associationLimit) optional.add(language);
      else ambiguous.add(language);
    }
  }

  for (const language of mandatory) {
    optional.delete(language);
    ambiguous.delete(language);
  }
  for (const language of optional) ambiguous.delete(language);

  const signals: string[] = [];
  if (mandatory.size) signals.push(`Mandatory: ${[...mandatory].join(', ')}`);
  if (optional.size) signals.push(`Optional: ${[...optional].join(', ')}`);
  if (ambiguous.size) signals.push(`Unclear mention: ${[...ambiguous].join(', ')}`);

  const enoughText = tokens.length >= 55;
  const clearlyEnglish = enoughText && englishScore >= 7 && englishScore >= localScore * 1.35;
  const clearlyLocal = enoughText && localScore >= 7 && localScore > englishScore * 0.8;

  if (mandatory.size) {
    return { status: 'blocked' as const, summary: `Excluded: ${[...mandatory].join(', ')} appears mandatory.`, signals };
  }
  if (clearlyLocal) {
    return { status: 'blocked' as const, summary: 'Excluded: the advertisement is not predominantly English.', signals: [...signals, 'Ad language: not English'] };
  }
  if (!clearlyEnglish) {
    return { status: 'review' as const, summary: 'Needs review: there is not enough evidence that the full advertisement is in English.', signals };
  }
  if (ambiguous.size) {
    return { status: 'review' as const, summary: `Needs review: ${[...ambiguous].join(', ')} is mentioned without saying whether it is optional.`, signals };
  }
  if (optional.size) {
    return { status: 'pass' as const, summary: `English is sufficient; ${[...optional].join(', ')} is described as optional.`, signals };
  }
  return { status: 'pass' as const, summary: 'English advertisement with no mandatory local-language requirement detected.', signals: ['Ad language: English'] };
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
