import assert from 'node:assert/strict';
import test from 'node:test';
import { jobsToCsv, workspaceToJson } from '../lib/export';
import { defaultSearchCriteria } from '../lib/criteria';
import type { JobRecord } from '../lib/types';

const job: JobRecord = {
  id: 'job-1',
  workplaceType: 'unknown',
  sourceUrl: 'https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000/',
  canonicalUrl: 'https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000',
  sourceKey: 'jobs.ch',
  sourceName: 'jobs.ch',
  sourceJobId: '00000000-0000-0000-0000-000000000000',
  country: 'switzerland',
  title: 'Data Analyst, Governance',
  company: 'Example "AG"',
  location: 'Zürich',
  description: 'Full advertisement text.',
  languageStatus: 'review',
  languageSummary: 'German is mentioned.',
  languageSignals: ['Unclear mention: German'],
  languageFeedback: 'incorrect',
  correctedLanguageStatus: 'pass',
  languageFeedbackReason: 'German is optional.',
  languageFeedbackUpdatedAt: '2026-08-26T00:00:00.000Z',
  fitScoreA: 65,
  fitScoreB: 72,
  bestCvSlot: 'b',
  matchedKeywords: ['sap', 'data governance'],
  missingKeywords: ['python'],
  identityFingerprint: 'job-v1-example',
  isSaved: true,
  applicationStatus: 'not_applied',
  visibilityStatus: 'active',
  postedAt: '2026-08-25T00:00:00.000Z',
  firstSeenAt: '2026-08-26T00:00:00.000Z',
  lastSeenAt: '2026-08-26T00:00:00.000Z',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
};

test('exports corrected language status and safely quotes CSV values', () => {
  const csv = jobsToCsv([job]);
  assert.match(csv, /"effectiveLanguageStatus"/);
  assert.match(csv, /"pass","review"/);
  assert.match(csv, /"Data Analyst, Governance"/);
  assert.match(csv, /"Example ""AG"""/);
});

test('exports workspace metadata without hidden CV text or object keys', () => {
  const json = workspaceToJson({
    profiles: [{ slot: 'a', cvFileName: 'cv.pdf', hasCvText: true, derivedRole: 'Data Analyst', updatedAt: 'now' }],
    criteria: defaultSearchCriteria,
    jobs: [job],
    searchRuns: [],
  }, '2026-08-26T12:00:00.000Z');
  const parsed = JSON.parse(json);
  assert.equal(parsed.exportedAt, '2026-08-26T12:00:00.000Z');
  assert.equal(parsed.jobs[0].effectiveLanguageStatus, 'pass');
  assert.equal('cvText' in parsed.profiles[0], false);
  assert.equal('objectKey' in parsed.profiles[0], false);
});
