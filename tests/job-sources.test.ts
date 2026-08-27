import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeManualJobUrl, sourceNameForUrl } from '../lib/job-sources';

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
