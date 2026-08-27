import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptionMatchesRoles, jobSourceAdapters, sourceStatusForAvailability } from '../lib/job-adapters';

test('configures Swiss and Netherlands adapters without LinkedIn', () => {
  assert.equal(jobSourceAdapters.some((source) => /linkedin/i.test(`${source.key} ${source.name}`)), false);
  assert.equal(jobSourceAdapters.filter((source) => source.availability === 'enabled' && source.country === 'switzerland').length >= 3, true);
  assert.equal(jobSourceAdapters.filter((source) => source.availability === 'enabled' && source.country === 'netherlands').length >= 2, true);
});

test('keeps blocked and unavailable sources visible', () => {
  assert.equal(jobSourceAdapters.find((source) => source.key === 'indeed-nl')?.availability, 'blocked');
  assert.equal(jobSourceAdapters.find((source) => source.key === 'nationalevacaturebank.nl')?.availability, 'unavailable');
  assert.equal(jobSourceAdapters.find((source) => source.key === 'iamsterdam.com')?.availability, 'disabled');
});

test('maps adapter availability to truthful run states', () => {
  assert.equal(sourceStatusForAvailability('enabled'), 'complete');
  assert.equal(sourceStatusForAvailability('blocked'), 'blocked');
  assert.equal(sourceStatusForAvailability('unavailable'), 'unavailable');
});

test('screens public listing candidates against the requested roles', () => {
  const job = {
    sourceUrl: 'https://example.test/job/1',
    title: 'Master Data Specialist',
    company: 'Example',
    location: 'Amsterdam',
    descriptionHtml: '<p>Maintain governance standards and product records.</p>',
    postedAt: '2026-08-27',
  };
  assert.equal(descriptionMatchesRoles(job, ['Master Data']), true);
  assert.equal(descriptionMatchesRoles(job, ['Supply Chain']), false);
});

test('extracts normalized candidates through the enabled source adapters', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(`
    <a href="https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/">jobs.ch</a>
    <a href="https://www.jobup.ch/en/jobs/detail/22222222-2222-2222-2222-222222222222/">jobup</a>
    <a href="/en/job/33333333-3333-3333-3333-333333333333/">JobScout24</a>
  `, { status: 200, headers: { 'content-type': 'text/html' } }));

  const jobsCh = jobSourceAdapters.find((source) => source.key === 'jobs.ch')!;
  const jobup = jobSourceAdapters.find((source) => source.key === 'jobup.ch')!;
  const jobScout = jobSourceAdapters.find((source) => source.key === 'jobscout24.ch')!;
  assert.deepEqual(await jobsCh.search!(['Master Data'], 'Zürich'), [
    'https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/',
  ]);
  assert.deepEqual(await jobup.search!(['Master Data'], 'Zürich'), [
    'https://www.jobup.ch/en/jobs/detail/22222222-2222-2222-2222-222222222222/',
  ]);
  assert.deepEqual(await jobScout.search!(['Master Data'], 'Zürich'), [
    'https://www.jobscout24.ch/en/job/33333333-3333-3333-3333-333333333333/',
  ]);
});
