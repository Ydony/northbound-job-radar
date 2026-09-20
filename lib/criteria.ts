import type { CvProfile, CvSlot, SearchCriteria } from './types';

export const defaultSearchCriteria: SearchCriteria = {
  roleOverrideA: '',
  roleOverrideB: '',
  roleKeywords: [],
  location: '',
  workplace: 'any',
  seniority: 'any',
  contractType: 'any',
  requiredKeywords: [],
  excludedKeywords: [],
  searchNetherlands: true,
  searchSwitzerland: true,
  updatedAt: '',
};

export const MAX_ROLE_KEYWORDS = 5;

export function roleForSlot(slot: CvSlot, derivedRole: string, criteria: SearchCriteria) {
  const override = slot === 'a' ? criteria.roleOverrideA : criteria.roleOverrideB;
  return override.trim() || derivedRole;
}

export function roleForProfile(profile: CvProfile, criteria: SearchCriteria) {
  return roleForSlot(profile.slot, profile.derivedRole, criteria);
}

export function normalizeRoleKeywords(values: readonly unknown[]) {
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const role = value.trim().replace(/\s+/g, ' ').slice(0, 160);
    const key = role.toLocaleLowerCase('en');
    if (!role || seen.has(key)) continue;
    seen.add(key);
    roles.push(role);
    if (roles.length === MAX_ROLE_KEYWORDS) break;
  }
  return roles;
}

export function searchTermsForProfiles(
  profiles: Array<Pick<CvProfile, 'slot' | 'derivedRole'>>,
  criteria: SearchCriteria,
) {
  return normalizeRoleKeywords([
    ...profiles.map((profile) => roleForSlot(profile.slot, profile.derivedRole, criteria)),
    ...criteria.roleKeywords,
  ]);
}

export function parseKeywordInput(value: string) {
  return [...new Set(value.split(',').map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

function normalized(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * The text keyword filtering runs against, folded exactly the way matchesSearchCriteria reads
 * it. Stored per row in `jobs.search_text` (migration 21) because SQLite LIKE cannot fold
 * accents itself: matching 'zurich' against 'Zürich' in SQL needs the folded text on disk.
 */
export function searchTextForJob(job: { title: string; location: string; description: string }) {
  return normalized(`${job.title} ${job.location} ${job.description}`);
}

/** Escape the three LIKE metacharacters so a keyword like '100%' matches itself, not anything. */
export function escapeLikePattern(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * The SQL half of the keyword filter, against the stored `search_text` column. Semantically
 * identical to matchesSearchCriteria: every required keyword must occur, no excluded keyword
 * may occur. Keywords are folded with the same normalized() so the two cannot disagree — note
 * matchesSearchCriteria does not trim either, so neither does this; stored keywords are
 * already cleaned at write time, and mirroring the exact comparison keeps legacy rows honest.
 *
 * Returns a fragment starting with ' AND …' (empty when there is nothing to filter) plus its
 * bound parameters, so callers splice it into an existing WHERE clause without renumbering.
 */
export function keywordFilterClause(
  criteria: Pick<SearchCriteria, 'requiredKeywords' | 'excludedKeywords'>,
  column = 'search_text',
): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  for (const keyword of criteria.requiredKeywords) {
    parts.push(` AND ${column} LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLikePattern(normalized(keyword))}%`);
  }
  for (const keyword of criteria.excludedKeywords) {
    parts.push(` AND ${column} NOT LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLikePattern(normalized(keyword))}%`);
  }
  return { clause: parts.join(''), params };
}

/**
 * The jobs-page half of the keyword filter. Same keyword predicates as keywordFilterClause,
 * but a job someone already saved, applied to, or dismissed always rides along even when the
 * current keywords would exclude it: Pipeline and Dismissed are views of what the person did,
 * not of what the current keywords keep, and dropping those rows would silently undo their
 * work. With no keywords there is nothing to filter, so this is empty too.
 */
export function pageFilterClause(
  criteria: Pick<SearchCriteria, 'requiredKeywords' | 'excludedKeywords'>,
): { clause: string; params: string[] } {
  const keywords = keywordFilterClause(criteria, 'jobs.search_text');
  if (!keywords.clause) return { clause: '', params: [] };
  const inner = keywords.clause.replace(/^ AND /, '');
  return {
    clause: ` AND (${inner} OR jobs.is_saved = 1`
      + ` OR jobs.application_status = 'applied' OR jobs.visibility_status = 'dismissed')`,
    params: keywords.params,
  };
}

/**
 * Does this job survive the search criteria?
 *
 * Three rules, and deliberately only three. Location, workplace, seniority and contract type were
 * all filters here and are gone: each asked someone to guess in advance at something they can see
 * on the results, and every one of them silently hid jobs. Location in particular is now a facet
 * beside the results, where narrowing is a choice made against what actually came back.
 *
 * The criteria columns for the removed filters still exist in the database and are simply not read.
 * They cost nothing there, and dropping columns is the sort of migration worth avoiding when the
 * only benefit is tidiness.
 */
/**
 * Takes the fields it reads rather than a JobRecord, because JobRecord no longer carries the
 * advertisement text. This now runs server-side, where the text still exists, and only its
 * boolean answer travels to a client.
 */
export function matchesSearchCriteria(
  job: { title: string; location: string; description: string },
  criteria: SearchCriteria,
) {
  const text = normalized(`${job.title} ${job.location} ${job.description}`);
  if (criteria.requiredKeywords.some((keyword) => !text.includes(normalized(keyword)))) return false;
  if (criteria.excludedKeywords.some((keyword) => text.includes(normalized(keyword)))) return false;
  return true;
}
