import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSearchCriteria, matchesSearchCriteria, parseKeywordInput, roleForSlot } from '../lib/criteria';
import type { JobRecord, SearchCriteria } from '../lib/types';

const job: JobRecord = {
  id: 'job-1',
  sourceUrl: 'https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000/',
  title: 'Senior Data Governance Analyst',
  company: 'Example AG',
  location: 'Zürich 8000',
  description: 'Permanent hybrid role using SAP, SQL and Power BI. English is the working language.',
  languageStatus: 'pass',
  languageSummary: 'English sufficient.',
  languageSignals: [],
  fitScoreA: 80,
  fitScoreB: 90,
  bestCvSlot: 'b',
  matchedKeywords: ['sql'],
  missingKeywords: [],
  status: 'new',
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

test('applies accent-insensitive location plus required and excluded keywords', () => {
  assert.equal(matchesSearchCriteria(job, criteria({ location: 'Zurich', requiredKeywords: ['sap', 'power bi'] })), true);
  assert.equal(matchesSearchCriteria(job, criteria({ requiredKeywords: ['python'] })), false);
  assert.equal(matchesSearchCriteria(job, criteria({ excludedKeywords: ['power bi'] })), false);
  assert.equal(matchesSearchCriteria(job, criteria({ location: 'Geneva' })), false);
});

test('applies workplace, seniority and contract filters', () => {
  assert.equal(matchesSearchCriteria(job, criteria({ workplace: 'hybrid', seniority: 'senior', contractType: 'permanent' })), true);
  assert.equal(matchesSearchCriteria(job, criteria({ workplace: 'onsite' })), false);
  assert.equal(matchesSearchCriteria(job, criteria({ seniority: 'entry' })), false);
  assert.equal(matchesSearchCriteria(job, criteria({ contractType: 'temporary' })), false);
});
