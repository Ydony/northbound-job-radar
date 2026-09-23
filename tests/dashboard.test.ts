import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSearchCriteria } from '../lib/criteria';
import { SOURCE_RUN_STATUS_LABELS, SOURCE_RUN_STATUS_RANK, activeFilterPills, bestFitScore, closesToday,
  criteriaToDraft, DASHBOARD_VIEW_LABELS, emptyStateCopy, formatCountOrUnknown, formatDate, formatSourceReconciliation,
  isJobExpired, isNewJob, jobInView, jobMatchesLanguage, LANGUAGE_FILTER_LABELS, languageStatusLabel,
  MATCHED_SNAPSHOT_NOTE, missingIndeedDashRows, newSinceCutoff, RUN_TOTALS_HELP, runNewMatchedTotals, SORT_MODE_LABELS, sortJobs,
  sourceRunStatusLabel, sourceRunTotals, statusLabel, TOTALS_DEDUPE_NOTE, totalForSource,
  workspaceCountCopy } from '../lib/dashboard';
import type { LanguageFilter } from '../lib/dashboard';
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
    expiresAt: '',
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

test('formatSourceReconciliation accounts every new listing as an equation', () => {
  // The measured run from #94, which read as 28 lost jobs when the duplicate
  // share was omitted: new = imported + duplicate + skipped holds exactly.
  const cases = [
    { newCount: 150, importedCount: 126, duplicateCount: 24, skippedCount: 0,
      text: '150 new = 126 added + 24 duplicates + 0 skipped' },
    { newCount: 100, importedCount: 99, duplicateCount: 1, skippedCount: 0,
      text: '100 new = 99 added + 1 duplicate + 0 skipped' },
    { newCount: 31, importedCount: 28, duplicateCount: 3, skippedCount: 0,
      text: '31 new = 28 added + 3 duplicates + 0 skipped' },
  ];
  for (const { text, ...counts } of cases) {
    assert.equal(counts.newCount, counts.importedCount + counts.duplicateCount + counts.skippedCount);
    assert.equal(formatSourceReconciliation(counts), text);
  }
  // An unsearched source still reconciles, trivially.
  assert.equal(
    formatSourceReconciliation({ newCount: 0, importedCount: 0, duplicateCount: 0, skippedCount: 0 }),
    '0 new = 0 added + 0 duplicates + 0 skipped',
  );
});

test('sourceRunTotals sums the two live card numbers across one run', () => {
  // UX-6e: Searched is what each source returned (foundCount) and Added is what
  // survived the filters (importedCount). Diagnostics — known, duplicates,
  // skipped — never enter these totals.
  assert.deepEqual(sourceRunTotals([
    { foundCount: 150, importedCount: 126 },
    { foundCount: 100, importedCount: 99 },
    { foundCount: 0, importedCount: 0 },
  ]), { searched: 250, added: 225 });
  assert.deepEqual(sourceRunTotals([]), { searched: 0, added: 0 });
});

test('languageStatusLabel uses the canvas words, never a near-miss', () => {
  assert.equal(languageStatusLabel('pass'), 'Definitely English');
  // The ad was too short to judge, which is different from looking acceptable;
  // the old wording claimed the latter.
  assert.equal(languageStatusLabel('unknown'), 'Not sure');
  assert.doesNotMatch(languageStatusLabel('unknown'), /almost|near|likely|promising/i);
  assert.equal(languageStatusLabel('review'), 'Maybe English');
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

test('sortJobs orders by posting date or first sighting; there is no fit order', () => {
  const old = job({ id: 'old', fitScoreA: 10, fitScoreB: 10, postedAt: '2026-07-01T00:00:00.000Z', firstSeenAt: '2026-07-02T00:00:00.000Z' });
  const mid = job({ id: 'mid', fitScoreA: 50, fitScoreB: 50, postedAt: '2026-08-01T00:00:00.000Z', firstSeenAt: '2026-08-15T00:00:00.000Z' });
  const top = job({ id: 'top', fitScoreA: 99, fitScoreB: 99, postedAt: '2026-08-20T00:00:00.000Z', firstSeenAt: '2026-08-10T00:00:00.000Z' });
  const undated = job({ id: 'undated', fitScoreA: 60, fitScoreB: 60, postedAt: '', firstSeenAt: '' });
  // Fit scores exist on the rows but CV matching is shelved, so no order may
  // use them — the control must not promise what the product does not do.
  assert.deepEqual(sortJobs([old, mid, top, undated], 'posted').map((entry) => entry.id), ['top', 'mid', 'old', 'undated']);
  assert.deepEqual(sortJobs([old, mid, top, undated], 'found').map((entry) => entry.id), ['mid', 'top', 'old', 'undated']);
  // Undated rows sort after dated ones rather than as string-equal firsts.
  assert.deepEqual(sortJobs([undated, old], 'posted').map((entry) => entry.id), ['old', 'undated']);
  // Ties break on id, so the order never depends on which page a job arrived on.
  const tied = [job({ id: 'b', fitScoreA: 10, fitScoreB: 10 }), job({ id: 'a', fitScoreA: 10, fitScoreB: 10 })];
  assert.deepEqual(sortJobs(tied, 'found').map((entry) => entry.id), ['a', 'b']);
  // The input is never reordered in place.
  const input = [old, top];
  sortJobs(input, 'found');
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

test('jobInView separates language from lifecycle: every verdict individually reachable (#119)', () => {
  const cutoff = '2026-09-13T00:00:00.000Z';
  const freshPass = job({ firstSeenAt: '2026-09-14T00:00:00.000Z' });
  const stalePass = job({ id: 'stale', firstSeenAt: '2026-09-01T00:00:00.000Z' });
  const freshReview = job({ id: 'rev', languageStatus: 'review', firstSeenAt: '2026-09-14T00:00:00.000Z' });
  const staleUnknown = job({ id: 'unk', languageStatus: 'unknown', firstSeenAt: '2026-09-01T00:00:00.000Z' });
  const freshBlocked = job({ id: 'blo', languageStatus: 'blocked', firstSeenAt: '2026-09-14T00:00:00.000Z' });
  const staleBlocked = job({ id: 'blo-old', languageStatus: 'blocked', firstSeenAt: '2026-09-01T00:00:00.000Z' });
  // Each singleton reaches exactly its verdict, old and new alike.
  assert.ok(jobInView(freshPass, 'all', cutoff, 'pass'));
  assert.ok(jobInView(stalePass, 'all', cutoff, 'pass'));
  assert.ok(!jobInView(freshReview, 'all', cutoff, 'pass'));
  assert.ok(!jobInView(staleUnknown, 'all', cutoff, 'pass'));
  assert.ok(!jobInView(freshBlocked, 'all', cutoff, 'pass'));
  assert.ok(jobInView(freshReview, 'all', cutoff, 'review'));
  assert.ok(!jobInView(freshPass, 'all', cutoff, 'review'));
  assert.ok(jobInView(staleUnknown, 'all', cutoff, 'unknown'));
  assert.ok(!jobInView(freshPass, 'all', cutoff, 'unknown'));
  assert.ok(jobInView(freshBlocked, 'all', cutoff, 'blocked'));
  assert.ok(jobInView(staleBlocked, 'all', cutoff, 'blocked'));
  assert.ok(!jobInView(freshPass, 'all', cutoff, 'blocked'));
  assert.ok(!jobInView(freshReview, 'all', cutoff, 'blocked'));
  // All language results reaches every verdict including blocked: the restored
  // browsing path ordinary active blocked ads lost in #46.
  for (const fixture of [freshPass, stalePass, freshReview, staleUnknown, freshBlocked, staleBlocked]) {
    assert.ok(jobInView(fixture, 'all', cutoff, 'all'), `${fixture.id} browses under All language results`);
  }
  // New means first discovered, not language approval: it composes with the
  // choice, so New narrows to confirmed-only under Definitely English.
  assert.ok(jobInView(freshPass, 'new', cutoff, 'pass'));
  assert.ok(!jobInView(stalePass, 'new', cutoff, 'pass'));
  assert.ok(jobInView(freshReview, 'new', cutoff, 'review'));
  assert.ok(!jobInView(staleUnknown, 'new', cutoff, 'review'));
  assert.ok(jobInView(freshBlocked, 'new', cutoff, 'blocked'));
  assert.ok(!jobInView(staleBlocked, 'new', cutoff, 'blocked'));
  assert.ok(jobInView(freshBlocked, 'new', cutoff, 'all'));
  assert.ok(!jobInView(freshPass, 'new', cutoff, 'review'));
  // Blocked rows never leak into singletons that did not ask for them.
  assert.ok(!jobInView(freshBlocked, 'new', cutoff, 'pass'));
  assert.ok(!jobInView(freshBlocked, 'all', cutoff, 'review'));
  assert.ok(!jobInView(freshBlocked, 'all', cutoff, 'unknown'));
  // A user correction moves the card with it: the effective verdict decides.
  const correctedToPass = job({ id: 'cor', languageStatus: 'review', languageFeedback: 'incorrect', correctedLanguageStatus: 'pass' });
  assert.ok(jobInView(correctedToPass, 'all', cutoff, 'pass'));
  assert.ok(!jobInView(correctedToPass, 'all', cutoff, 'review'));
  assert.ok(jobMatchesLanguage(correctedToPass, 'pass'));
  assert.ok(!jobMatchesLanguage(correctedToPass, 'review'));
  const correctedToBlocked = job({ id: 'cor-b', languageStatus: 'pass', languageFeedback: 'incorrect', correctedLanguageStatus: 'blocked' });
  assert.ok(jobInView(correctedToBlocked, 'all', cutoff, 'blocked'));
  assert.ok(jobInView(correctedToBlocked, 'all', cutoff, 'all'));
  assert.ok(!jobInView(correctedToBlocked, 'all', cutoff, 'pass'));
  // Non-matching rows never browse under New/All, but Pipeline and Dismissed
  // keep their ride-along across every language choice.
  const excluded = job({ id: 'exc', matchesCriteria: false });
  for (const language of ['pass', 'review', 'unknown', 'blocked', 'all'] as LanguageFilter[]) {
    assert.ok(!jobInView(excluded, 'new', cutoff, language));
    assert.ok(!jobInView(excluded, 'all', cutoff, language));
  }
  const savedExcluded = job({ id: 'sav', matchesCriteria: false, isSaved: true });
  const appliedBlocked = job({ id: 'app-b', languageStatus: 'blocked', applicationStatus: 'applied' });
  for (const language of ['pass', 'review', 'unknown', 'blocked', 'all'] as LanguageFilter[]) {
    assert.ok(jobInView(savedExcluded, 'pipeline', cutoff, language), `saved rides along under ${language}`);
    assert.ok(jobInView(appliedBlocked, 'pipeline', cutoff, language), `applied blocked rides along under ${language}`);
  }
  const dismissedExcluded = job({ id: 'dis', matchesCriteria: false, visibilityStatus: 'dismissed' });
  for (const language of ['pass', 'review', 'unknown', 'blocked', 'all'] as LanguageFilter[]) {
    assert.ok(jobInView(dismissedExcluded, 'dismissed', cutoff, language));
  }
  assert.ok(!jobInView(dismissedExcluded, 'pipeline', cutoff, 'all'));
  // Dismissed rows leave every other view under every language choice.
  const dismissed = job({ id: 'd2', visibilityStatus: 'dismissed' });
  for (const language of ['pass', 'review', 'unknown', 'blocked', 'all'] as LanguageFilter[]) {
    assert.ok(!jobInView(dismissed, 'all', cutoff, language));
    assert.ok(!jobInView(dismissed, 'new', cutoff, language));
  }
  // Private page-fetching rows filter exactly like public ones: the audience
  // gate lives server-side, never in this predicate.
  const privateBlocked = job({ id: 'priv', sourceKey: 'jobs.ch', sourceName: 'jobs.ch', languageStatus: 'blocked' });
  assert.ok(jobInView(privateBlocked, 'all', cutoff, 'blocked'));
  assert.ok(jobInView(privateBlocked, 'all', cutoff, 'all'));
  assert.ok(!jobInView(privateBlocked, 'all', cutoff, 'pass'));
  // Labels are pinned for the toolbar: lifecycle separate from language.
  assert.deepEqual(DASHBOARD_VIEW_LABELS, {
    new: 'New', all: 'All', pipeline: 'Pipeline', dismissed: 'Dismissed',
  });
  assert.deepEqual(LANGUAGE_FILTER_LABELS, {
    pass: 'Definitely English', review: 'Maybe English', unknown: 'Not sure',
    blocked: 'Local language required', all: 'All language results',
  });
  assert.deepEqual(SORT_MODE_LABELS, { posted: 'Newest posted', found: 'Recently found' });
});

test('jobMatchesLanguage follows the effective verdict, never promoting blocked', () => {
  assert.ok(jobMatchesLanguage(job({ languageStatus: 'pass' }), 'pass'));
  assert.ok(jobMatchesLanguage(job({ languageStatus: 'review' }), 'review'));
  assert.ok(jobMatchesLanguage(job({ languageStatus: 'unknown' }), 'unknown'));
  assert.ok(jobMatchesLanguage(job({ languageStatus: 'blocked' }), 'blocked'));
  assert.ok(!jobMatchesLanguage(job({ languageStatus: 'blocked' }), 'pass'));
  assert.ok(!jobMatchesLanguage(job({ languageStatus: 'pass' }), 'blocked'));
  for (const status of ['pass', 'review', 'unknown', 'blocked'] as const) {
    assert.ok(jobMatchesLanguage(job({ languageStatus: status }), 'all'));
  }
});

test('activeFilterPills lists saved keywords and language before facets, and only what is on', () => {
  const none = activeFilterPills({
    country: 'all', city: 'all', source: 'all', sourceName: '', workType: 'all', application: 'all',
    language: 'all', requiredKeywords: [], excludedKeywords: [],
  });
  assert.deepEqual(none, []);
  // The default arrival (Definitely English) is a constraint, so it shows a pill.
  const englishOnly = activeFilterPills({
    country: 'all', city: 'all', source: 'all', sourceName: '', workType: 'all', application: 'all',
    language: 'pass', requiredKeywords: [], excludedKeywords: [],
  });
  assert.deepEqual(englishOnly.map((pill) => pill.key), ['language']);
  assert.equal(englishOnly[0].label, 'Definitely English');
  const pills = activeFilterPills({
    country: 'switzerland', city: 'Zürich', source: 'jobs.ch', sourceName: 'jobs.ch',
    workType: 'remote', application: 'applied', language: 'blocked',
    requiredKeywords: ['sap'], excludedKeywords: ['sales', 'internship'],
  });
  assert.deepEqual(pills.map((pill) => pill.key),
    ['excluded', 'required', 'language', 'country', 'city', 'source', 'workType', 'application']);
  assert.ok(pills[0].label.includes('sales'));
  assert.ok(pills[1].label.includes('sap'));
  assert.equal(pills[2].label, 'Local language required');
  // Long keyword lists truncate instead of stretching the row.
  const crowded = activeFilterPills({
    country: 'all', city: 'all', source: 'all', sourceName: '', workType: 'all', application: 'all',
    language: 'all', requiredKeywords: [], excludedKeywords: ['a', 'b', 'c', 'd'],
  });
  assert.equal(crowded.length, 1);
  assert.match(crowded[0].label, /\+1 more/);
  assert.doesNotMatch(crowded[0].label, /\bd\b/);
});

test('emptyStateCopy names the culprit instead of shrugging, per view and language', () => {
  const base = { totalJobs: 100, removedByKeywords: 0, inViewCount: 0, hasExcludedKeywords: false, hasRequiredKeywords: false, hasMorePages: false };
  // A fresh workspace gets first-run guidance, not a culprit.
  assert.equal(emptyStateCopy('all', 'pass', { ...base, totalJobs: 0 }).title, 'No jobs yet');
  // Facets hide what is already here.
  assert.equal(emptyStateCopy('all', 'pass', { ...base, inViewCount: 4 }).title, 'No jobs match these filters');
  // The issue's example: excluded keywords, with the server-exact count.
  const excluded = emptyStateCopy('all', 'pass', { ...base, removedByKeywords: 41, hasExcludedKeywords: true });
  assert.equal(excluded.title, 'No jobs match');
  assert.match(excluded.detail, /41 were removed by your excluded keywords/);
  const singular = emptyStateCopy('all', 'pass', { ...base, removedByKeywords: 1, hasRequiredKeywords: true });
  assert.match(singular.detail, /1 was removed by your required keywords/);
  // Unloaded pages come before any culprit: nothing honest can be claimed yet.
  const paging = emptyStateCopy('new', 'pass', { ...base, removedByKeywords: 41, hasExcludedKeywords: true, hasMorePages: true });
  assert.match(paging.detail, /still loading/);
  // Each lifecycle-and-language combination gets its own quiet line.
  assert.equal(emptyStateCopy('new', 'all', base).title, 'Nothing new since the last search');
  assert.equal(emptyStateCopy('new', 'pass', base).title, 'Nothing new in Definitely English');
  assert.equal(emptyStateCopy('all', 'pass', base).title, 'No Definitely English jobs yet');
  assert.equal(emptyStateCopy('all', 'review', base).title, 'Nothing needs review');
  assert.equal(emptyStateCopy('all', 'unknown', base).title, 'Nothing is too short to judge');
  assert.equal(emptyStateCopy('all', 'blocked', base).title, 'No local-language jobs in view');
  assert.equal(emptyStateCopy('all', 'all', base).title, 'No jobs in this view yet');
  assert.equal(emptyStateCopy('dismissed', 'blocked', base).title, 'Nothing dismissed');
  assert.equal(emptyStateCopy('pipeline', 'pass', base).title, 'Pipeline is empty');
  // Pipeline and Dismissed never name the language choice: it does not narrow them.
  assert.equal(emptyStateCopy('pipeline', 'blocked', base).title, emptyStateCopy('pipeline', 'all', base).title);
  // No line promises perfect classification.
  for (const view of ['new', 'all', 'pipeline', 'dismissed'] as const) {
    for (const language of ['pass', 'review', 'unknown', 'blocked', 'all'] as LanguageFilter[]) {
      const copy = emptyStateCopy(view, language, base);
      assert.doesNotMatch(`${copy.title} ${copy.detail}`, /100\s?%|perfect|guarantee/i);
    }
  }
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

test('an expired advertisement is marked from its stored end date, without a request', () => {
  // #97: the card derives this from expires_at kept at collection. Empty means the source
  // published no expiry, which is not the same as being expired.
  const today = new Date('2026-09-20T12:00:00.000Z');
  assert.equal(isJobExpired(job({ expiresAt: '' }), today), false);
  assert.equal(isJobExpired(job({ expiresAt: '2026-10-01' }), today), false);
  assert.equal(isJobExpired(job({ expiresAt: '2026-09-20' }), today), false,
    'the end date is inclusive: the advertisement is still open on the day it closes');
  assert.equal(isJobExpired(job({ expiresAt: '2026-09-19' }), today), true);
  assert.equal(isJobExpired(job({ expiresAt: '2026-08-15' }), today), true);
});

test('an advertisement closing today warns rather than reading as expired', () => {
  const today = new Date('2026-09-20T12:00:00.000Z');
  assert.equal(closesToday(job({ expiresAt: '2026-09-20' }), today), true);
  assert.equal(closesToday(job({ expiresAt: '2026-09-19' }), today), false);
  assert.equal(closesToday(job({ expiresAt: '2026-10-01' }), today), false);
  assert.equal(closesToday(job({ expiresAt: '' }), today), false);
});

test('expiry never moves a job between views', () => {
  // Marking beats hiding (#97): the person may have applied, so an expired row stays where
  // it is and only gains a chip. The cutoff below predates the fixture's first sighting.
  const cutoff = '2026-08-01T00:00:00.000Z';
  assert.equal(jobInView(job({ expiresAt: '2026-08-15' }), 'all', cutoff, 'pass'), true);
  assert.equal(jobInView(job({ expiresAt: '2026-08-15' }), 'new', cutoff, 'pass'), true);
});

test('runNewMatchedTotals counts unique new additions and snapshot matches, never raw rows (#124)', () => {
  // New is first-time unique additions (importedCount), not provider-returned
  // rows (foundCount/newCount) and not a sum across runs. Matched is the
  // search-time snapshot, never guessed from importedCount.
  const totals = runNewMatchedTotals([
    { status: 'complete', importedCount: 3, matchedCount: 2 },
    { status: 'complete', importedCount: 2, matchedCount: 1 },
  ]);
  assert.deepEqual(totals, { newJobs: 5, matchedJobs: 3, matchedUnknown: false });
  // A repeated duplicate-only run adds nothing new and matches nothing new.
  assert.deepEqual(runNewMatchedTotals([
    { status: 'complete', importedCount: 0, matchedCount: 0 },
  ]), { newJobs: 0, matchedJobs: 0, matchedUnknown: false });
  // Skipped and disabled sources were never contacted: they contribute neither
  // new nor unknown.
  assert.deepEqual(runNewMatchedTotals([
    { status: 'complete', importedCount: 2, matchedCount: 1 },
    { status: 'skipped', importedCount: 0, matchedCount: null },
    { status: 'disabled', importedCount: 0, matchedCount: null },
  ]), { newJobs: 2, matchedJobs: 1, matchedUnknown: false });
});

test('runNewMatchedTotals marks matched unknown rather than a false zero (#124)', () => {
  // Pre-#124 rows carry no matched number; failed/blocked/unavailable sources
  // never completed. All render as unknown, never as zero.
  assert.equal(runNewMatchedTotals([
    { status: 'complete', importedCount: 2, matchedCount: null },
  ]).matchedUnknown, true);
  for (const status of ['failed', 'blocked', 'unavailable'] as const) {
    const totals = runNewMatchedTotals([{ status, importedCount: 0, matchedCount: null }]);
    assert.equal(totals.matchedUnknown, true, `${status} must leave matched unknown`);
    assert.equal(totals.matchedJobs, 0);
  }
  // Partial keeps what was measured and still flags the gap.
  const partial = runNewMatchedTotals([
    { status: 'partial', importedCount: 2, matchedCount: 1 },
    { status: 'failed', importedCount: 0, matchedCount: null },
  ]);
  assert.equal(partial.newJobs, 2);
  assert.equal(partial.matchedJobs, 1);
  assert.equal(partial.matchedUnknown, true);
  assert.equal(formatCountOrUnknown(null), '—');
  assert.equal(formatCountOrUnknown(0), '0');
  assert.equal(formatCountOrUnknown(4), '4');
});

test('totalForSource attributes retained jobs to their first-keeping source (#124)', () => {
  const bySource = [
    { sourceKey: 'eures-ch', total: 10 },
    { sourceKey: 'jobs.ch', total: 3 },
  ];
  assert.equal(totalForSource(bySource, 'eures-ch'), 10);
  assert.equal(totalForSource(bySource, 'jobs.ch'), 3);
  assert.equal(totalForSource(bySource, 'unknown-key'), 0);
  // Help copy defines the contract in the UI, not just in code: new and
  // matched are run snapshots, total is retained, overall deduplicates.
  assert.match(RUN_TOTALS_HELP, /New this search/i);
  assert.match(RUN_TOTALS_HELP, /Matched this search/i);
  assert.match(RUN_TOTALS_HELP, /Total collected/i);
  assert.match(MATCHED_SNAPSHOT_NOTE, /snapshot/i);
  assert.match(TOTALS_DEDUPE_NOTE, /once/i);
});

test('per-source unique totals add up to the deduplicated overall (#124 fix)', () => {
  // The counting contract: each counted job belongs to exactly one shown
  // source (primaries under their own source, orphan copies under the copy's
  // source); folded copies count only at their visible primary, never again.
  // The explainer must say the per-source numbers add up — never that they
  // can exceed the overall, which described a contract the query never had.
  assert.match(TOTALS_DEDUPE_NOTE, /add up to the overall/i);
  assert.doesNotMatch(TOTALS_DEDUPE_NOTE, /more than the overall/i);
  const bySource = [
    { sourceKey: 'eures-ch', total: 4 },
    { sourceKey: 'jobs.ch', total: 1 },
  ];
  const overall = bySource.reduce((sum, entry) => sum + entry.total, 0);
  assert.equal(overall, 5);
  assert.equal(totalForSource(bySource, 'eures-ch'), 4);
  assert.equal(totalForSource(bySource, 'jobs.ch'), 1);
});

test('admin preview shows Indeed dash rows only when the run lacks them; ordinary never', () => {
  const pub = [{ sourceKey: 'eures-ch' }, { sourceKey: 'job-room' }];
  // Ordinary accounts get nothing: the server withholds Indeed rows before
  // aggregation, so there must be no trace of a fourth source to disclose.
  assert.deepEqual(missingIndeedDashRows(pub, false), []);
  assert.deepEqual(missingIndeedDashRows([...pub, { sourceKey: 'indeed-nl' }], false), []);
  // Administrators see both Indeed sources as dashes until they have run.
  const dash = missingIndeedDashRows(pub, true);
  assert.deepEqual(dash.map((row) => row.sourceKey), ['indeed-ch', 'indeed-nl']);
  assert.deepEqual(dash.map((row) => row.sourceName), ['Indeed Switzerland', 'Indeed Netherlands']);
  // A source that ran is never duplicated by a dash row.
  assert.deepEqual(missingIndeedDashRows([...pub, { sourceKey: 'indeed-nl' }], true).map((row) => row.sourceKey), ['indeed-ch']);
  assert.deepEqual(missingIndeedDashRows([...pub, { sourceKey: 'indeed-ch' }, { sourceKey: 'indeed-nl' }], true), []);
});
