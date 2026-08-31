import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchUrl, decodeEntities, extractJobPosting, interleaveUnique, isJobsChUrl,
  stripHtml } from '../lib/jobsch';

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
  assert.equal(
    stripHtml('<p>Project &amp; product</p><script>bad()</script><p>English&nbsp;only</p>'),
    'Project & product\nEnglish only',
  );
});

test('keeps the list structure that makes requirements readable', () => {
  // Flattening a <ul> into one line is what made requirements impossible to show on a card.
  assert.equal(
    stripHtml('<h3>Your profile</h3><ul><li>5 years SQL</li><li>Fluent English</li></ul>'),
    'Your profile\n• 5 years SQL\n• Fluent English',
  );
  assert.equal(stripHtml('<p>One<br>Two</p>'), 'One\nTwo');
  // Empty blocks must not leave stray bullets or run away with blank lines.
  assert.equal(stripHtml('<ul><li></li><li>Only item</li></ul>'), '• Only item');
});

test('decodes named and numeric entities outside of HTML', () => {
  // Titles arrive without tags but still encoded, which broke both display and duplicate matching.
  assert.equal(decodeEntities('Senior Cost &amp; Inventory Analyst'), 'Senior Cost & Inventory Analyst');
  assert.equal(decodeEntities('Caf&eacute; &#38; Bar &#x2013; Manager'), 'Café & Bar – Manager');
  assert.equal(decodeEntities('leave &unknown; alone'), 'leave &unknown; alone');
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
