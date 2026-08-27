import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeManualJobUrl, netherlandsJobSources, sourceNameForUrl } from '../lib/job-sources';

test('lists five Netherlands sources without LinkedIn', () => {
  const sources = netherlandsJobSources('Data Governance Analyst');
  assert.equal(sources.length, 5);
  assert.equal(sources.some((source) => /linkedin/i.test(`${source.name} ${source.url}`)), false);
  const indeed = new URL(sources.find((source) => source.name === 'Indeed Netherlands')!.url);
  assert.equal(indeed.searchParams.get('q'), 'Data Governance Analyst English');
  assert.equal(indeed.searchParams.get('l'), 'Amsterdam');
});

test('accepts safe HTTPS manual job links and rejects local or deceptive URLs', () => {
  assert.equal(isSafeManualJobUrl('https://nl.indeed.com/viewjob?jk=example'), true);
  assert.equal(isSafeManualJobUrl('https://careers.example-company.com/job/123'), true);
  assert.equal(isSafeManualJobUrl('http://www.iamexpat.nl/career/jobs-netherlands/example'), false);
  assert.equal(isSafeManualJobUrl('https://localhost/job/123'), false);
  assert.equal(isSafeManualJobUrl('https://127.0.0.1/job/123'), false);
  assert.equal(isSafeManualJobUrl('https://user:secret@example.com/job/123'), false);
  assert.equal(isSafeManualJobUrl('javascript:alert(1)'), false);
});

test('shows known source names and a safe employer-site fallback', () => {
  assert.equal(sourceNameForUrl('https://www.iamsterdam.com/en/live-work-study/work/job-search'), 'I amsterdam');
  assert.equal(sourceNameForUrl('https://careers.example-company.com/job/123'), 'Employer site');
});
