/**
 * The phrase rules that decide whether a local language is genuinely required.
 *
 * Kept apart from the rest of the analysis so the wording can be reviewed and extended on its own —
 * this is the list that decides whether somebody wastes an evening on an advertisement that was
 * never open to them, and it is meant to be read by a person, not only run.
 *
 * Two stages, in the order a reader would apply them:
 *
 *   1. A cue next to a language name ("fluent in German", "Dutch is mandatory") excludes the job.
 *   2. Anything left that still names a local language goes to review rather than passing.
 *
 * Cost is deliberately bounded. The phrases below are compiled once, at module load, into four
 * regular expressions rather than being scanned one at a time, and every gap between a cue and a
 * language is expressed with a negated character class so the matcher cannot backtrack
 * exponentially over a long advertisement.
 */

export type LanguageName = 'German' | 'French' | 'Italian' | 'Dutch' | 'Spanish';

/**
 * Every spelling of each language that appears in Swiss and Dutch advertisements, including the
 * local-language spellings, because an ad written in German calls the language "Deutsch".
 *
 * Compound forms are listed in full ("Deutschkenntnisse") because a word boundary will not find
 * "Deutsch" inside them. English is deliberately absent: it is the one language that never blocks.
 */
const languageSpellings: Record<LanguageName, string[]> = {
  German: ['german', 'germanic', 'deutsch', 'deutsche', 'deutschen', 'deutscher', 'deutschkenntnisse',
    'deutschkenntnissen', 'allemand', 'allemande', 'tedesco', 'duits', 'duitse', 'schweizerdeutsch',
    'swiss german'],
  French: ['french', 'franzosisch', 'französisch', 'franzoesisch', 'franzosischkenntnisse',
    'französischkenntnisse', 'francais', 'français', 'francaise', 'française', 'francese', 'frans', 'franse'],
  Italian: ['italian', 'italienisch', 'italienischkenntnisse', 'italiano', 'italiana', 'italien',
    'italienne', 'italiaans', 'italiaanse'],
  Dutch: ['dutch', 'niederlandisch', 'niederländisch', 'niederlandischkenntnisse', 'nederlands',
    'nederlandse', 'neerlandais', 'néerlandais', 'olandese', 'hollands'],
  Spanish: ['spanish', 'spanisch', 'spanischkenntnisse', 'espanol', 'español', 'espagnol', 'espagnole',
    'spagnolo', 'spaans', 'spaanse'],
};

/**
 * Cues that sit *before* a language and make it a requirement: "fluent in German".
 *
 * Includes the German, Dutch, French and Italian equivalents, because an advertisement that
 * requires German is usually written in German and never says "fluent" at all.
 */
const requirementCuesBefore = [
  // English
  'fluent in', 'fluency in', 'fluent', 'fluently', 'proficient in', 'proficiency in', 'proficient',
  'native', 'native level', 'native speaker of', 'mother tongue', 'command of', 'good command of',
  'excellent command of', 'excellent', 'very good', 'strong', 'solid', 'advanced', 'business fluent',
  'business level', 'working knowledge of', 'knowledge of', 'must speak', 'must have', 'you speak',
  'you must speak', 'we require', 'requires', 'required', 'requirement', 'mandatory', 'essential',
  'minimum', 'at least', 'perfect', 'confident in', 'able to speak', 'ability to speak', 'speaks',
  // Sits directly against the language, which catches sentences whose real cue is too far away to
  // associate: "Excellent communication, synthesis and writing skills in French".
  'skills in', 'written in', 'spoken in', 'communicate in', 'correspondence in', 'level of',
  // German
  'verhandlungssicher', 'verhandlungssichere', 'verhandlungssicheres', 'verhandlungssicherem',
  'fliessend', 'fliessende', 'fliessendes', 'fließend', 'fließende', 'fließendes',
  'sehr gute', 'sehr guten', 'sehr gutes', 'gute', 'guten', 'gutes', 'stilsicheres', 'muttersprache',
  'muttersprachliche', 'vorausgesetzt', 'zwingend', 'erforderliche',
  // Dutch
  'vloeiend', 'vloeiende', 'uitstekende', 'uitstekend', 'goede', 'goed', 'beheersing van',
  'moedertaal', 'vereiste',
  // French / Italian
  'courant', 'courante', 'maitrise', 'maîtrise', 'maitrise de', 'maîtrise de', 'excellente',
  'tres bonne', 'très bonne', 'langue maternelle', 'ottima', 'ottimo', 'buona conoscenza',
  'madrelingua',
];

/**
 * Cues that sit *after* a language and make it a requirement: "German is mandatory", "Dutch B2".
 *
 * The CEFR levels are here because they are the most common way a Swiss advertisement states a
 * hard language bar, and they carry no other meaning next to a language name.
 */
const requirementCuesAfter = [
  // English
  'is mandatory', 'mandatory', 'is required', 'are required', 'required', 'is essential', 'essential',
  'is a must', 'are a must', 'a must', 'is a requirement', 'is expected', 'expected',
  'skills are required', 'skills required', 'is compulsory', 'compulsory', 'at native level',
  'native level', 'native speaker', 'speaking', 'speaker', 'speakers', 'spoken and written',
  'written and spoken', 'is essential for this role', 'proficiency', 'fluency', 'fluent',
  // Stated levels. Next to a language name these carry no other meaning, and a labelled list
  // ("Deutsch: C2 - Muttersprachliches Niveau") is the clearest hard bar an advertisement has.
  'a2', 'b1', 'b2', 'c1', 'c2', 'advanced', 'advanced level', 'intermediate', 'working level',
  'niveau', 'level', 'muttersprachliches niveau', 'sehr gut', 'sehr gute', 'gute kenntnisse',
  // German / Dutch / French / Italian
  'erforderlich', 'kenntnisse erforderlich', 'vorausgesetzt', 'zwingend', 'notwendig',
  'in wort und schrift', 'sprechen sie', 'sprachkenntnisse',
  'vereist', 'verplicht', 'noodzakelijk', 'in woord en geschrift',
  'obligatoire', 'exige', 'exigé', 'indispensable', 'richiesto', 'obbligatorio',
];

/**
 * Wording that makes a nearby requirement cue mean the opposite: "no German required",
 * "German is not mandatory", "Deutsch ist kein Muss".
 *
 * Without this, the single most reassuring sentence an advertisement can contain — the one saying
 * the language is *not* needed — would be the sentence that excluded it.
 */
const negations = [
  'no', 'not', 'without', 'never', 'neither', 'nor', 'non', 'nicht', 'kein', 'keine', 'keinen',
  'geen', 'niet', 'nessun', 'nessuna', 'aucune', 'aucun', 'pas de', 'do not', "don't", 'does not',
  'is not', 'are not', 'need not',
];

/**
 * Wording that marks a language as welcome but not required: "German is a plus".
 *
 * These do not clear a job on their own — a mention still goes to review — but they keep the
 * summary honest about what the advertisement actually said.
 */
const optionalCues = [
  'a plus', 'plus', 'advantage', 'advantageous', 'an asset', 'asset', 'beneficial', 'bonus',
  'desirable', 'nice to have', 'not required', 'not mandatory', 'optional', 'preferred', 'welcome',
  'would be helpful', 'helpful', 'appreciated', 'von vorteil', 'wünschenswert', 'wunschenswert',
  'ein plus', 'pre', 'pré', 'een pre', 'atout', 'un atout', 'gradito',
];

function alternation(values: string[]) {
  // Longest first so "fluent in" wins over "fluent", and every literal is escaped because the list
  // contains apostrophes and accented characters.
  return [...values]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const allSpellings = Object.values(languageSpellings).flat();
const languageAlternation = alternation(allSpellings);
const spellingToName = new Map<string, LanguageName>();
for (const [name, spellings] of Object.entries(languageSpellings) as [LanguageName, string[]][]) {
  for (const spelling of spellings) spellingToName.set(spelling, name);
}

/**
 * The gap allowed between a cue and a language name.
 *
 * A negated class rather than `.{0,N}`: it cannot cross a sentence or a bullet, which is what stops
 * "English required" in one line from attaching itself to "German" in the next, and it gives the
 * matcher nothing to backtrack over on a long advertisement.
 *
 * The colon is deliberately *not* excluded. Advertisements state hard language bars as a labelled
 * list — "Sprachen: Deutsch: C2, Französisch: B2" — so refusing to cross a colon missed the single
 * clearest way a requirement is ever written down. 45 characters is what "Excellent communication,
 * synthesis and writing skills in French" needs; measured against the stored corpus, nothing
 * shorter caught it and nothing longer caught anything new.
 */
/**
 * The gap is "tempered": it may not step over another language name.
 *
 * Without this, "German preferred and French fluency" matched as German-plus-fluency in one span,
 * the optional cue belonging to German silenced it, and French — the language actually required —
 * was consumed by that match and never examined at all. Each step asserts no language starts here
 * before consuming a character, so a cue can only ever bind to the nearest language name.
 */
const gap = (limit = 45) => `(?:(?!\\b(?:${languageAlternation})\\b)[^.;!?\\n\\u2022]){0,${limit}}`;

const requiredBeforePattern = new RegExp(
  `\\b(?:${alternation(requirementCuesBefore)})\\b${gap()}\\b(${languageAlternation})\\b`, 'gi');
const requiredAfterPattern = new RegExp(
  `\\b(${languageAlternation})\\b${gap()}\\b(?:${alternation(requirementCuesAfter)})\\b`, 'gi');
/** Optional wording bound to one language, so the summary can say what the ad actually claimed. */
const optionalBeforePattern = new RegExp(
  `\\b(?:${alternation(optionalCues)})\\b${gap(25)}\\b(${languageAlternation})\\b`, 'gi');
const optionalAfterPattern = new RegExp(
  `\\b(${languageAlternation})\\b${gap(25)}\\b(?:${alternation(optionalCues)})\\b`, 'gi');
const anyLanguagePattern = new RegExp(`\\b(${languageAlternation})\\b`, 'gi');
const negationPattern = new RegExp(`\\b(?:${alternation(negations)})\\b`, 'i');
const optionalPattern = new RegExp(`\\b(?:${alternation(optionalCues)})\\b`, 'i');

/** How far back a negation can sit and still flip the cue it precedes. */
const NEGATION_LOOKBACK = 45;

function nameFor(spelling: string): LanguageName | null {
  return spellingToName.get(spelling.toLowerCase()) ?? null;
}

export interface LanguagePhraseResult {
  /** Languages a phrase rule marked as required. Any entry here means the job is excluded. */
  required: LanguageName[];
  /** Languages named anywhere, required or not. A non-empty list with no requirement means review. */
  mentioned: LanguageName[];
  /** Languages the text explicitly called optional, used only to word the summary accurately. */
  optional: LanguageName[];
  /** The matched wording, so a person can see why a job was excluded instead of trusting a verdict. */
  evidence: string[];
}

/**
 * Apply the phrase rules to one piece of text.
 *
 * Runs four bounded regular expressions over the text regardless of how many phrases the lists
 * above contain, so the tables can grow without the filter getting slower.
 */
export function matchLanguagePhrases(text: string): LanguagePhraseResult {
  const required = new Set<LanguageName>();
  const mentioned = new Set<LanguageName>();
  const optional = new Set<LanguageName>();
  const evidence: string[] = [];
  if (!text) return { required: [], mentioned: [], optional: [], evidence: [] };

  for (const pattern of [requiredBeforePattern, requiredAfterPattern]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const language = nameFor(match[1]);
      if (!language) continue;
      const start = match.index ?? 0;
      const before = text.slice(Math.max(0, start - NEGATION_LOOKBACK), start + match[0].length);
      // "no German required" and "German is a plus" both describe a job that is still open.
      if (negationPattern.test(before) || optionalPattern.test(match[0])) {
        optional.add(language);
        continue;
      }
      required.add(language);
      if (evidence.length < 5) evidence.push(match[0].replace(/\s+/g, ' ').trim());
    }
  }

  // Scanned separately from the requirement rules so that wording like "German is a plus" is
  // recognised even though no requirement cue ever fired for it. It does not clear the job — a
  // mention still goes to review — but it lets the summary repeat what the advertisement claimed.
  for (const pattern of [optionalBeforePattern, optionalAfterPattern]) {
    for (const match of text.matchAll(pattern)) {
      const language = nameFor(match[1]);
      if (language && !required.has(language)) optional.add(language);
    }
  }

  for (const match of text.matchAll(anyLanguagePattern)) {
    const language = nameFor(match[1]);
    if (language) mentioned.add(language);
  }

  for (const language of required) optional.delete(language);
  return {
    required: [...required],
    mentioned: [...mentioned],
    optional: [...optional],
    evidence,
  };
}

export const languageRuleCounts = {
  languages: Object.keys(languageSpellings).length,
  spellings: allSpellings.length,
  cuesBefore: requirementCuesBefore.length,
  cuesAfter: requirementCuesAfter.length,
  compiledPatterns: 7,
};
