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

function matchesPattern(text: string, patterns: Record<string, RegExp>, selection: string) {
  return selection === 'any' || Boolean(patterns[selection]?.test(text));
}

export function matchesSearchCriteria(job: JobRecord, criteria: SearchCriteria) {
  const title = normalized(job.title);
  const text = normalized(`${job.title} ${job.location} ${job.description}`);
  if (criteria.location && !normalized(job.location).includes(normalized(criteria.location))) return false;
  if (criteria.requiredKeywords.some((keyword) => !text.includes(normalized(keyword)))) return false;
  if (criteria.excludedKeywords.some((keyword) => text.includes(normalized(keyword)))) return false;

  // Uses the value detected at import time rather than re-matching prose, so the filter and the
  // badge on the card can never disagree.
  if (criteria.workplace !== 'any' && job.workplaceType !== criteria.workplace) return false;

  const seniorityPatterns: Record<string, RegExp> = {
    internship: /\b(?:intern|internship|trainee|apprentice)\b/i,
    entry: /\b(?:junior|entry[- ]level|graduate|associate)\b/i,
    mid: /\b(?:mid[- ]level|professional|specialist)\b/i,
    senior: /\b(?:senior|sr\.)\b/i,
    lead: /\b(?:lead|principal|staff|head|director|chief)\b/i,
  };
  if (!matchesPattern(title, seniorityPatterns, criteria.seniority)) return false;

  const contractPatterns: Record<string, RegExp> = {
    permanent: /\b(?:permanent|unlimited|full[- ]time|indefinite)\b/i,
    temporary: /\b(?:temporary|fixed[- ]term|limited contract)\b/i,
    contract: /\b(?:contractor|freelance|freelancer|consulting contract)\b/i,
    internship: /\b(?:intern|internship|trainee)\b/i,
  };
  return matchesPattern(text, contractPatterns, criteria.contractType);
}
