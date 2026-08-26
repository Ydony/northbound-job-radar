import assert from 'node:assert/strict';
import test from 'node:test';
import { interleaveUnique, isJobsChUrl, stripHtml } from '../lib/jobsch';

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
