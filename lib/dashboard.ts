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

/**
 * The two live numbers on every search-statistics card (UX-6e).
 *
 * Searched is how many advertisements the source returned this run
 * (`foundCount`); Added is how many survived the filters and were stored
 * (`importedCount`). Both reset each run. The third cell, Still open, has no
 * source yet: it needs a per-source count of non-expired jobs, which is
 * blocked on the owner deciding how a missing end date counts — so the card
 * lays the cell out and leaves it unpopulated rather than printing a number
 * that would be wrong.
 */
export function sourceRunTotals(sources: Pick<SearchRunSource, 'foundCount' | 'importedCount'>[]): {
  searched: number;
  added: number;
} {
  return {
    searched: sources.reduce((sum, source) => sum + source.foundCount, 0),
    added: sources.reduce((sum, source) => sum + source.importedCount, 0),
  };
}

/**
 * The #124 counting contract, in one place so the card, the headline and the
 * tests agree.
 *
 * - New this search: first-time unique jobs this run added to this account
 *   (sum of importedCount). Never a provider-returned row count, never a sum
 *   across runs — a re-seen job updates last_seen, it does not add.
 * - Matched this search: of those new jobs, how many were English-confirmed
 *   (detector verdict at search time) and met the saved criteria then. A
 *   snapshot, not a live view: later corrections and criteria edits do not
 *   rewrite it, and the card says so.
 * - Total collected: every unique job retained from this and previous searches
 *   (server count, saved/applied/dismissed included, deleted gone). Not a sum
 *   of found counts, not the loaded page, not still-open.
 *
 * matchedUnknown is true when the matched number is incomplete: a completed
 * source with no stored matchedCount (pre-#124 rows), or a source that was
 * contacted but never completed (failed/blocked/unavailable/partial without a
 * number). Skipped and disabled sources were never contacted by choice or
 * design, so they do not make the total unknown. Unknown renders as "—",
 * never as a false zero.
 */
export interface RunNewMatchedTotals {
  newJobs: number;
  matchedJobs: number;
  matchedUnknown: boolean;
}

export function runNewMatchedTotals(
  sources: Pick<SearchRunSource, 'status' | 'importedCount' | 'matchedCount'>[],
): RunNewMatchedTotals {
  let newJobs = 0;
  let matchedJobs = 0;
  let matchedUnknown = false;
  for (const source of sources) {
    if (source.status === 'skipped' || source.status === 'disabled') continue;
    newJobs += source.importedCount;
    if (source.matchedCount == null) {
      if (source.status === 'complete' || source.status === 'partial'
        || source.status === 'failed' || source.status === 'blocked'
        || source.status === 'unavailable') {
        matchedUnknown = true;
      }
      continue;
    }
    matchedJobs += source.matchedCount;
  }
  return { newJobs, matchedJobs, matchedUnknown };
}

/** Render a matched/new count, with unknown as an em dash rather than zero. */
export function formatCountOrUnknown(value: number | null): string {
  return value == null ? '—' : `${value}`;
}

/**
 * Per-source Total collected lookup (#124). Attribution is first-kept unique:
 * each counted job belongs to exactly one shown source — a primary under its
 * own source, an orphan copy (primary deleted or outside this role's audience)
 * under the copy's source. Copies folded into a visible primary count only
 * there, never again, so the per-source numbers add up to the deduplicated
 * overall. That is the dedupe the card discloses.
 */
export function totalForSource(
  bySource: readonly { sourceKey: string; total: number }[],
  sourceKey: string,
): number | null {
  const found = bySource.find((entry) => entry.sourceKey === sourceKey);
  return found ? found.total : 0;
}

export const RUN_TOTALS_HELP =
  'New this search counts first-time jobs this run added. '
  + 'Matched this search counts those new jobs that were English-confirmed and met the saved criteria when searched. '
  + 'Total collected counts unique retained jobs from this and previous searches, including saved, applied and dismissed.';

export const MATCHED_SNAPSHOT_NOTE =
  'Matched is a snapshot at search time. Later corrections and criteria edits do not rewrite it.';

export const TOTALS_DEDUPE_NOTE =
  'Overall counts each retained job once. Per-source totals show where each counted job is kept — primaries under their own source, orphan copies under the copy\u2019s source — so they add up to the overall. Copies folded into a visible card count only there, never twice.';

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
// Explicit language filters, separate from the lifecycle views (#119).
//
// #46 merged six peer tabs into New / All matches / Pipeline plus a combined
// triage link, and left blocked advertisements browsing nowhere: `all` meant
// effective pass but was labelled "All matches", review and unknown were only
// reachable together, and New (the default) mixed pass/review/unknown. The
// stored verdicts never went away, so this restores them as an orthogonal
// selector: English confirmed / Needs review / Not enough of the ad / Local
// language required / All language results.
//
// Lifecycle (New / All / Pipeline / Dismissed) answers "how recent / what did
// I do"; language answers "what did the screen say". New means first
// discovered since the cutoff, never language approval, so New narrows by the
// language choice like All does. Pipeline and Dismissed are records of what
// the person did and keep their ride-along: they ignore the language choice,
// exactly as they already ignore the saved keywords. Blocked rows browse only
// under Local language required or All language results, never promoted.
// ---------------------------------------------------------------------------

/**
 * The browsing lifecycle. `all` is every saved active result, not only recent
 * arrivals and not only one verdict — the language selector narrows it.
 * `new` is first seen since the cutoff, whatever the verdict filter says.
 */
export type DashboardView = 'new' | 'all' | 'pipeline' | 'dismissed';

export const DASHBOARD_VIEW_LABELS: Record<DashboardView, string> = {
  new: 'New',
  all: 'All',
  pipeline: 'Pipeline',
  dismissed: 'Dismissed',
};

/**
 * The explicit language-result selector (#119). Driven by the effective
 * verdict (user correction wins over the detector), never the detector alone.
 * `all` reaches every verdict including blocked; the four singletons reach
 * exactly one verdict each.
 */
export type LanguageFilter = 'pass' | 'review' | 'unknown' | 'blocked' | 'all';

export const LANGUAGE_FILTER_LABELS: Record<LanguageFilter, string> = {
  pass: 'English confirmed',
  review: 'Needs review',
  unknown: 'Not enough of the ad',
  blocked: 'Local language required',
  all: 'All language results',
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
 * Whether one job satisfies an explicit language choice. The effective
 * verdict decides, so a user correction moves the card with it. `all`
 * reaches every verdict including blocked; it never promotes blocked rows,
 * it only lists them where they were asked for.
 */
export function jobMatchesLanguage(
  job: Pick<JobRecord, 'languageStatus' | 'languageFeedback' | 'correctedLanguageStatus'>,
  filter: LanguageFilter,
): boolean {
  if (filter === 'all') return true;
  return effectiveLanguageStatus(job) === filter;
}

/**
 * Whether one job belongs in a browsing view under an explicit language
 * choice. Pipeline and Dismissed are records of what the person did, so
 * acted-on rows ride along even when the saved keywords or the language
 * choice would exclude them — the same ride-along the server applies before
 * paging. Everything else must match the saved criteria and the language
 * choice; New additionally means first seen since the cutoff.
 */
export function jobInView(job: JobRecord, view: DashboardView, cutoff: string, language: LanguageFilter): boolean {
  if (view === 'dismissed') return job.visibilityStatus === 'dismissed';
  if (job.visibilityStatus !== 'active') return false;
  if (view === 'pipeline') return job.isSaved || job.applicationStatus === 'applied';
  if (!job.matchesCriteria) return false;
  if (!jobMatchesLanguage(job, language)) return false;
  if (view === 'new') return isNewJob(job, cutoff);
  return true;
}

export interface FilterPill {
  key: 'country' | 'city' | 'source' | 'workType' | 'application' | 'required' | 'excluded' | 'language';
  label: string;
}

function keywordPillLabel(prefix: string, keywords: readonly string[]): string {
  const shown = keywords.slice(0, 3).join(', ');
  const rest = keywords.length - Math.min(keywords.length, 3);
  return `${prefix}: ${shown}${rest > 0 ? ` +${rest} more` : ''}`;
}

/**
 * Every active constraint — saved keywords, the language choice and temporary
 * facets alike — as one list for the pill row above the results. Saved
 * keywords come first because they are the ones that silently empty the list
 * from another screen; the language choice follows because it, too, is set
 * outside the facet column. `all` means no language constraint and shows no
 * pill. Pipeline and Dismissed ignore the language choice (ride-along), so
 * callers there pass `all` and show no language pill rather than one that
 * claims to filter a list it does not narrow.
 */
export function activeFilterPills(filters: {
  country: string;
  city: string;
  source: string;
  sourceName: string;
  workType: string;
  application: string;
  language: LanguageFilter;
  requiredKeywords: readonly string[];
  excludedKeywords: readonly string[];
}): FilterPill[] {
  const pills: FilterPill[] = [];
  if (filters.excludedKeywords.length) pills.push({ key: 'excluded', label: keywordPillLabel('Excludes', filters.excludedKeywords) });
  if (filters.requiredKeywords.length) pills.push({ key: 'required', label: keywordPillLabel('Requires', filters.requiredKeywords) });
  if (filters.language !== 'all') pills.push({ key: 'language', label: LANGUAGE_FILTER_LABELS[filters.language] });
  if (filters.country !== 'all') pills.push({ key: 'country', label: countryLabel(filters.country as JobCountry) });
  if (filters.city !== 'all') pills.push({ key: 'city', label: filters.city });
  if (filters.source !== 'all') pills.push({ key: 'source', label: filters.sourceName || filters.source });
  if (filters.workType !== 'all') pills.push({ key: 'workType', label: workplaceLabel(filters.workType as WorkplaceType) });
  if (filters.application !== 'all') {
    pills.push({ key: 'application', label: filters.application === 'applied' ? 'Applied' : 'Not applied' });
  }
  return pills;
}

export interface WorkspaceCountFacts {
  /** Visible (deduplicated) rows on the loaded pages. */
  shown: number;
  /** Server-exact keyword matches across every page, duplicates included. */
  matching: number;
  /** Every row owned across every page, duplicates included. */
  total: number;
  /** Copies folded into the shown rows, on the loaded pages. */
  hiddenDuplicates: number;
  /** More pages remain below; shown and hiddenDuplicates are partial. */
  hasMorePages: boolean;
}

/**
 * The one line summarising the whole workspace. `shown` is deduplicated rows on
 * screen, so calling it "matching" invents a criteria effect that never happened
 * (#92): with no keywords set, the gap between shown and total is folded
 * duplicates, not failed matches. Name each live effect instead — keyword
 * filtering via matching, duplicate folding via the folded count — and drop a
 * number when it claims nothing.
 */
export function workspaceCountCopy(facts: WorkspaceCountFacts): string {
  const shown = Math.max(0, facts.shown);
  const matching = Math.max(0, facts.matching);
  const total = Math.max(0, facts.total);
  const folded = Math.max(0, facts.hiddenDuplicates);
  if (facts.hasMorePages) {
    return `Showing ${shown} of ${matching} matching — more below`;
  }
  if (matching < total) {
    return `${shown} shown · ${matching} matching · ${total} analyzed`;
  }
  if (folded > 0) {
    return `${shown} job${shown === 1 ? '' : 's'} · ${folded} duplicate${folded === 1 ? '' : 's'} folded · ${total} analyzed`;
  }
  return `${total} analyzed`;
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
 * then the saved keywords (a server-exact count), then one line per
 * view-and-language combination. Unloaded pages come before the keyword
 * count: with jobs still below, no culprit can honestly be named yet.
 * Pipeline and Dismissed ignore the language choice (ride-along), so their
 * lines never name it. No line promises perfect classification: the screen
 * is a best-effort gate, and corrections are how it improves.
 */
export function emptyStateCopy(
  view: DashboardView,
  language: LanguageFilter,
  facts: EmptyStateFacts,
): { title: string; detail: string } {
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
  if (view === 'dismissed') {
    return { title: 'Nothing dismissed', detail: 'Dismissed jobs wait here instead of in your way.' };
  }
  if (view === 'pipeline') {
    return { title: 'Pipeline is empty', detail: 'Save a job or mark it applied and it waits here.' };
  }
  const isNew = view === 'new';
  switch (language) {
    case 'pass':
      return isNew
        ? { title: 'Nothing new in English confirmed', detail: 'Run a search to look for more. Other new arrivals may wait under a different language filter.' }
        : { title: 'No English-confirmed jobs yet', detail: 'Run a search, or widen the language filter to check the other verdicts.' };
    case 'review':
      return isNew
        ? { title: 'Nothing new needs review', detail: 'Run a search to look for more, or check another language filter.' }
        : { title: 'Nothing needs review', detail: 'Every screened ad long enough to judge is either confirmed English or out.' };
    case 'unknown':
      return isNew
        ? { title: 'Nothing new is too short to judge', detail: 'Run a search to look for more, or check another language filter.' }
        : { title: 'Nothing is too short to judge', detail: 'Every screened ad published enough text to reach a verdict.' };
    case 'blocked':
      return isNew
        ? { title: 'Nothing new needs a local language', detail: 'Run a search to look for more, or check another language filter.' }
        : { title: 'No local-language jobs in view', detail: 'Widen the language filter to see the other verdicts.' };
    default:
      return isNew
        ? { title: 'Nothing new since the last search', detail: 'Run a search to look for more.' }
        : { title: 'No jobs in this view yet', detail: 'Run a search, or widen the filters.' };
  }
}
