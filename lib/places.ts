import { nutsRegionNames } from './nuts';

/**
 * Tidy a job's location into something a facet can group by.
 *
 * Sources spell the same place several ways, and the place filter counts each spelling separately:
 * 483 distinct places across 1,504 jobs, with "Zürich" and "Zürich 8000 ZH" as two entries, three
 * spellings of Amsterdam, and "Schweiz" sitting in the list as though it were somewhere to work.
 *
 * The rules below are deliberately narrow. Merging two places that are genuinely different is
 * worse than leaving a duplicate: a facet with a stray entry is untidy, but one that hides Basel
 * inside Bern is wrong. So this only removes suffixes it can positively identify — a postal code,
 * a known province or canton — and otherwise leaves the text exactly as the source wrote it.
 */

/** Dutch provinces and Swiss cantons, as sources append them to a city name. */
const regionSuffixes = [
  // Netherlands
  'noord-holland', 'zuid-holland', 'noord-brabant', 'zuid-limburg', 'limburg', 'utrecht',
  'gelderland', 'overijssel', 'flevoland', 'friesland', 'fryslan', 'fryslân', 'groningen',
  'drenthe', 'zeeland',
  // Switzerland — full names
  'zurich', 'zürich', 'bern', 'berne', 'luzern', 'lucerne', 'aargau', 'thurgau', 'graubunden',
  'graubünden', 'ticino', 'valais', 'wallis', 'vaud', 'geneve', 'genève', 'geneva', 'fribourg',
  'freiburg', 'solothurn', 'basel-stadt', 'basel-landschaft', 'schaffhausen', 'appenzell',
  'st. gallen', 'sankt gallen', 'glarus', 'zug', 'schwyz', 'obwalden', 'nidwalden', 'uri',
  'neuchatel', 'neuchâtel', 'jura',
];

/** Two-letter canton codes, which follow a Swiss postal code: "Zürich 8000 ZH". */
const cantonCodes = new Set([
  'ZH', 'BE', 'LU', 'UR', 'SZ', 'OW', 'NW', 'GL', 'ZG', 'FR', 'SO', 'BS', 'BL', 'SH', 'AR', 'AI',
  'SG', 'GR', 'AG', 'TG', 'TI', 'VD', 'VS', 'NE', 'GE', 'JU',
]);

/** Names for a whole country, which are not a place anyone is hired *into*. */
const countryWords = new Map<string, 'Netherlands' | 'Switzerland'>([
  ['nederland', 'Netherlands'], ['netherlands', 'Netherlands'], ['holland', 'Netherlands'],
  ['schweiz', 'Switzerland'], ['suisse', 'Switzerland'], ['svizzera', 'Switzerland'],
  ['switzerland', 'Switzerland'], ['schweiz/suisse/svizzera', 'Switzerland'],
]);

const fold = (value: string) => value
  .toLocaleLowerCase('en')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[.,]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Every place name Eurostat publishes for these two countries.
 *
 * Needed because several NUTS names *end* in a province — "Kop van Noord-Holland", "Overig
 * Groningen" — and treating that province as a removable suffix produced "Kop van" and "Overig".
 * A name from this table is already canonical and is never rewritten.
 */
const canonicalRegionNames = new Set(Object.values(nutsRegionNames).map(fold));

/**
 * The label a location should be grouped under.
 *
 * Returns `{ place, countryWide }`. `countryWide` marks a location that names only a country, so
 * the interface can say "across Switzerland" rather than offering it as a city — 93 jobs in the
 * stored corpus say only "Schweiz" or "Nederland", and listing those beside Utrecht implies a
 * precision the advertisement never had.
 */
export function normalizePlace(location: string): { place: string; countryWide: boolean } {
  const trimmed = location.replace(/\s+/g, ' ').trim();
  if (!trimmed) return { place: '', countryWide: false };

  const country = countryWords.get(fold(trimmed));
  if (country) return { place: country, countryWide: true };

  // A name straight out of the NUTS table is already canonical, and several of them end in a
  // province: "Kop van Noord-Holland", "Overig Groningen", "Zuidoost-Noord-Brabant". Treating that
  // province as a suffix produced "Kop van" and "Overig". Leave them exactly as Eurostat has them.
  if (canonicalRegionNames.has(fold(trimmed))) return { place: trimmed, countryWide: false };

  let working = trimmed;

  // "Zürich 8000 ZH" and "Zürich 8000" — a postal code, optionally followed by a canton code.
  working = working.replace(/\s+\d{4,5}(\s+[A-Z]{2})?$/, (match) => {
    const code = match.trim().split(/\s+/)[1];
    return !code || cantonCodes.has(code) ? '' : match;
  });

  // "Amsterdam, Noord-Holland" and "Amsterdam Noord-Holland" — a region appended to a city. Only
  // stripped when something is left over, so "Utrecht" on its own survives as the city it also is.
  for (const suffix of regionSuffixes) {
    const pattern = new RegExp(`[,\\s]+${suffix.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'i');
    const stripped = working.replace(pattern, '').trim();
    if (stripped && fold(stripped) !== fold(working)) {
      working = stripped;
      break;
    }
  }

  return { place: working.replace(/[,\s]+$/, '').trim() || trimmed, countryWide: false };
}
