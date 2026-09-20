import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSearchCriteria } from '../lib/criteria';
import { SOURCE_RUN_STATUS_LABELS, SOURCE_RUN_STATUS_RANK, activeFilterPills, bestFitScore, criteriaToDraft,
  DASHBOARD_VIEW_LABELS, emptyStateCopy, formatDate, isNewJob, jobInView, languageStatusLabel,
  newSinceCutoff, SORT_MODE_LABELS, sortJobs, sourceRunStatusLabel, statusLabel, workspaceCountCopy } from '../lib/dashboard';
import type { JobRecord, SearchCriteria, SearchRun, SourceRunStatus } from '../lib/types';
import type { LanguageStatus } from '../lib/analysis';

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    workplaceType: 'hybrid',
    sourceUrl: 'https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000/',
    canonicalUrl: 'https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000',
    sourceKey: 'jobs.ch',
    sourceName: 'jobs.ch',
    sourceJobId: '00000000-0000-0000-0000-000000000000',
    country: 'switzerland',
    title: 'Senior Data Governance Analyst',
    company: 'Example AG',
    location: 'Zürich 8000',
    descriptionLength: 84,
    requirements: null,
    excerpt: null,
    matchesCriteria: true,
    languageStatus: 'pass',
    languageSummary: 'English sufficient.',
    languageSignals: [],
    languageFeedback: '',
    correctedLanguageStatus: '',
    languageFeedbackReason: '',
    languageFeedbackUpdatedAt: '',
    fitScoreA: 80,
    fitScoreB: 90,
    bestCvSlot: 'b',
    matchedKeywords: ['sql'],
    missingKeywords: [],
    identityFingerprint: 'job-v1-example',
    duplicateOf: '',
    isSaved: false,
    applicationStatus: 'not_applied',
    visibilityStatus: 'active',
    postedAt: '2026-08-25T00:00:00.000Z',
    firstSeenAt: '2026-08-26T00:00:00.000Z',
    lastSeenAt: '2026-08-26T00:00:00.000Z',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

test('statusLabel stays silent for the default state and prefers dismissal', () => {
  // "Not applied" on ~95% of rows carried no information, so the default renders no badge.
  assert.equal(statusLabel(job()), null);
  assert.equal(statusLabel(job({ isSaved: true })), 'Saved');
  assert.equal(statusLabel(job({ applicationStatus: 'applied' })), 'Applied');
  assert.equal(statusLabel(job({ visibilityStatus: 'dismissed' })), 'Dismissed');
  // Dismissal wins over everything else: a dismissed job leaves the current view entirely.
  assert.equal(statusLabel(job({ visibilityStatus: 'dismissed', applicationStatus: 'applied', isSaved: true })), 'Dismissed');
  // An applied job still reads as applied even when it is also saved.
  assert.equal(statusLabel(job({ applicationStatus: 'applied', isSaved: true })), 'Applied');
});

test('every source run status has a label and a rank, with failures first', () => {
  const statuses: SourceRunStatus[] = ['complete', 'partial', 'failed', 'blocked', 'disabled', 'unavailable', 'skipped'];
  assert.deepEqual(Object.keys(SOURCE_RUN_STATUS_LABELS).sort(), [...statuses].sort());
  assert.deepEqual(Object.keys(SOURCE_RUN_STATUS_RANK).sort(), [...statuses].sort());
  for (const status of statuses) {
    assert.ok(SOURCE_RUN_STATUS_LABELS[status].length > 0, `${status} needs a label`);
    assert.equal(typeof SOURCE_RUN_STATUS_RANK[status], 'number', `${status} needs a rank`);
    assert.equal(sourceRunStatusLabel(status), SOURCE_RUN_STATUS_LABELS[status]);
  }
  // The exact labels are pinned: the stored enum is the contract, this is presentation only.
  assert.deepEqual(SOURCE_RUN_STATUS_LABELS, {
    complete: 'Completed',
    partial: 'Partly returned',
    failed: "Couldn't be reached",
    blocked: 'Blocked',
    disabled: 'Turned off',
    unavailable: 'Unavailable',
    skipped: 'Not searched',
  });
  // Failed and blocked are the only rows anyone can act on, so they sort to the front.
  // Skipped and complete need no attention and sort last.
  const byRank = [...statuses].sort((a, b) => SOURCE_RUN_STATUS_RANK[a] - SOURCE_RUN_STATUS_RANK[b]);
  assert.deepEqual(byRank, ['failed', 'blocked', 'unavailable', 'disabled', 'partial', 'complete', 'skipped']);
  assert.ok(SOURCE_RUN_STATUS_RANK.failed < SOURCE_RUN_STATUS_RANK.complete);
  assert.ok(SOURCE_RUN_STATUS_RANK.blocked < SOURCE_RUN_STATUS_RANK.partial);
  assert.ok(SOURCE_RUN_STATUS_RANK.complete < SOURCE_RUN_STATUS_RANK.skipped
    || SOURCE_RUN_STATUS_RANK.complete === SOURCE_RUN_STATUS_RANK.skipped
    || SOURCE_RUN_STATUS_RANK.skipped === 6);
});

test('sourceRunStatusLabel falls back to the raw status for unknown values', () => {
  assert.equal(sourceRunStatusLabel('bogus' as SourceRunStatus), 'bogus');
});

test('languageStatusLabel never phrases unknown as a near-miss', () => {
  assert.equal(languageStatusLabel('pass'), 'English confirmed');
  // The ad was too short to judge, which is different from looking acceptable;
  // the old wording claimed the latter.
  assert.equal(languageStatusLabel('unknown'), 'Not enough of the ad');
  assert.match(languageStatusLabel('unknown'), /not enough/i);
  assert.doesNotMatch(languageStatusLabel('unknown'), /almost|near|maybe|likely|promising/i);
  assert.equal(languageStatusLabel('review'), 'Review language');
  assert.equal(languageStatusLabel('blocked'), 'Local language required');
  const every: LanguageStatus[] = ['pass', 'unknown', 'review', 'blocked'];
  for (const status of every) assert.ok(languageStatusLabel(status).length > 0);
});

test('bestFitScore takes the better of the two CV scores', () => {
  assert.equal(bestFitScore(job({ fitScoreA: 80, fitScoreB: 90 })), 90);
  assert.equal(bestFitScore(job({ fitScoreA: 95, fitScoreB: 40 })), 95);
  assert.equal(bestFitScore(job({ fitScoreA: 0, fitScoreB: 0 })), 0);
});

test('formatDate handles empty, unparseable and valid dates', () => {
  assert.equal(formatDate(''), 'Posting date unavailable');
  assert.equal(formatDate('not-a-date'), 'Posted not-a-date');
  assert.equal(formatDate('2026-08-25T00:00:00.000Z'), 'Posted 25 Aug 2026');
  assert.ok(formatDate('2026-01-05T12:00:00.000Z').startsWith('Posted '));
});

test('sortJobs orders by fit, posting date, or first sighting', () => {
  const old = job({ id: 'old', fitScoreA: 10, fitScoreB: 10, postedAt: '2026-07-01T00:00:00.000Z', firstSeenAt: '2026-07-02T00:00:00.000Z' });
  const mid = job({ id: 'mid', fitScoreA: 50, fitScoreB: 50, postedAt: '2026-08-01T00:00:00.000Z', firstSeenAt: '2026-08-15T00:00:00.000Z' });
  const top = job({ id: 'top', fitScoreA: 99, fitScoreB: 99, postedAt: '2026-08-20T00:00:00.000Z', firstSeenAt: '2026-08-10T00:00:00.000Z' });
  const undated = job({ id: 'undated', fitScoreA: 60, fitScoreB: 60, postedAt: '', firstSeenAt: '' });
  assert.deepEqual(sortJobs([old, mid, top], 'fit').map((entry) => entry.id), ['top', 'mid', 'old']);
  assert.deepEqual(sortJobs([old, mid, top, undated], 'posted').map((entry) => entry.id), ['top', 'mid', 'old', 'undated']);
  assert.deepEqual(sortJobs([old, mid, top, undated], 'found').map((entry) => entry.id), ['mid', 'top', 'old', 'undated']);
  // Undated rows sort after dated ones rather than as string-equal firsts.
  assert.deepEqual(sortJobs([undated, old], 'posted').map((entry) => entry.id), ['old', 'undated']);
  // Ties break on id, so the order never depends on which page a job arrived on.
  const tied = [job({ id: 'b', fitScoreA: 10, fitScoreB: 10 }), job({ id: 'a', fitScoreA: 10, fitScoreB: 10 })];
  assert.deepEqual(sortJobs(tied, 'fit').map((entry) => entry.id), ['a', 'b']);
  // The input is never reordered in place.
  const input = [old, top];
  sortJobs(input, 'fit');
  assert.deepEqual(input.map((entry) => entry.id), ['old', 'top']);
});

function run(overrides: Partial<SearchRun> = {}): SearchRun {
  return {
    id: 'run-1',
    status: 'complete',
    startedAt: '2026-09-19T10:00:00.000Z',
    completedAt: '2026-09-19T10:05:00.000Z',
    sources: [],
    ...overrides,
  };
}

test('newSinceCutoff follows the latest finished run, then the last seven days', () => {
  const runs = [run({ startedAt: '2026-09-19T10:00:00.000Z' }), run({ id: 'run-0', startedAt: '2026-09-10T10:00:00.000Z' })];
  assert.equal(newSinceCutoff(runs, '2026-09-20T00:00:00.000Z'), '2026-09-19T10:00:00.000Z');
  // An unfinished run is not a baseline: the finished one before it decides.
  const running = [run({ id: 'run-2', completedAt: '', startedAt: '2026-09-20T09:00:00.000Z' }), ...runs];
  assert.equal(newSinceCutoff(running, '2026-09-20T12:00:00.000Z'), '2026-09-19T10:00:00.000Z');
  // No finished run yet: seven days back from now, so an imported workspace still has a New view.
  assert.equal(newSinceCutoff([], '2026-09-20T00:00:00.000Z'), '2026-09-13T00:00:00.000Z');
  assert.ok(isNewJob(job({ firstSeenAt: '2026-09-14T00:00:00.000Z' }), '2026-09-13T00:00:00.000Z'));
  assert.ok(!isNewJob(job({ firstSeenAt: '2026-09-12T00:00:00.000Z' }), '2026-09-13T00:00:00.000Z'));
  assert.ok(!isNewJob(job({ firstSeenAt: '' }), '2026-09-13T00:00:00.000Z'));
});

test('jobInView splits the six old tabs into New, All matches, Pipeline, triage and dismissed', () => {
  const cutoff = '2026-09-13T00:00:00.000Z';
  const freshPass = job({ firstSeenAt: '2026-09-14T00:00:00.000Z' });
  const stalePass = job({ id: 'stale', firstSeenAt: '2026-09-01T00:00:00.000Z' });
  const freshReview = job({ id: 'rev', languageStatus: 'review', firstSeenAt: '2026-09-14T00:00:00.000Z' });
  const staleUnknown = job({ id: 'unk', languageStatus: 'unknown', firstSeenAt: '2026-09-01T00:00:00.000Z' });
  const blocked = job({ id: 'blo', languageStatus: 'blocked', firstSeenAt: '2026-09-14T00:00:00.000Z' });
  // New is the arrivals inbox across every triage-worthy verdict, never blocked rows.
  assert.ok(jobInView(freshPass, 'new', cutoff));
  assert.ok(jobInView(freshReview, 'new', cutoff));
  assert.ok(!jobInView(stalePass, 'new', cutoff));
  assert.ok(!jobInView(blocked, 'new', cutoff));
  // All matches is English-confirmed only: the old everything-mixed `all` is gone with it.
  assert.ok(jobInView(freshPass, 'all', cutoff));
  assert.ok(jobInView(stalePass, 'all', cutoff));
  assert.ok(!jobInView(freshReview, 'all', cutoff));
  assert.ok(!jobInView(staleUnknown, 'all', cutoff));
  assert.ok(!jobInView(blocked, 'all', cutoff));
  // Triage reunites review and too-short ads, old and new alike.
  assert.ok(jobInView(freshReview, 'triage', cutoff));
  assert.ok(jobInView(staleUnknown, 'triage', cutoff));
  assert.ok(!jobInView(freshPass, 'triage', cutoff));
  // A user correction moves the card with it: the effective verdict decides, not the detector's.
  const corrected = job({ id: 'cor', languageStatus: 'review', languageFeedback: 'incorrect', correctedLanguageStatus: 'pass' });
  assert.ok(jobInView(corrected, 'all', cutoff));
  assert.ok(!jobInView(corrected, 'triage', cutoff));
  // Non-matching rows never browse, but Pipeline and Dismissed keep their ride-along.
  const excluded = job({ id: 'exc', matchesCriteria: false });
  assert.ok(!jobInView(excluded, 'new', cutoff));
  assert.ok(!jobInView(excluded, 'all', cutoff));
  assert.ok(!jobInView(excluded, 'triage', cutoff));
  const savedExcluded = job({ id: 'sav', matchesCriteria: false, isSaved: true });
  assert.ok(jobInView(savedExcluded, 'pipeline', cutoff));
  const dismissedExcluded = job({ id: 'dis', matchesCriteria: false, visibilityStatus: 'dismissed' });
  assert.ok(jobInView(dismissedExcluded, 'dismissed', cutoff));
  assert.ok(!jobInView(dismissedExcluded, 'pipeline', cutoff));
  // Dismissed rows leave every other view.
  const dismissed = job({ id: 'd2', visibilityStatus: 'dismissed' });
  assert.ok(!jobInView(dismissed, 'all', cutoff));
  assert.ok(!jobInView(dismissed, 'new', cutoff));
  // Labels and sort options are pinned for the toolbar.
  assert.deepEqual(DASHBOARD_VIEW_LABELS, {
    new: 'New', all: 'All matches', pipeline: 'Pipeline', triage: 'Needs a look', dismissed: 'Dismissed',
  });
  assert.deepEqual(SORT_MODE_LABELS, { fit: 'Best fit', posted: 'Newest posted', found: 'Recently found' });
});

test('activeFilterPills lists saved keywords before facets, and only what is on', () => {
  const none = activeFilterPills({
    country: 'all', city: 'all', source: 'all', sourceName: '', workType: 'all', application: 'all',
    requiredKeywords: [], excludedKeywords: [],
  });
  assert.deepEqual(none, []);
  const pills = activeFilterPills({
    country: 'switzerland', city: 'Zürich', source: 'jobs.ch', sourceName: 'jobs.ch',
    workType: 'remote', application: 'applied', requiredKeywords: ['sap'], excludedKeywords: ['sales', 'internship'],
  });
  assert.deepEqual(pills.map((pill) => pill.key), ['excluded', 'required', 'country', 'city', 'source', 'workType', 'application']);
  assert.ok(pills[0].label.includes('sales'));
  assert.ok(pills[1].label.includes('sap'));
  // Long keyword lists truncate instead of stretching the row.
  const crowded = activeFilterPills({
    country: 'all', city: 'all', source: 'all', sourceName: '', workType: 'all', application: 'all',
    requiredKeywords: [], excludedKeywords: ['a', 'b', 'c', 'd'],
  });
  assert.equal(crowded.length, 1);
  assert.match(crowded[0].label, /\+1 more/);
  assert.doesNotMatch(crowded[0].label, /\bd\b/);
});

test('emptyStateCopy names the culprit instead of shrugging', () => {
  const base = { totalJobs: 100, removedByKeywords: 0, inViewCount: 0, hasExcludedKeywords: false, hasRequiredKeywords: false, hasMorePages: false };
  // A fresh workspace gets first-run guidance, not a culprit.
  assert.equal(emptyStateCopy('all', { ...base, totalJobs: 0 }).title, 'No jobs yet');
  // Facets hide what is already here.
  assert.equal(emptyStateCopy('all', { ...base, inViewCount: 4 }).title, 'No jobs match these filters');
  // The issue's example: excluded keywords, with the server-exact count.
  const excluded = emptyStateCopy('all', { ...base, removedByKeywords: 41, hasExcludedKeywords: true });
  assert.equal(excluded.title, 'No jobs match');
  assert.match(excluded.detail, /41 were removed by your excluded keywords/);
  const singular = emptyStateCopy('all', { ...base, removedByKeywords: 1, hasRequiredKeywords: true });
  assert.match(singular.detail, /1 was removed by your required keywords/);
  // Unloaded pages come before any culprit: nothing honest can be claimed yet.
  const paging = emptyStateCopy('new', { ...base, removedByKeywords: 41, hasExcludedKeywords: true, hasMorePages: true });
  assert.match(paging.detail, /still loading/);
  // Otherwise each view gets its own quiet line.
  assert.equal(emptyStateCopy('new', base).title, 'Nothing new since the last search');
  assert.equal(emptyStateCopy('triage', base).title, 'Nothing needs a look');
  assert.equal(emptyStateCopy('dismissed', base).title, 'Nothing dismissed');
  assert.equal(emptyStateCopy('pipeline', base).title, 'Pipeline is empty');
});

test('workspaceCountCopy never calls shown rows matching when they are folded duplicates', () => {
  // The issue's case: no keywords set, so matching equals total and the 25-gap is folding.
  const folded = workspaceCountCopy({ shown: 306, matching: 331, total: 331, hiddenDuplicates: 25, hasMorePages: false });
  assert.equal(folded, '306 jobs · 25 duplicates folded · 331 analyzed');
  assert.doesNotMatch(folded, /matching/);
  // With criteria set both effects are live, so the line distinguishes shown from matching.
  assert.equal(
    workspaceCountCopy({ shown: 222, matching: 237, total: 331, hiddenDuplicates: 15, hasMorePages: false }),
    '222 shown · 237 matching · 331 analyzed',
  );
  // Nothing filtered, nothing folded: a single quiet number.
  assert.equal(
    workspaceCountCopy({ shown: 5, matching: 5, total: 5, hiddenDuplicates: 0, hasMorePages: false }),
    '5 analyzed',
  );
  // Singular forms read as written.
  assert.equal(
    workspaceCountCopy({ shown: 1, matching: 2, total: 2, hiddenDuplicates: 1, hasMorePages: false }),
    '1 job · 1 duplicate folded · 2 analyzed',
  );
  // While pages remain, shown is partial and matching is the server-exact total to converge to.
  assert.equal(
    workspaceCountCopy({ shown: 200, matching: 331, total: 331, hiddenDuplicates: 10, hasMorePages: true }),
    'Showing 200 of 331 matching — more below',
  );
});

test('criteriaToDraft round-trips every SearchCriteria field', () => {
  const criteria: SearchCriteria = {
    ...defaultSearchCriteria,
    roleOverrideA: 'Data Governance',
    roleOverrideB: 'Supply Chain',
    roleKeywords: ['Master Data', 'Supply Chain'],
    location: 'Zürich',
    workplace: 'hybrid',
    seniority: 'senior',
    contractType: 'permanent',
    requiredKeywords: ['sap', 'power bi'],
    excludedKeywords: ['sales', 'internship'],
    searchNetherlands: false,
    searchSwitzerland: true,
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
  const draft = criteriaToDraft(criteria);
  assert.equal(draft.roleOverrideA, 'Data Governance');
  assert.equal(draft.roleOverrideB, 'Supply Chain');
  assert.deepEqual(draft.roleKeywords, ['Master Data', 'Supply Chain']);
  assert.equal(draft.location, 'Zürich');
  assert.equal(draft.workplace, 'hybrid');
  assert.equal(draft.seniority, 'senior');
  assert.equal(draft.contractType, 'permanent');
  assert.equal(draft.requiredKeywords, 'sap, power bi');
  assert.equal(draft.excludedKeywords, 'sales, internship');
  assert.equal(draft.searchNetherlands, false);
  assert.equal(draft.searchSwitzerland, true);
  // updatedAt is form state, not draft state, so it must not travel along.
  assert.ok(!('updatedAt' in draft));
  // The keyword list is copied, so editing the draft never mutates the saved criteria.
  draft.roleKeywords.push('Extra');
  assert.deepEqual(criteria.roleKeywords, ['Master Data', 'Supply Chain']);
});
