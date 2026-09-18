import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSearchCriteria, matchesSearchCriteria, normalizeRoleKeywords, parseKeywordInput, roleForSlot,
  searchTermsForProfiles } from '../lib/criteria';
import type { JobRecord, SearchCriteria } from '../lib/types';

// matchesSearchCriteria takes the fields it reads rather than a JobRecord, because the record no
// longer carries the advertisement text — it is screened server-side and never sent to a client.
// This is the shape the server passes it, straight from the stored row.
const matchable = {
  title: 'Senior Data Governance Analyst',
  location: 'Zürich 8000',
  description: 'Permanent hybrid role using SAP, SQL and Power BI. English is the working language.',
};

const job: JobRecord = {
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
};

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return { ...defaultSearchCriteria, ...overrides };
}

test('normalizes, deduplicates and caps comma-separated keyword input', () => {
  assert.deepEqual(parseKeywordInput(' SAP, sql, SAP, , Power BI '), ['sap', 'sql', 'power bi']);
  assert.equal(parseKeywordInput(Array.from({ length: 25 }, (_, index) => `k${index}`).join(',')).length, 20);
});

test('uses a role override only for its matching CV slot', () => {
  const configured = criteria({ roleOverrideA: 'Supply Chain Analyst', roleOverrideB: 'Data Governance Analyst' });
  assert.equal(roleForSlot('a', 'Data Analyst', configured), 'Supply Chain Analyst');
  assert.equal(roleForSlot('b', 'Business Analyst', configured), 'Data Governance Analyst');
  assert.equal(roleForSlot('a', 'Data Analyst', criteria()), 'Data Analyst');
});

test('stores five distinct role keywords and combines them with CV roles', () => {
  assert.deepEqual(normalizeRoleKeywords([' Master Data ', 'Supply Chain', 'master data', '', 'Data Quality', 'SAP', 'Analytics', 'Extra']),
    ['Master Data', 'Supply Chain', 'Data Quality', 'SAP', 'Analytics']);
  const configured = criteria({ roleOverrideA: 'Data Governance', roleKeywords: ['Master Data', 'Supply Chain'] });
  assert.deepEqual(searchTermsForProfiles([
    { slot: 'a', derivedRole: 'Data Analyst' },
    { slot: 'b', derivedRole: 'Business Analyst' },
  ], configured), ['Data Governance', 'Business Analyst', 'Master Data', 'Supply Chain']);
});

test('applies required and excluded keywords, accent-insensitively', () => {
  assert.equal(matchesSearchCriteria(matchable, criteria({ requiredKeywords: ['sap', 'power bi'] })), true);
  assert.equal(matchesSearchCriteria(matchable, criteria({ requiredKeywords: ['python'] })), false);
  assert.equal(matchesSearchCriteria(matchable, criteria({ excludedKeywords: ['power bi'] })), false);
  // Matched against title, location and description together, with accents folded.
  assert.equal(matchesSearchCriteria(matchable, criteria({ requiredKeywords: ['zurich'] })), true);
});

test('no longer filters on location, workplace, seniority or contract type', () => {
  // All four were removed: each asked someone to guess in advance at something they can see in the
  // results, and every one of them silently hid jobs. Location is a facet beside the results now.
  // The criteria columns still exist in the database and are simply not read, so a stored value
  // from before the change must not quietly keep filtering.
  assert.equal(matchesSearchCriteria(matchable, criteria({ location: 'Geneva' })), true);
  assert.equal(matchesSearchCriteria(matchable, criteria({ workplace: 'onsite' })), true);
  assert.equal(matchesSearchCriteria(matchable, criteria({ seniority: 'entry' })), true);
  assert.equal(matchesSearchCriteria(matchable, criteria({ contractType: 'temporary' })), true);
});

test('a job record carries our work on the advertisement, never the advertisement', () => {
  // The guard for docs/SOURCE_POLICY.md §1. The employer owns the advertisement text; reading it
  // to screen a job and handing it to a browser are different permissions, and only the first is
  // settled. Everything the interface needs is derived server-side and travels in its place.
  assert.equal('description' in job, false,
    'JobRecord must not carry the employer advertisement text');
  assert.equal(typeof job.descriptionLength, 'number');
  assert.equal(typeof job.matchesCriteria, 'boolean');
  assert.ok('requirements' in job);
});
