import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveRoleFromCv } from '../lib/role-detection';

test('derives a repeated software-engineering title', () => {
  const cv = 'Alex Example Software Engineer Summary Experienced Software Engineer building web products. Experience Senior Software Engineer at Example AG.';
  assert.equal(deriveRoleFromCv(cv), 'Software Engineer');
});

test('does not include Candidate from a heading', () => {
  const cv = 'Candidate Data Analyst Profile Data Analyst with SQL experience. Experience Data Analyst at Example AG.';
  assert.equal(deriveRoleFromCv(cv), 'Data Analyst');
});

test('prefers the target title in the CV header over a repeated older role', () => {
  const cv = `Don Example MASTER DATA & DATA GOVERNANCE ANALYST
    Profile focused on governance, stewardship and business rules as an analyst.
    Previous experience: Web Administrator. Web Administrator. Web Administrator.
    Earlier projects as Web Administrator and freelance Web Administrator. Analyst support and analyst reporting.`;
  assert.equal(deriveRoleFromCv(cv), 'Data Governance Analyst');
});

test('returns an empty role when no supported title noun exists', () => {
  assert.equal(deriveRoleFromCv('Writer and editor with ten years of publishing experience.'), '');
});
