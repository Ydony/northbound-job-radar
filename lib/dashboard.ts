import type { LanguageStatus } from './analysis';
import type { JobRecord, SearchCriteria, SourceRunStatus } from './types';

export interface CriteriaDraft extends Omit<SearchCriteria, 'requiredKeywords' | 'excludedKeywords' | 'updatedAt'> {
  requiredKeywords: string;
  excludedKeywords: string;
}

export function criteriaToDraft(criteria: SearchCriteria): CriteriaDraft {
  return {
    roleOverrideA: criteria.roleOverrideA,
    roleOverrideB: criteria.roleOverrideB,
    roleKeywords: [...criteria.roleKeywords],
    location: criteria.location,
    workplace: criteria.workplace,
    seniority: criteria.seniority,
    contractType: criteria.contractType,
    requiredKeywords: criteria.requiredKeywords.join(', '),
    excludedKeywords: criteria.excludedKeywords.join(', '),
    searchNetherlands: criteria.searchNetherlands,
    searchSwitzerland: criteria.searchSwitzerland,
  };
}

// Returns null for the default state on purpose. "Not applied" was printed on every unhandled
// job, which is roughly 95% of rows, so it carried no information while competing for attention
// with the language verdict beside it. A pipeline badge now appears only when it says something.
export function statusLabel(job: JobRecord) {
  if (job.visibilityStatus === 'dismissed') return 'Dismissed';
  if (job.applicationStatus === 'applied') return 'Applied';
  if (job.isSaved) return 'Saved';
  return null;
}

// The stored value is the contract; this is presentation only. Printing the raw enum put
// "complete" and "partial" on screen in lowercase next to sentence-cased everything else.
export const SOURCE_RUN_STATUS_LABELS: Record<SourceRunStatus, string> = {
  complete: 'Completed',
  partial: 'Partly returned',
  failed: "Couldn't be reached",
  blocked: 'Blocked',
  disabled: 'Turned off',
  unavailable: 'Unavailable',
  skipped: 'Not searched',
};

// Failed and blocked sources are the only rows anyone can act on, so they sort to the front.
// Everything below them is a source that did its job and needs no attention.
export const SOURCE_RUN_STATUS_RANK: Record<SourceRunStatus, number> = {
  // 'skipped' sorts last with 'complete': the person switched that country off, so there is
  // nothing to act on and it should not compete for attention with a source that failed.
  failed: 0, blocked: 1, unavailable: 2, disabled: 3, partial: 4, complete: 5, skipped: 6,
};

export function sourceRunStatusLabel(status: SourceRunStatus) {
  return SOURCE_RUN_STATUS_LABELS[status] ?? status;
}

export function bestFitScore(job: JobRecord) {
  return Math.max(job.fitScoreA, job.fitScoreB);
}

export function languageStatusLabel(status: LanguageStatus) {
  if (status === 'pass') return 'English confirmed';
  // Deliberately not phrased as a near-miss. The advertisement was too short to judge, which is a
  // different thing from looking acceptable, and the old wording claimed the latter.
  if (status === 'unknown') return 'Not enough of the ad';
  if (status === 'review') return 'Review language';
  return 'Local language required';
}

export function formatDate(value: string) {
  if (!value) return 'Posting date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return `Posted ${value.slice(0, 10)}`;
  return `Posted ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)}`;
}
