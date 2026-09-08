import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJobUrl, isNearDuplicate, jobIdentityFingerprint, sourceInfoForUrl,
  sourceJobIdFromUrl } from '../lib/job-identity';

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

test('two copies with posting dates inside the window are one job', () => {
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z' },
    { location: 'Amsterdam', postedAt: '2026-09-03T00:00:00Z' },
  ), true);
});

test('a genuine repost outside the posting window stays a separate job', () => {
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-06-01T00:00:00Z' },
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z' },
  ), false);
});

test('first-seen decides when a source publishes no posting date', () => {
  // The case this fallback exists for: several sources omit a posting date entirely, and the
  // rule used to fall straight through to "assume duplicate", merging on employer, role and
  // place alone. A long-running vacancy and its reposting months later became one card.
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', firstSeenAt: '2026-09-01T00:00:00Z' },
    { location: 'Amsterdam', firstSeenAt: '2026-09-05T00:00:00Z' },
  ), true);
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', firstSeenAt: '2026-06-01T00:00:00Z' },
    { location: 'Amsterdam', firstSeenAt: '2026-09-01T00:00:00Z' },
  ), false);
});

test('first-seen is only a fallback — a posting date on both sides still wins', () => {
  // First-seen is our record, not the employer's. Where the employer published dates, those
  // decide, even when the two copies reached this app months apart.
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z', firstSeenAt: '2026-01-01T00:00:00Z' },
    { location: 'Amsterdam', postedAt: '2026-09-02T00:00:00Z', firstSeenAt: '2026-09-02T00:00:00Z' },
  ), true);
});

test('first-seen tolerates a wider gap than a posting date, because it lags', () => {
  const tenDaysApart = { left: '2026-09-01T00:00:00Z', right: '2026-09-11T00:00:00Z' };
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: tenDaysApart.left },
    { location: 'Amsterdam', postedAt: tenDaysApart.right },
  ), false, 'ten days is outside the four-day posting window');
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', firstSeenAt: tenDaysApart.left },
    { location: 'Amsterdam', firstSeenAt: tenDaysApart.right },
  ), true, 'ten days is inside the fourteen-day first-seen window');
});

test('with no date of any kind the copies still merge, rather than showing twice', () => {
  assert.equal(isNearDuplicate({ location: 'Amsterdam' }, { location: 'Amsterdam' }), true);
});

test('an incompatible place is decisive whatever the dates say', () => {
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z' },
    { location: 'Rotterdam', postedAt: '2026-09-01T00:00:00Z' },
  ), false);
});
