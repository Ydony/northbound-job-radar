import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLanguage, scoreFitAcrossCvs } from '../lib/analysis';

const englishAd = `
  This is a business role in our international company. You will work with our team and our customers.
  The position is for a candidate with experience in project management. Your responsibilities include
  business analysis, customer communication, planning and delivery. We are looking for skills and knowledge
  in management. You will have responsibility for the role and work with people across the company.
`;

test('passes a sufficiently long English advertisement with no local-language requirement', () => {
  assert.equal(analyzeLanguage(englishAd).status, 'pass');
});

test('passes an explicitly optional German requirement', () => {
  const result = analyzeLanguage(`${englishAd} German is a plus.`);
  assert.equal(result.status, 'pass');
  assert.match(result.summary, /optional/i);
});

test('treats not required as optional rather than mandatory', () => {
  assert.equal(analyzeLanguage(`${englishAd} German is not required.`).status, 'pass');
});

test('treats advantageous language skills as optional', () => {
  assert.equal(analyzeLanguage(`${englishAd} German language skills are advantageous.`).status, 'pass');
});

test('blocks a mandatory local language', () => {
  const result = analyzeLanguage(`${englishAd} Fluent French is required.`);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /French/);
});

test('does not let optional German mask mandatory French in the same sentence', () => {
  const result = analyzeLanguage(`${englishAd} German is a plus, native French.`);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /French/);
});

test('associates different cues with their nearest language', () => {
  const result = analyzeLanguage(`${englishAd} German preferred and French fluency.`);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /French/);
});

test('blocks an advanced local-language level', () => {
  const result = analyzeLanguage(`${englishAd} English and French advanced level.`);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /French/);
});

test('routes an unexplained local-language mention to review', () => {
  assert.equal(analyzeLanguage(`${englishAd} Languages: English, German.`).status, 'review');
});

test('reports the better fitting CV slot', () => {
  const result = scoreFitAcrossCvs('We need Python, SQL, machine learning and data analysis experience.', 'Data Analyst', [
    { slot: 'a', cvText: 'Project manager with stakeholder management and sales.', derivedRole: 'Project Manager' },
    { slot: 'b', cvText: 'Data analyst using Python, SQL and machine learning.', derivedRole: 'Data Analyst' },
  ]);
  assert.equal(result.bestCvSlot, 'b');
  assert.ok(result.fitScoreB > result.fitScoreA);
});
