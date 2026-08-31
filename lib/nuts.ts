/**
 * NUTS region codes for the Netherlands and Switzerland, mapped to their names.
 *
 * EURES publishes a job's location as a NUTS code rather than a place name — `NL32B`, `CH031` — so
 * without this a location facet would offer "NL32B" as though it were somewhere a person could go
 * to work. NL32B is Groot-Amsterdam; CH031 is Basel-Stadt.
 *
 * Generated from Eurostat's official classification (GISCO, NUTS 2024) and bundled rather than
 * looked up: it is 92 rows for the two countries and changes only at an annual revision, so there
 * is no runtime request and no cost.
 *
 * Source: https://gisco-services.ec.europa.eu/distribution/v2/nuts/csv/NUTS_AT_2024.csv
 * Licence: European Commission reuse policy, CC BY 4.0.
 */
export const nutsRegionNames: Record<string, string> = {
  CH: 'Schweiz/Suisse/Svizzera',
  CH0: 'Schweiz/Suisse/Svizzera',
  CH01: 'Région lémanique',
  CH011: 'Vaud',
  CH012: 'Valais / Wallis',
  CH013: 'Genève',
  CH02: 'Espace Mittelland',
  CH021: 'Bern / Berne',
  CH022: 'Fribourg / Freiburg',
  CH023: 'Solothurn',
  CH024: 'Neuchâtel',
  CH025: 'Jura',
  CH03: 'Nordwestschweiz',
  CH031: 'Basel-Stadt',
  CH032: 'Basel-Landschaft',
  CH033: 'Aargau',
  CH04: 'Zürich',
  CH040: 'Zürich',
  CH05: 'Ostschweiz',
  CH051: 'Glarus',
  CH052: 'Schaffhausen',
  CH053: 'Appenzell Ausserrhoden',
  CH054: 'Appenzell Innerrhoden',
  CH055: 'St. Gallen',
  CH056: 'Graubünden / Grigioni / Grischun',
  CH057: 'Thurgau',
  CH06: 'Zentralschweiz',
  CH061: 'Luzern',
  CH062: 'Uri',
  CH063: 'Schwyz',
  CH064: 'Obwalden',
  CH065: 'Nidwalden',
  CH066: 'Zug',
  CH07: 'Ticino',
  CH070: 'Ticino',
  NL: 'Nederland',
  NL1: 'Noord-Nederland',
  NL11: 'Groningen',
  NL112: 'Delfzijl en omgeving',
  NL114: 'Oost-Groningen',
  NL115: 'Overig Groningen',
  NL12: 'Friesland (NL)',
  NL126: 'Zuidoost-Friesland',
  NL127: 'Noord-Friesland',
  NL128: 'Zuidwest-Friesland',
  NL13: 'Drenthe',
  NL131: 'Noord-Drenthe',
  NL132: 'Zuidoost-Drenthe',
  NL133: 'Zuidwest-Drenthe',
  NL2: 'Oost-Nederland',
  NL21: 'Overijssel',
  NL211: 'Noord-Overijssel',
  NL212: 'Zuidwest-Overijssel',
  NL213: 'Twente',
  NL22: 'Gelderland',
  NL221: 'Veluwe',
  NL224: 'Zuidwest-Gelderland',
  NL225: 'Achterhoek',
  NL226: 'Arnhem/Nijmegen',
  NL23: 'Flevoland',
  NL230: 'Flevoland',
  NL3: 'West-Nederland',
  NL32: 'Noord-Holland',
  NL321: 'Kop van Noord-Holland',
  NL323: 'IJmond',
  NL325: 'Zaanstreek',
  NL327: 'Het Gooi en Vechtstreek',
  NL328: 'Alkmaar en omgeving',
  NL32A: 'Agglomeratie Haarlem',
  NL32B: 'Groot-Amsterdam',
  NL34: 'Zeeland',
  NL341: 'Zeeuwsch-Vlaanderen',
  NL342: 'Overig Zeeland',
  NL35: 'Utrecht',
  NL350: 'Utrecht',
  NL36: 'Zuid-Holland',
  NL361: 'Agglomeratie ’s-Gravenhage',
  NL362: 'Delft en Westland',
  NL363: 'Agglomeratie Leiden en Bollenstreek',
  NL364: 'Zuidoost-Zuid-Holland',
  NL365: 'Oost-Zuid-Holland',
  NL366: 'Groot-Rijnmond',
  NL4: 'Zuid-Nederland',
  NL41: 'Noord-Brabant',
  NL411: 'West-Noord-Brabant',
  NL414: 'Zuidoost-Noord-Brabant',
  NL415: 'Midden-Noord-Brabant',
  NL416: 'Noordoost-Noord-Brabant',
  NL42: 'Limburg (NL)',
  NL421: 'Noord-Limburg',
  NL422: 'Midden-Limburg',
  NL423: 'Zuid-Limburg',
};

/**
 * Turn a NUTS code into a place name, falling back to the parent region when the exact code is
 * unknown.
 *
 * Codes are hierarchical — NL32B sits inside NL32 (Noord-Holland) inside NL3 (West-Nederland) — so
 * walking up beats giving up. Eurostat retires codes at each revision while job postings carry on
 * using the old ones, and "Noord-Holland" is a far better answer than "NL32B".
 */
export function nutsRegionName(code: string): string {
  const normalized = code.trim().toUpperCase();
  for (let length = normalized.length; length >= 2; length -= 1) {
    const name = nutsRegionNames[normalized.slice(0, length)];
    if (name) return name;
  }
  return '';
}

/** A NUTS code is a two-letter country followed by up to three alphanumerics. */
const nutsPattern = /^[A-Z]{2}[0-9A-Z]{0,3}$/;

/**
 * Make a stored location readable, resolving any NUTS code inside it.
 *
 * EURES hands over "NL32B NL" — a region code and its country. Other sources give free text such as
 * "Pfaeffikon · Schweiz" or "Zürich", which must pass through untouched. Resolving here rather than
 * at display time means the readable name is what gets stored, so duplicate matching compares
 * places rather than codes, and an export carries something a person can read.
 */
export function readableLocation(location: string): string {
  const parts = location.split(/[\s,·]+/).filter(Boolean);
  const named = parts.map((part) => {
    if (!nutsPattern.test(part.toUpperCase())) return part;
    // A bare country code on its own is left alone; the country is already shown separately, and
    // "Schweiz/Suisse/Svizzera" is noise next to a region name.
    if (part.length === 2) return part;
    return nutsRegionName(part) || part;
  });
  // Drop a trailing country code once a region resolved to a name: "Groot-Amsterdam NL" reads worse
  // than "Groot-Amsterdam", and the country is a separate field on the card.
  const resolvedAny = named.some((part, index) => part !== parts[index]);
  const trimmed = resolvedAny && named.length > 1 && named[named.length - 1].length === 2
    ? named.slice(0, -1)
    : named;
  return trimmed.join(' ').trim() || location.trim();
}
