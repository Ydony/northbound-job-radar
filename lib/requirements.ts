/**
 * Pull the requirements out of an advertisement, when it has stated them clearly enough to find.
 *
 * The point is to answer "would I be wasting my time here?" from the card, without opening the ad.
 * That only works if what is shown is genuinely what the employer asked for — a few lines lifted
 * from the middle of the marketing copy would be worse than showing nothing, because it looks like
 * an answer.
 *
 * So this is deliberately conservative and returns nothing far more often than it returns
 * something. Measured across the stored corpus: of 440 advertisements long enough to have a
 * requirements section, 98 (22%) state one under a heading this can find. The other 78% get no
 * extract and a link to the full ad, which is the honest outcome rather than a failure.
 *
 * It became possible at all only once ingest stopped flattening HTML: a requirements list is
 * recognisable because it is a list, and `<ul><li>` used to arrive as one unbroken paragraph.
 *
 * Widening it was tried and abandoned. 331 stored advertisements are long enough to state
 * requirements without using a heading found here, and 91 of those appeared to carry a bullet list
 * — but on inspection those bullets are Job-Room's markdown metadata (`**Seniority Level**`,
 * `**Jobtyp**`), not anything an employer wrote. A fallback that picked them up would have
 * presented "Temporär" as a requirement. The unheaded path below therefore needs explicit
 * requirement cues and never bare bullets: metadata carries no cue, so it stays out (#125).
 * Every item returned is a grounded quotation from the available text — modality
 * ("must", "preferred", "no ... required") and negations are preserved verbatim —
 * never a CV-match explanation and never a reason to promote language eligibility.
 */

/**
 * Headings that introduce what an employer wants, in the four languages these ads are written in.
 *
 * Deliberately not including bare "profile" or "skills" on their own — both appear in section
 * headings about the company as often as about the candidate, and a wrong section is worse than
 * none.
 */
const requirementHeadings = [
  // English
  'requirements', 'your profile', 'about you', 'what you bring', 'what you will bring',
  'what we are looking for', "what we're looking for", 'we are looking for', 'what we ask', 'you have',
  'your skills', 'your experience', 'qualifications', 'your qualifications', 'skills and experience',
  'required skills', 'must have', 'your background', 'what you need', 'who you are',
  // German
  'ihr profil', 'dein profil', 'anforderungen', 'ihre qualifikationen', 'das bringen sie mit',
  'das bringst du mit', 'was sie mitbringen', 'was du mitbringst', 'wir erwarten', 'dein hintergrund',
  'ihre kompetenzen', 'unsere anforderungen', 'sie bringen mit', 'du bringst mit',
  // Dutch
  'wat je meebrengt', 'wat wij vragen', 'jouw profiel', 'wat vragen wij', 'functie-eisen',
  'wie ben jij', 'wat neem je mee', 'jouw achtergrond', 'wat je meeneemt',
  // French / Italian
  'votre profil', 'vos qualifications', 'ce que vous apportez', 'profil recherche',
  'profil recherché', 'il tuo profilo', 'requisiti',
];

/** Headings that mean the requirements have ended and something else has started. */
const closingHeadings = [
  'we offer', 'what we offer', 'our offer', 'benefits', 'what you get', 'what we give you',
  'about us', 'about the company', 'why us', 'how to apply', 'application', 'apply now',
  'wir bieten', 'unser angebot', 'das bieten wir', 'uber uns', 'über uns', 'bewerbung',
  'wij bieden', 'wat wij bieden', 'ons aanbod', 'over ons', 'solliciteren',
  'nous offrons', 'notre offre', 'a propos', 'à propos', 'offriamo',
];

/**
 * Substrings that mark an unfamiliar short heading as a requirements heading
 * (#125). Checked only after the recognised lists above and the closing list:
 * a heading containing one of these is treated as opening the requirements,
 * so "Your must-haves" or "Ce que nous attendons" no longer needs an exact
 * entry. Bare "profile"/"skills" stay out on purpose — see requirementHeadings.
 */
const unfamiliarRequirementMarkers = [
  'requirement', 'exigence', 'requisit', 'anforderung', 'functie-eis', 'functie eis',
  'qualific', 'must have', 'must-have', 'nice to have', 'what you bring', 'what you need',
  'you bring', 'you have', 'you possess', 'we expect', 'we ask', 'we are looking',
  'looking for someone', 'about you', 'who you are', 'who we are looking',
  'sie bringen', 'du bringst', 'wir erwarten', 'wir suchen', 'was sie mitbringen',
  'was du mitbringst', 'je brengt', 'wij vragen', 'wij zoeken', 'we zoeken', 'ben jij', 'heb jij',
  'nous recherchons', 'nous cherchons', 'vous avez', 'vous justifiez', 'profil recherch',
  'ce que nous attendons', 'esperienza', 'conoscenza',
];

/**
 * Explicit requirement cues for the unheaded path. Mirrors the precision work
 * in lib/excerpt.ts: bare "you are"/"je bent" (duties), bare "minimaal"
 * (working week), bare "vereist"/"gevraagd" (compliance/duties) and bare
 * "requisiti" (English "requisitions") are deliberately absent. A sentence
 * needs one of these to count without a heading; Job-Room metadata
 * ("**Seniority Level**", "Temporär") carries none, so it stays out.
 */
const requirementCues = [
  'you have', 'you possess', 'you bring', 'you will need', 'you should have', 'we ask',
  'we expect', 'we are looking for', "we're looking for", 'looking for someone', 'experience in',
  'experience with', 'years of experience', 'degree in', 'background in', 'proficient',
  'proficiency', 'fluent in', 'familiar with', 'knowledge of', 'skilled in', 'must have',
  'required', 'qualifications', 'ideally you', 'ability to',
  'sie bringen', 'du bringst', 'sie haben', 'du hast', 'erfahrung in', 'erfahrung mit',
  'kenntnisse', 'abgeschlossen', 'berufserfahrung', 'wir erwarten', 'wir suchen',
  'vorausgesetzt', 'verfügen über', 'verfügst über', 'idealerweise',
  'je hebt', 'jij hebt', 'je brengt', 'ervaring met', 'ervaring in', 'ervaring binnen',
  'ervaring als', 'kennis van', 'wij vragen', 'wij zoeken', 'we zoeken', 'je beschikt', 'beschikt over',
  'beschik je over', 'ben jij', 'heb jij', 'functie-eis', 'functie eisen',
  'aantoonbare ervaring', 'een afgeronde', 'in het bezit van',
  'vous avez', 'vous justifiez', 'vous maîtrisez', 'vous possédez',
  'vous disposez', 'nous recherchons', 'nous cherchons', 'expérience en', 'expérience dans',
  'expérience de', "d'expérience", 'connaissance de',
  'maîtrise de', 'maitrise de', 'capacité', 'formation supérieure', 'formation technique',
  'compétences requises', 'profil recherché', 'indispensable', 'obligatoire',
  'esperienza in', 'conoscenza di', 'sei in grado',
];

/**
 * Qualification signals: the nouns that make a cue sentence about the
 * candidate rather than about the role. "We are looking for a planner" has a
 * cue but no signal and stays out; "3 years of experience with SQL" has both.
 * Question forms ("Ben jij…", "Heb jij…") and explicit optionality/negation
 * ("a plus", "preferred", "no … required") count as signals on their own.
 */
const qualificationSignals = [
  'degree', 'diploma', 'experience', 'ervaring', 'erfahrung', 'expérience', 'esperienza',
  'skill', 'kennis', 'kenntnisse', 'knowledge', 'connaissance', 'conoscenza',
  'proficient', 'fluent', 'vloeiend', 'fließend', 'ability', 'vermogen', 'fähigkeit', 'capacité',
  'year', 'jaar', 'jahr', 'an ', 'ans ', 'education', 'opleiding', 'ausbildung', 'formation',
  'background', 'achtergrond', 'hintergrund',
  'plus', 'preferred', 'preferably', 'advantage', 'asset', 'ideally', 'idealiter', 'idealerweise',
  'voorkeur', 'pluspunt', 'atout', 'bevorzugt',
  'must', 'required', 'vereist', 'erforderlich', 'verplicht', 'obligatoire', 'indispensable',
  'qualification', 'kwalificatie', 'qualifikation',
  'ben jij', 'heb jij',
];

const applyingPhrases = [
  'hesitate to contact', 'do not hesitate', 'please contact', 'get in touch', 'reach out to',
  'if you have any question', 'send your', 'send us your', 'apply via', 'apply through',
  'write an email', 'look forward to receiving', 'talent acquisition', 'our recruiter',
  'zögern sie nicht', 'kontaktieren sie', 'bewerben sie sich', 'neem contact op', 'solliciteer',
];

function normalizeHeading(line: string) {
  return line
    .toLowerCase()
    .replace(/[•*\-–—#:.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHeadingFor(line: string, headings: string[]) {
  const normalized = normalizeHeading(line);
  // A heading is short. A sentence that happens to contain "requirements" is not one, and treating
  // it as such starts the extract in the middle of a paragraph.
  if (!normalized || normalized.length > 60) return false;
  return headings.some((heading) => normalized === heading || normalized.startsWith(`${heading} `));
}

function isUnfamiliarRequirementHeading(line: string) {
  const normalized = normalizeHeading(line);
  if (!normalized || normalized.length > 60) return false;
  if (normalized.split(' ').length > 7) return false;
  if (/[.!?]$/.test(line.trim())) return false;
  return unfamiliarRequirementMarkers.some((marker) => normalized.includes(marker));
}

function isAnyRequirementHeading(line: string) {
  return isHeadingFor(line, requirementHeadings) || isUnfamiliarRequirementHeading(line);
}

/** Strip the bullet glyph and numbering an ad prefixes its items with. */
function cleanItem(line: string) {
  return line
    .replace(/^\s*(?:[•*·●▪>-]|\d+[.)])\s*/, '')
    .replace(/\*{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAboutApplying(line: string) {
  const lower = line.toLowerCase();
  return applyingPhrases.some((phrase) => lower.includes(phrase));
}

/** Job-Room markdown metadata, not employer requirements: "**Seniority Level**", "**Jobtyp**", etc. */
function isSourceMetadata(line: string) {
  const trimmed = line.trim();
  if (/\*\*/.test(trimmed)) return true;
  const lower = trimmed.toLowerCase().replace(/\*/g, '').trim();
  if (/^(seniority level|jobtyp|job type|beschäftigungsgrad|employment type|temporär|temporar|vollzeit|teilzeit|full-?time|part-?time)$/.test(lower)) return true;
  return false;
}

function containsCue(line: string) {
  const lower = line.toLowerCase();
  return requirementCues.some((cue) => lower.includes(cue));
}

function containsQualificationSignal(line: string) {
  const lower = line.toLowerCase();
  return qualificationSignals.some((signal) => lower.includes(signal));
}

/**
 * A single legitimate requirement: long enough to say something, carrying an
 * explicit cue, with modality and negations kept verbatim. Used to admit the
 * one-item case under a heading that the two-item floor would otherwise drop.
 */
function isStrongSingleRequirement(item: string) {
  if (item.length < 25 || item.length > MAX_ITEM_LENGTH) return false;
  if (isAboutApplying(item) || isSourceMetadata(item)) return false;
  return containsCue(item) && containsQualificationSignal(item);
}

export interface ExtractedRequirements {
  /**
   * The heading the items were found under, as the advertisement wrote it.
   * Empty when the items were stated clearly in the text without a recognised
   * or unfamiliar heading (#125): the card labels those as extracted from the
   * available advertisement, never as a quoted section.
   */
  heading: string;
  items: string[];
}

const MAX_ITEMS = 6;
/** Long enough to be a requirement, short enough not to be a paragraph of prose. */
const MIN_ITEM_LENGTH = 12;
const MAX_ITEM_LENGTH = 300;
/** Unheaded sentences need more substance: fragments and metadata stay out. */
const MIN_UNHEADED_LENGTH = 25;

function splitSentences(block: string): string[] {
  return block
    .split(/\n+|(?<=[.!?])\s+(?=[A-ZÀ-ÞÄÖÜÉÈÊ0-9"“‘•*\-–])/)
    .map((part) => cleanItem(part))
    .filter(Boolean);
}

function tidyHeading(raw: string) {
  // Job-Room wraps its headings in markdown rules ("### Your profile ###"), which are an
  // artefact of its own formatting rather than something the employer wrote.
  return raw.replace(/^[#*\s]+/, '').replace(/[#*:\s]+$/, '');
}

export function extractRequirements(description: string): ExtractedRequirements | null {
  if (!description || !description.trim()) return null;
  // Truncated feeds end mid-sentence with an ellipsis; what precedes it can
  // still be quoted, and the card labels it as from the available text.
  const lines = description.split('\n').map((line) => line.trim());
  const headingIndex = lines.findIndex((line) => isAnyRequirementHeading(line));
  if (headingIndex !== -1) {
    const items: string[] = [];
    for (const line of lines.slice(headingIndex + 1)) {
      if (!line) continue;
      // Stop at the next section rather than running on into what the employer is offering.
      if (isHeadingFor(line, closingHeadings) || isAnyRequirementHeading(line)) break;
      if (isSourceMetadata(line)) continue;
      // A paragraph under the heading can hold several requirements in one
      // block; split it so a long block is not dropped whole for exceeding
      // the per-item cap while its sentences are quotable.
      for (const sentence of splitSentences(line)) {
        if (isSourceMetadata(sentence)) continue;
        if (isAboutApplying(sentence)) continue;
        if (sentence.length < MIN_ITEM_LENGTH || sentence.length > MAX_ITEM_LENGTH) continue;
        // Avoid quoting the heading echo itself ("Your profile: you have…"
        // after stripping keeps the label glued on — excerpt strips those).
        items.push(sentence);
        if (items.length === MAX_ITEMS) break;
      }
      if (items.length === MAX_ITEMS) break;
    }

    if (items.length >= 2) {
      return { heading: tidyHeading(lines[headingIndex]), items };
    }
    // One line under a heading is usually a stray sentence rather than a
    // requirements list — unless it is an explicitly stated requirement with
    // a cue ("University degree in…", "3+ years with…"). That legitimate
    // single is kept; anything else stays null rather than implying the job
    // asks for one thing.
    if (items.length === 1 && isStrongSingleRequirement(items[0])) {
      return { heading: tidyHeading(lines[headingIndex]), items };
    }
    return null;
  }

  // No recognised or unfamiliar heading: precision-first unheaded path. Only
  // sentences that explicitly state what the candidate must bring, with a cue
  // and a qualification signal (or a Dutch question form, which is itself the
  // signal). Bare bullets never count here — that fallback once presented
  // Job-Room metadata as requirements and stays removed.
  //
  // A single unbroken line is a flattened advertisement, not a paragraph: the
  // heading is glued to its sentence ("What we are looking for Five years…")
  // and any items would carry that glue. Those rows stay null so the structure
  // backfill can restore their line breaks; paragraphs with real breaks are
  // still extracted below.
  if (!description.includes('\n')) return null;
  const candidates: string[] = [];
  for (const line of lines) {
    if (!line || isSourceMetadata(line)) continue;
    if (isHeadingFor(line, closingHeadings)) continue;
    // A bare short heading-like line without a cue is not a requirement.
    if (line.length <= 60 && !/[.!?]$/.test(line) && line.split(' ').length <= 6 && !containsCue(line)) continue;
    for (const sentence of splitSentences(line)) {
      if (sentence.length < MIN_UNHEADED_LENGTH || sentence.length > MAX_ITEM_LENGTH) continue;
      if (isSourceMetadata(sentence) || isAboutApplying(sentence)) continue;
      if (!containsCue(sentence)) continue;
      if (!containsQualificationSignal(sentence)) continue;
      // Responsibilities state duties ("You will own…") without a cue; the cue
      // filter already drops them. Benefits ("competitive salary") and company
      // blurbs carry no cue either. What remains is grounded and quotable.
      if (candidates.includes(sentence)) continue;
      candidates.push(sentence);
      if (candidates.length === MAX_ITEMS) break;
    }
    if (candidates.length === MAX_ITEMS) break;
  }
  if (candidates.length >= 2) return { heading: '', items: candidates };
  if (candidates.length === 1 && isStrongSingleRequirement(candidates[0])) {
    return { heading: '', items: candidates };
  }
  return null;
}
