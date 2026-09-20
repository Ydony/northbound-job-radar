import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSearchCriteria } from '../lib/criteria';
import { SOURCE_RUN_STATUS_LABELS, SOURCE_RUN_STATUS_RANK, bestFitScore, criteriaToDraft, formatDate,
  languageStatusLabel, sourceRunStatusLabel, statusLabel } from '../lib/dashboard';
import type { JobRecord, SearchCriteria, SourceRunStatus } from '../lib/types';
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
