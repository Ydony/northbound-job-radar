import type { CvProfile, CvSlot, JobRecord, SearchCriteria } from './types';

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
export function matchesSearchCriteria(job: JobRecord, criteria: SearchCriteria) {
  const text = normalized(`${job.title} ${job.location} ${job.description}`);
  if (criteria.requiredKeywords.some((keyword) => !text.includes(normalized(keyword)))) return false;
  if (criteria.excludedKeywords.some((keyword) => text.includes(normalized(keyword)))) return false;
  return true;
}
