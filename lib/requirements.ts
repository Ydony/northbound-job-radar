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
  'what we are looking for', "what we're looking for", 'we are looking for', 'you have',
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

/** Strip the bullet glyph and numbering an ad prefixes its items with. */
function cleanItem(line: string) {
  return line
    .replace(/^\s*(?:[•*·●▪>-]|\d+[.)])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ExtractedRequirements {
  /** The heading the items were found under, as the advertisement wrote it. */
  heading: string;
  items: string[];
}

const MAX_ITEMS = 6;
/** Long enough to be a requirement, short enough not to be a paragraph of prose. */
const MIN_ITEM_LENGTH = 12;
const MAX_ITEM_LENGTH = 220;

export function extractRequirements(description: string): ExtractedRequirements | null {
  const lines = description.split('\n').map((line) => line.trim());
  const headingIndex = lines.findIndex((line) => isHeadingFor(line, requirementHeadings));
  if (headingIndex === -1) return null;

  const items: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (!line) continue;
    // Stop at the next section rather than running on into what the employer is offering.
    if (isHeadingFor(line, closingHeadings) || isHeadingFor(line, requirementHeadings)) break;
    const item = cleanItem(line);
    if (item.length < MIN_ITEM_LENGTH || item.length > MAX_ITEM_LENGTH) continue;
    items.push(item);
    if (items.length === MAX_ITEMS) break;
  }

  // One line under a heading is usually a stray sentence rather than a requirements list, and
  // showing a single item implies the job asks for one thing.
  if (items.length < 2) return null;
  // Job-Room wraps its headings in markdown rules ("### Your profile ###"), which are an
  // artefact of its own formatting rather than something the employer wrote.
  const heading = lines[headingIndex].replace(/^[#*\s]+/, '').replace(/[#*:\s]+$/, '');
  return { heading, items };
}
