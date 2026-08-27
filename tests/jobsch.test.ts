import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchUrl, extractJobPosting, interleaveUnique, isJobsChUrl, stripHtml } from '../lib/jobsch';

test('interleaves results from two CV-derived roles', () => {
  assert.deepEqual(interleaveUnique([
    ['a1', 'a2', 'shared', 'a4'],
    ['b1', 'shared', 'b3'],
  ]), ['a1', 'b1', 'a2', 'shared', 'b3', 'a4']);
});

test('accepts only HTTPS jobs.ch hosts', () => {
  assert.equal(isJobsChUrl('https://www.jobs.ch/en/vacancies/detail/example/'), true);
  assert.equal(isJobsChUrl('https://jobs.ch/en/vacancies/'), true);
  assert.equal(isJobsChUrl('http://www.jobs.ch/en/vacancies/'), false);
  assert.equal(isJobsChUrl('https://jobs.ch.evil.example/vacancies/'), false);
});

test('strips basic HTML and entities from job descriptions', () => {
  assert.equal(stripHtml('<p>Project &amp; product</p><script>bad()</script><p>English&nbsp;only</p>'), 'Project & product English only');
});

test('encodes role, location and page in a jobs.ch search URL', () => {
  const url = new URL(buildSearchUrl('Data Governance Analyst', 2, 'Zürich'));
  assert.equal(url.searchParams.get('term'), 'Data Governance Analyst');
  assert.equal(url.searchParams.get('location'), 'Zürich');
  assert.equal(url.searchParams.get('page'), '2');
});

test('extracts posting dates and fields from a JobPosting graph', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@graph': [{
      '@type': 'JobPosting',
      title: 'Master Data Analyst',
      description: '<p>English role description</p>',
      datePosted: '2026-08-27',
      hiringOrganization: { name: 'Example BV' },
    }],
  })}</script>`;
  const posting = extractJobPosting(html);
  assert.equal(posting?.title, 'Master Data Analyst');
  assert.equal(posting?.datePosted, '2026-08-27');
  assert.equal(posting?.hiringOrganization?.name, 'Example BV');
});
