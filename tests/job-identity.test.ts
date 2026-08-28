import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJobUrl, jobIdentityFingerprint, sourceInfoForUrl, sourceJobIdFromUrl } from '../lib/job-identity';

test('canonicalizes tracking variants to the same job URL', () => {
  const first = canonicalJobUrl('https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000/?utm_source=mail#apply');
  const second = canonicalJobUrl('https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000/');
  assert.equal(first, second);
});

test('derives stable source identity and country', () => {
  assert.equal(sourceJobIdFromUrl('https://www.jobup.ch/en/jobs/detail/11111111-1111-1111-1111-111111111111/'),
    '11111111-1111-1111-1111-111111111111');
  assert.deepEqual(sourceInfoForUrl('https://www.iamexpat.nl/career/jobs-netherlands/example/id'), {
    key: 'iamexpat.nl', name: 'IamExpat', country: 'netherlands',
  });
  assert.deepEqual(sourceInfoForUrl('https://undutchables.nl/vacancies/example', 'Essen, Germany'), {
    key: 'undutchables.nl', name: 'Undutchables', country: 'unknown',
  });
  assert.deepEqual(sourceInfoForUrl('https://undutchables.nl/vacancies/example', 'Amsterdam, Netherlands'), {
    key: 'undutchables.nl', name: 'Undutchables', country: 'netherlands',
  });
});

test('uses company, title, location and posting day for cross-source fingerprints', () => {
  const first = jobIdentityFingerprint({ sourceUrl: 'https://jobs.ch/example', title: 'Data Analyst', company: 'Example AG', location: 'Zürich', postedAt: '2026-08-27T08:00:00Z' });
  const second = jobIdentityFingerprint({ sourceUrl: 'https://jobup.ch/other', title: 'DATA ANALYST', company: 'Example AG', location: 'Zurich', postedAt: '2026-08-27T20:00:00Z' });
  assert.equal(first, second);
});

test('does not fingerprint jobs without a posting day', () => {
  assert.equal(jobIdentityFingerprint({
    sourceUrl: 'https://jobs.ch/example', title: 'Data Analyst', company: 'Example AG', location: 'Zürich',
  }), '');
});
