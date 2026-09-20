import type { LanguageStatus } from './analysis';
import { effectiveLanguageStatus } from './language-feedback';
import { countryLabel } from './job-identity';
import { workplaceLabel } from './workplace';
import type { JobCountry, JobRecord, SearchCriteria, SearchRun, SearchRunSource, SourceRunStatus } from './types';
import type { WorkplaceType } from './workplace';

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

/**
 * One line that accounts for every new listing a source returned (#94).
 *
 * A run report excerpt once read as having lost 28 jobs: `new` was compared
 * against `added` with the duplicate share omitted, and nothing on screen made
 * that omission obvious. `new` always accounts for itself as
 * `imported + duplicate + skipped` — a listing that passes the known-URL
 * pre-check as new can still fold into a duplicate at insert (identity or
 * cluster near-duplicate, e.g. the same advertisement under different ids from
 * overlapping role-term queries), which is correct behaviour, not a loss.
 * Rendering the three parts as an equation keeps any excerpt honest.
 */
export function formatSourceReconciliation(source: Pick<
  SearchRunSource, 'newCount' | 'importedCount' | 'duplicateCount' | 'skippedCount'
>): string {
  const duplicates = `${source.duplicateCount} duplicate${source.duplicateCount === 1 ? '' : 's'}`;
  return `${source.newCount} new = ${source.importedCount} added`
    + ` + ${duplicates} + ${source.skippedCount} skipped`;
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

/**
 * Whether the stored advertisement has outlived its publication window (#97).
 *
 * Derived on read from the end date kept at collection, never fetched: an advertisement can
 * expire at any time after it was collected, and re-fetching every stored job to check would
 * be one request per job against other people's servers. Empty means the source published
 * no expiry, which is not the same as being expired. The end date is inclusive - the
 * advertisement is still open on the day it closes - so only a strictly past date counts,
 * matching isPublicationOpen in lib/job-room.ts.
 */
export function isJobExpired(job: Pick<JobRecord, 'expiresAt'>, today = new Date()): boolean {
  if (!job.expiresAt) return false;
  return job.expiresAt.slice(0, 10) < today.toISOString().slice(0, 10);
}

/** Whether the advertisement closes today: still open, but the link may die under it. */
export function closesToday(job: Pick<JobRecord, 'expiresAt'>, today = new Date()): boolean {
  if (!job.expiresAt) return false;
  return job.expiresAt.slice(0, 10) === today.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// One filter surface and a New default view (#46).
//
// Six peer view tabs became three primary ones — New, All matches, Pipeline —
// with the triage chores (review + too-short ads) behind one quieter link and
// Dismissed behind an undo affordance plus its own quiet link. Blocked
// advertisements browse nowhere: they are definitively not matches, and the
// administrator conversion report still counts them.
// ---------------------------------------------------------------------------

/**
 * The browsing views. `all` is the English-confirmed match list (what the old
 * `matches` tab showed), not the old `all` tab that mixed every verdict —
 * that mode is gone along with the blocked rows only it could reach.
 */
export type DashboardView = 'new' | 'all' | 'pipeline' | 'triage' | 'dismissed';

export const DASHBOARD_VIEW_LABELS: Record<DashboardView, string> = {
  new: 'New',
  all: 'All matches',
  pipeline: 'Pipeline',
  triage: 'Needs a look',
  dismissed: 'Dismissed',
};

export type SortMode = 'fit' | 'posted' | 'found';

export const SORT_MODE_LABELS: Record<SortMode, string> = {
  fit: 'Best fit',
  posted: 'Newest posted',
  found: 'Recently found',
};

/** ISO timestamps compare lexicographically; missing dates sort after dated ones. */
function compareIsoDesc(a: string, b: string) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

/**
 * Order one page of jobs for the list. Ties break on id so the order is
 * stable regardless of which page a job arrived on — the fit order callers
 * used to get inline, plus the two orders the sort control offers.
 */
export function sortJobs(jobs: JobRecord[], mode: SortMode): JobRecord[] {
  const copy = [...jobs];
  if (mode === 'posted') copy.sort((a, b) => compareIsoDesc(a.postedAt, b.postedAt) || a.id.localeCompare(b.id));
  else if (mode === 'found') copy.sort((a, b) => compareIsoDesc(a.firstSeenAt, b.firstSeenAt) || a.id.localeCompare(b.id));
  else copy.sort((a, b) => bestFitScore(b) - bestFitScore(a) || a.id.localeCompare(b.id));
  return copy;
}

/** Jobs first seen less than this long ago count as new when no search has run yet. */
const NEW_FALLBACK_DAYS = 7;

/**
 * The "what's new since last run" cutoff: the latest finished run's start, so
 * everything that run introduced counts. Before any run, the last seven days
 * by first sighting, so the default landing view has a truthful meaning on a
 * workspace that was filled by import rather than by search.
 */
export function newSinceCutoff(searchRuns: SearchRun[], nowIso: string): string {
  const latest = searchRuns.find((run) => run.completedAt);
  if (latest) return latest.startedAt || latest.completedAt;
  const now = Date.parse(nowIso);
  const fallback = Number.isFinite(now) ? now - NEW_FALLBACK_DAYS * 86400_000 : Date.now();
  return new Date(Math.max(0, fallback)).toISOString();
}

export function isNewJob(job: Pick<JobRecord, 'firstSeenAt'>, cutoff: string): boolean {
  return Boolean(job.firstSeenAt) && job.firstSeenAt >= cutoff;
}

/**
 * Whether one job belongs in a browsing view. Pipeline and Dismissed are
 * records of what the person did, so acted-on rows ride along even when the
 * saved keywords would exclude them — the same ride-along the server applies
 * before paging. Everything else must match the saved criteria, and blocked
 * advertisements appear in no view.
 */
export function jobInView(job: JobRecord, view: DashboardView, cutoff: string): boolean {
  if (view === 'dismissed') return job.visibilityStatus === 'dismissed';
  if (job.visibilityStatus !== 'active') return false;
  if (view === 'pipeline') return job.isSaved || job.applicationStatus === 'applied';
  if (!job.matchesCriteria) return false;
  const language = effectiveLanguageStatus(job);
  if (view === 'triage') return language === 'review' || language === 'unknown';
  if (language === 'blocked') return false;
  if (view === 'new') return isNewJob(job, cutoff);
  return language === 'pass';
}

export interface FilterPill {
  key: 'country' | 'city' | 'source' | 'workType' | 'application' | 'required' | 'excluded';
  label: string;
}

function keywordPillLabel(prefix: string, keywords: readonly string[]): string {
  const shown = keywords.slice(0, 3).join(', ');
  const rest = keywords.length - Math.min(keywords.length, 3);
  return `${prefix}: ${shown}${rest > 0 ? ` +${rest} more` : ''}`;
}

/**
 * Every active constraint — saved keywords and temporary facets alike — as
 * one list for the pill row above the results. Saved keywords come first
 * because they are the ones that silently empty the list from another screen.
 */
export function activeFilterPills(filters: {
  country: string;
  city: string;
  source: string;
  sourceName: string;
  workType: string;
  application: string;
  requiredKeywords: readonly string[];
  excludedKeywords: readonly string[];
}): FilterPill[] {
  const pills: FilterPill[] = [];
  if (filters.excludedKeywords.length) pills.push({ key: 'excluded', label: keywordPillLabel('Excludes', filters.excludedKeywords) });
  if (filters.requiredKeywords.length) pills.push({ key: 'required', label: keywordPillLabel('Requires', filters.requiredKeywords) });
  if (filters.country !== 'all') pills.push({ key: 'country', label: countryLabel(filters.country as JobCountry) });
  if (filters.city !== 'all') pills.push({ key: 'city', label: filters.city });
  if (filters.source !== 'all') pills.push({ key: 'source', label: filters.sourceName || filters.source });
  if (filters.workType !== 'all') pills.push({ key: 'workType', label: workplaceLabel(filters.workType as WorkplaceType) });
  if (filters.application !== 'all') {
    pills.push({ key: 'application', label: filters.application === 'applied' ? 'Applied' : 'Not applied' });
  }
  return pills;
}

export interface EmptyStateFacts {
  /** Every job owned (and visible to this role), from the server total, not the loaded page. */
  totalJobs: number;
  /** Server-exact count kept out by the saved keywords: total minus matching. */
  removedByKeywords: number;
  /** Jobs in this view before the facet filters narrow them, on the loaded pages. */
  inViewCount: number;
  hasExcludedKeywords: boolean;
  hasRequiredKeywords: boolean;
  hasMorePages: boolean;
}

/**
 * Name the culprit when the list is empty, so "no jobs" reads as an answer
 * rather than a mystery. Facets first (they narrow what is already here),
 * then the saved keywords (a server-exact count), then one line per view.
 * Unloaded pages come before the keyword count: with jobs still below, no
 * culprit can honestly be named yet.
 */
export function emptyStateCopy(view: DashboardView, facts: EmptyStateFacts): { title: string; detail: string } {
  if (facts.totalJobs === 0) {
    return {
      title: 'No jobs yet',
      detail: 'Add a role keyword in Search settings, then run a search.',
    };
  }
  if (facts.inViewCount > 0) {
    return {
      title: 'No jobs match these filters',
      detail: 'Remove a filter above to bring them back.',
    };
  }
  if (facts.hasMorePages) {
    return {
      title: view === 'new' ? 'Nothing new on this page' : 'Nothing on this page',
      detail: 'More matching jobs are still loading — show them below.',
    };
  }
  if (facts.removedByKeywords > 0) {
    const what = facts.hasExcludedKeywords ? 'excluded' : facts.hasRequiredKeywords ? 'required' : 'saved';
    return {
      title: 'No jobs match',
      detail: `${facts.removedByKeywords} ${facts.removedByKeywords === 1 ? 'was' : 'were'} removed by your ${what} keywords.`,
    };
  }
  switch (view) {
    case 'new':
      return { title: 'Nothing new since the last search', detail: 'Run a search to look for more.' };
    case 'triage':
      return { title: 'Nothing needs a look', detail: 'Every screened ad is either confirmed English or out.' };
    case 'dismissed':
      return { title: 'Nothing dismissed', detail: 'Dismissed jobs wait here instead of in your way.' };
    case 'pipeline':
      return { title: 'Pipeline is empty', detail: 'Save a job or mark it applied and it waits here.' };
    default:
      return { title: 'No jobs in this view yet', detail: 'Run a search, or widen the filters.' };
  }
}
