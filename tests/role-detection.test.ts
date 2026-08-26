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

test('returns an empty role when no supported title noun exists', () => {
  assert.equal(deriveRoleFromCv('Writer and editor with ten years of publishing experience.'), '');
});
