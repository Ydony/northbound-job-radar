import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLanguage, isTruncatedAdvertisement, scoreFitAcrossCvs } from '../lib/analysis';

// Deliberately past MIN_CHARS_TO_CONFIRM_ENGLISH. The test below has always claimed this ad was
// "sufficiently long" while it was in fact 411 characters - shorter than a single Adzuna preview -
// so it was asserting a pass on exactly the evidence that is no longer good enough for one.
const englishAd = `
  This is a business role in our international company. You will work with our team and our customers.
  The position is for a candidate with experience in project management. Your responsibilities include
  business analysis, customer communication, planning and delivery. We are looking for skills and knowledge
  in management. You will have responsibility for the role and work with people across the company.
  You will report to the head of the business unit and work with stakeholders in several countries.
  The team is distributed and the working language for all meetings and documentation is English.
  We offer a permanent position, flexible hours, and a budget for training and conferences each year.
  Applications are reviewed weekly and we aim to respond to every candidate within ten working days.
  Our customers are international businesses and the role involves regular contact with them.
`;

// A short advertisement with nothing found against it is not a pass; there was not enough of it to
// say so. Keeping those two apart is the whole point of the 'unknown' bucket.
const teaserAd = 'Business analyst wanted for an international company. Apply on our website.';

test('passes a sufficiently long English advertisement with no local-language requirement', () => {
  assert.equal(analyzeLanguage(englishAd).status, 'pass');
});

test('will not confirm English on an advertisement too short to judge', () => {
  const result = analyzeLanguage(teaserAd);
  assert.equal(result.status, 'unknown');
  assert.match(result.summary, /not enough of the advertisement/i);
});

test('a finding still stands on a short advertisement', () => {
  // Absence of evidence invalidates a clean bill of health, but German spotted in a teaser is
  // still German - blocking must not be downgraded for lack of length.
  assert.equal(analyzeLanguage(`${teaserAd} Fluent German is required.`).status, 'blocked');
});

// These three used to expect `pass`. A local language named anywhere now goes to review instead,
// even when the advertisement calls it optional: "a plus" is frequently how an employer describes
// a language they go on to expect at interview, and the cost is asymmetric — a few seconds reading
// the wording against an evening spent on a job that was never open. The optional wording is still
// detected, and still stated in the summary, so the review is a quick one.
test('sends an explicitly optional German requirement to review, saying it is optional', () => {
  const result = analyzeLanguage(`${englishAd} German is a plus.`);
  assert.equal(result.status, 'review');
  assert.match(result.summary, /optional/i);
});

test('treats not required as optional rather than mandatory', () => {
  const result = analyzeLanguage(`${englishAd} German is not required.`);
  assert.equal(result.status, 'review');
  assert.match(result.summary, /optional/i);
});

test('treats advantageous language skills as optional', () => {
  const result = analyzeLanguage(`${englishAd} German language skills are advantageous.`);
  assert.equal(result.status, 'review');
  assert.match(result.summary, /optional/i);
});

test('does not let an optional cue for one language silence a requirement for another', () => {
  // The cue nearest a language binds to it: a match may not step over another language name.
  const result = analyzeLanguage(`${englishAd} German preferred and French fluency.`);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /French/);
  assert.doesNotMatch(result.summary, /German/);
});

test('reads a labelled language list, colons and levels included', () => {
  // "Sprachen: Deutsch: C2" is the clearest hard bar an ad has, and was being missed entirely.
  assert.equal(analyzeLanguage(`${englishAd} Sprachen: Deutsch: C2, Franzosisch: B2.`).status, 'blocked');
});

test('blocks a language named in the job title even when the body never repeats it', () => {
  // Aggregator teasers truncate the body, so the headline carries the only signal.
  const result = analyzeLanguage(englishAd, 'Online Data Analyst - German Language');
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /German/);
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

// C1c: the four recorded language-gate limitations, each pinned with its safe counterpart.
test('passes an explicit denial of a language requirement', () => {
  assert.equal(analyzeLanguage(`${englishAd} No German is required for this role.`).status, 'pass');
});

test('keeps a second ordinary mention in review after an explicit denial', () => {
  // The denial clears only its own occurrence: a later bare mention still costs a glance.
  assert.equal(
    analyzeLanguage(`${englishAd} No German is required for onboarding, but you will support German customers.`).status,
    'review',
  );
});

test('passes a language offered as lessons, but not one taught as a requirement', () => {
  assert.equal(
    analyzeLanguage(`${englishAd} We offer free Dutch lessons to everyone who joins us from abroad.`).status,
    'pass',
  );
  assert.equal(analyzeLanguage(`${englishAd} Dutch lessons are mandatory for this role.`).status, 'blocked');
  assert.equal(
    analyzeLanguage(`${englishAd} We offer free Dutch lessons, and fluent Dutch is required.`).status,
    'blocked',
  );
});

test('passes a language word used as a market or regulation, but not a real requirement', () => {
  assert.equal(
    analyzeLanguage(`${englishAd} Experience with Dutch financial regulation and the German market is welcome.`).status,
    'pass',
  );
  assert.equal(
    analyzeLanguage(`${englishAd} You will cover the German market. Fluent German is required.`).status,
    'blocked',
  );
});

test('blocks a bilingual requirement for a local language', () => {
  const result = analyzeLanguage(`${englishAd} You are bilingual in English and French.`);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /French/);
});

test('reports the better fitting CV slot', () => {
  const result = scoreFitAcrossCvs('We need Python, SQL, machine learning and data analysis experience.', 'Data Analyst', [
    { slot: 'a', cvText: 'Project manager with stakeholder management and sales.', derivedRole: 'Project Manager' },
    { slot: 'b', cvText: 'Data analyst using Python, SQL and machine learning.', derivedRole: 'Data Analyst' },
  ]);
  assert.equal(result.bestCvSlot, 'b');
  assert.ok(result.fitScoreB > result.fitScoreA);
});

// EURES Netherlands ads arrive cut at ~2,000 characters ending in "...", usually before the
// requirements (666/740 stored rows, measured 2026-09-18). A cut advertisement is incomplete
// evidence like a teaser: it can never confirm English, while findings before the cut stand.
test('withholds pass on a long English advertisement cut off with an ellipsis', () => {
  const result = analyzeLanguage(`${englishAd}...`);
  assert.equal(result.status, 'unknown');
  assert.match(result.summary, /cut off/i);
});

test('treats a unicode ellipsis as truncation too', () => {
  assert.equal(analyzeLanguage(`${englishAd}…`).status, 'unknown');
  assert.equal(isTruncatedAdvertisement(`${englishAd}…`), true);
});

test('does not mistake a complete advertisement for a truncated one', () => {
  assert.equal(isTruncatedAdvertisement(englishAd), false);
  assert.equal(isTruncatedAdvertisement('Just a short teaser.'), false);
  assert.equal(isTruncatedAdvertisement(`${englishAd}...  \n`), true);
});

test('a finding before the cut still stands on truncated text', () => {
  assert.equal(analyzeLanguage(`${englishAd} Fluent German is required....`).status, 'blocked');
  assert.equal(analyzeLanguage(`${englishAd} German is a plus....`).status, 'review');
});
