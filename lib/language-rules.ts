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
 *
 * Measured 2026-09-08, after the other-language table took the alternation from 5 languages to
 * 30: 1,004 full-length advertisements screen in ~95ms, or 95µs each. It was ~49ms with five.
 * The budget that matters is the search it runs inside, which takes tens of seconds, so there is
 * room here — but re-measure rather than assume if these tables grow again.
 */

/**
 * The five languages a Swiss or Dutch advertisement is most likely to demand, plus every other
 * language that can appear in one.
 *
 * The split matters. The first five are the local languages this product exists to detect, and
 * they carry the full set of native spellings because an ad written in German calls the language
 * "Deutsch". The rest are here for one reason: a requirement for *any* language other than
 * English blocks a job just as firmly, and before this list existed "Fluent Polish is required"
 * was reported as English-sufficient — a false pass, the one error this product cannot absorb.
 */
export type LocalLanguageName = 'German' | 'French' | 'Italian' | 'Dutch' | 'Spanish';

export type OtherLanguageName =
  | 'Portuguese' | 'Polish' | 'Czech' | 'Slovak' | 'Hungarian' | 'Romanian' | 'Bulgarian'
  | 'Greek' | 'Turkish' | 'Russian' | 'Ukrainian' | 'Swedish' | 'Norwegian' | 'Danish'
  | 'Finnish' | 'Croatian' | 'Serbian' | 'Slovenian' | 'Arabic' | 'Hebrew' | 'Hindi'
  | 'Mandarin' | 'Cantonese' | 'Japanese' | 'Korean';

export type LanguageName = LocalLanguageName | OtherLanguageName;

/**
 * Every spelling of each language that appears in Swiss and Dutch advertisements, including the
 * local-language spellings, because an ad written in German calls the language "Deutsch".
 *
 * Compound forms are listed in full ("Deutschkenntnisse") because a word boundary will not find
 * "Deutsch" inside them. English is deliberately absent: it is the one language that never blocks.
 */
const localLanguageSpellings: Record<LocalLanguageName, string[]> = {
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
 * Other languages, in the forms an English, German, French, Dutch or Italian advertisement would
 * write them. Deliberately shallower than the table above: these do not need every declension,
 * because the job here is only to stop a mandatory requirement slipping through as English. A
 * requirement for one of these produces the same block as a requirement for German.
 */
const otherLanguageSpellings: Record<OtherLanguageName, string[]> = {
  Portuguese: ['portuguese', 'portugiesisch', 'portugais', 'portugees', 'portoghese', 'portugues', 'português'],
  Polish: ['polish', 'polnisch', 'polonais', 'pools', 'polacco', 'polski'],
  Czech: ['czech', 'tschechisch', 'tcheque', 'tchèque', 'tsjechisch', 'ceco'],
  Slovak: ['slovak', 'slowakisch', 'slovaque', 'slowaaks'],
  Hungarian: ['hungarian', 'ungarisch', 'hongrois', 'hongaars', 'ungherese', 'magyar'],
  Romanian: ['romanian', 'rumanisch', 'rumänisch', 'roumain', 'roemeens', 'rumeno'],
  Bulgarian: ['bulgarian', 'bulgarisch', 'bulgare', 'bulgaars'],
  Greek: ['greek', 'griechisch', 'grec', 'grieks', 'greco'],
  Turkish: ['turkish', 'turkisch', 'türkisch', 'turc', 'turks', 'turco'],
  Russian: ['russian', 'russisch', 'russe', 'russo'],
  Ukrainian: ['ukrainian', 'ukrainisch', 'ukrainien', 'oekraiens', 'oekraïens'],
  Swedish: ['swedish', 'schwedisch', 'suedois', 'suédois', 'zweeds', 'svedese'],
  Norwegian: ['norwegian', 'norwegisch', 'norvegien', 'norvégien', 'noors', 'norvegese'],
  Danish: ['danish', 'danisch', 'dänisch', 'danois', 'deens', 'danese'],
  Finnish: ['finnish', 'finnisch', 'finnois', 'fins', 'finlandese'],
  Croatian: ['croatian', 'kroatisch', 'croate', 'kroatisch', 'croato'],
  Serbian: ['serbian', 'serbisch', 'serbe', 'servisch', 'serbo'],
  Slovenian: ['slovenian', 'slowenisch', 'slovene', 'slovène', 'sloveens'],
  Arabic: ['arabic', 'arabisch', 'arabe', 'arabo'],
  Hebrew: ['hebrew', 'hebraisch', 'hebräisch', 'hebreu', 'hébreu', 'hebreeuws'],
  Hindi: ['hindi'],
  Mandarin: ['mandarin', 'mandarijn', 'putonghua'],
  Cantonese: ['cantonese', 'kantonesisch', 'cantonais'],
  Japanese: ['japanese', 'japanisch', 'japonais', 'japans', 'giapponese'],
  Korean: ['korean', 'koreanisch', 'coreen', 'coréen', 'koreaans'],
};

const languageSpellings: Record<LanguageName, string[]> = {
  ...localLanguageSpellings,
  ...otherLanguageSpellings,
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
  'bilingual in', 'bilingual',
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

/**
 * Wording where a language is offered as help, not asked as a requirement:
 * "we offer free Dutch lessons".
 *
 * Both halves must be present — a benefit verb *and* a lesson noun — so that
 * "Dutch lessons are mandatory" (no benefit verb) and "we offer Dutch support"
 * (no lesson noun) never clear. A real requirement elsewhere still blocks,
 * because exemption only removes the mention; it never removes a requirement.
 */
const benefitVerbs = [
  'offer', 'offers', 'offered', 'offering', 'provide', 'provides', 'provided', 'providing',
  'free', 'available', 'subsidised', 'subsidized', 'funded', 'reimbursed', 'paid',
];

const lessonNouns = [
  'lesson', 'lessons', 'course', 'courses', 'class', 'classes', 'training', 'tuition', 'coaching',
];

/**
 * Nouns where a language word is a nationality or market, not a language:
 * "Dutch financial regulation", "the German market".
 *
 * Deliberately narrow. "Customers", "clients", "colleagues" and "team" are not here:
 * supporting German customers usually does need German, while knowing German market
 * regulation does not. Only the market/regulation/legislation/law family clears.
 */
const nonLanguageNouns = [
  'market', 'markets', 'regulation', 'regulations', 'regulatory', 'legislation', 'law', 'laws',
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
/** A language offered with lessons, so it is help rather than a bar: "we offer free Dutch lessons". */
const benefitBeforePattern = new RegExp(
  `\\b(?:${alternation(benefitVerbs)})\\b${gap(30)}\\b(${languageAlternation})\\b${gap(25)}\\b(?:${alternation(lessonNouns)})\\b`, 'gi');
const benefitAfterPattern = new RegExp(
  `\\b(${languageAlternation})\\b${gap(25)}\\b(?:${alternation(lessonNouns)})\\b${gap(30)}\\b(?:${alternation(benefitVerbs)})\\b`, 'gi');
/** A language word used as a market or regulation, not a language: "the German market". */
const nationalityPattern = new RegExp(
  `\\b(${languageAlternation})\\b${gap(25)}\\b(?:${alternation(nonLanguageNouns)})\\b`, 'gi');

/** How far back a denial can sit and still clear the cue it precedes. */
const DENIAL_LOOKBACK = 12;
/** How far back a negation can sit and still soften a requirement to optional (review). */
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
 * Runs bounded regular expressions over the text regardless of how many phrases the lists
 * above contain, so the tables can grow without the filter getting slower.
 *
 * Three outcomes for a language mention, strictest first:
 *   1. Required (blocked) — a requirement cue binds to it with no denial.
 *   2. Exempt (as if not named) — every occurrence is an explicit denial ("No German is
 *      required"), a benefit ("free Dutch lessons") or a nationality/market use
 *      ("German market"). Only then may the gate pass; one ordinary mention keeps review.
 *   3. Otherwise mentioned (review) — including explicitly optional wording ("a plus",
 *      "not required"), which stays review so a glance confirms it.
 */
export function matchLanguagePhrases(text: string): LanguagePhraseResult {
  const required = new Set<LanguageName>();
  const mentioned = new Set<LanguageName>();
  const optional = new Set<LanguageName>();
  const evidence: string[] = [];
  if (!text) return { required: [], mentioned: [], optional: [], evidence: [] };

  interface ExemptSpan { start: number; end: number; language: LanguageName }
  const exemptSpans: ExemptSpan[] = [];

  for (const pattern of [requiredBeforePattern, requiredAfterPattern]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const language = nameFor(match[1]);
      if (!language) continue;
      const start = match.index ?? 0;
      // Narrow denial on purpose. A 45-character window let a stale cue ("required ... German
      // customers" across a comma) steal the "No" from an earlier denied sentence and clear
      // a later ordinary mention — a false pass. 12 covers "No X", "without X" and
      // "without any X" with word boundaries. A negation further out still softens to
      // optional (review), which is what the gate did before and what keeps a second
      // ordinary mention in review rather than blocked or passed.
      const closeBefore = text.slice(Math.max(0, start - DENIAL_LOOKBACK), start + match[0].length);
      // "German is a plus" is optional wording inside the match itself — that stays review,
      // so it wins over a nearby negation. This is what keeps "German is not required"
      // (which contains the optional phrase "not required") in review, while
      // "No German is required" (no optional phrase inside) becomes an explicit denial.
      if (optionalPattern.test(match[0])) {
        optional.add(language);
        continue;
      }
      if (negationPattern.test(closeBefore)) {
        exemptSpans.push({ start, end: start + match[0].length, language });
        continue;
      }
      const wideBefore = text.slice(Math.max(0, start - NEGATION_LOOKBACK), start + match[0].length);
      if (negationPattern.test(wideBefore)) {
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
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const language = nameFor(match[1]);
      if (language && !required.has(language)) optional.add(language);
    }
  }

  // Benefit and nationality uses are not language requirements at all, so their spans exempt
  // the mention — but only that occurrence. A second ordinary mention of the same language
  // still lands in `mentioned` below, which is what keeps
  // "we offer Dutch lessons, and fluent Dutch is required" blocked.
  for (const pattern of [benefitBeforePattern, benefitAfterPattern, nationalityPattern]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const language = nameFor(match[1]);
      if (!language || required.has(language)) continue;
      const start = match.index ?? 0;
      exemptSpans.push({ start, end: start + match[0].length, language });
    }
  }

  anyLanguagePattern.lastIndex = 0;
  for (const match of text.matchAll(anyLanguagePattern)) {
    const language = nameFor(match[1]);
    if (!language) continue;
    const index = match.index ?? 0;
    const exempt = exemptSpans.some(
      (span) => span.language === language && index >= span.start && index < span.end,
    );
    if (!exempt) mentioned.add(language);
  }

  for (const language of required) {
    optional.delete(language);
  }
  // A fully exempt language leaves no mention and no requirement, so drop its optional flag
  // too — there is nothing left to review. A language with a surviving mention keeps its flag.
  for (const language of [...optional]) {
    if (!required.has(language) && !mentioned.has(language)) optional.delete(language);
  }
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
  compiledPatterns: 10,
};
