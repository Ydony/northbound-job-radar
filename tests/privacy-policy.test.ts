import assert from 'node:assert/strict';
import test from 'node:test';
import { CV_MATCHING_ENABLED } from '../lib/features';
import { dataWeHold, notCollected, privacyHeadline, privacySummary, whereDataLives,
  yourRights } from '../lib/privacy-policy';

/**
 * The privacy page is the one page whose entire purpose is being true.
 *
 * AGENTS.md requires it to describe what the code actually does, changed in the same commit as
 * any change to data handling. Nothing enforced that, and it drifted: it told a stranger their CV
 * was stored and read to score jobs, months after CV matching was shelved behind a flag that
 * makes the upload unreachable. These tests are the enforcement.
 */

// Everything the page renders, not only the parts that were already in this module. The first
// version of this test covered dataWeHold/notCollected/yourRights and passed while the page's own
// hardcoded JSX still said "Your CV stays yours" and "R2 (your CV file)" — the copy was simply
// somewhere the test could not see. That copy now lives here, so this really is everything.
const everything = JSON.stringify({
  dataWeHold, notCollected, yourRights, privacyHeadline, privacySummary, whereDataLives,
});

test('the CV disclosure matches whether CV matching actually exists', () => {
  const mentionsCv = /\bCVs?\b/.test(everything);
  assert.equal(
    mentionsCv,
    CV_MATCHING_ENABLED,
    CV_MATCHING_ENABLED
      ? 'CV matching is enabled but the privacy page does not disclose that CVs are stored'
      : 'CV matching is shelved, so the privacy page must not claim CVs are stored and read',
  );
});

test('a stored CV is disclosed as an item of data whenever the feature is on', () => {
  const declaresCv = dataWeHold.some((item) => /\bCV\b/.test(item.what));
  assert.equal(declaresCv, CV_MATCHING_ENABLED);
});

test('the page does not offer to delete something the app cannot hold', () => {
  const erasure = yourRights.find((right) => right.right === 'Erasure');
  assert.ok(erasure, 'the erasure right is missing');
  if (!CV_MATCHING_ENABLED) {
    assert.doesNotMatch(erasure!.how, /\bCV\b/,
      'erasure offers to delete a CV that cannot be uploaded');
  }
});

test('it says the advertisement text stays on the server', () => {
  // The §1 promise, stated where a person would look for it rather than only in a policy doc.
  const jobs = dataWeHold.find((item) => /advertisement/i.test(item.what));
  assert.ok(jobs, 'collected advertisements are not disclosed at all');
  assert.match(jobs!.why, /not sent to your browser|is not sent/i);
});

test('search settings are described as the three that still exist', () => {
  // Location, workplace, seniority and contract type were removed as filters. A policy page
  // listing them tells the reader the app does something it stopped doing.
  const settings = dataWeHold.find((item) => /search settings/i.test(item.what));
  assert.ok(settings, 'search settings are not disclosed');
  assert.doesNotMatch(settings!.what, /\blocation\b|\bfilters\b/i);
});

test('the page headline and summary do not promise CV handling that does not exist', () => {
  const intro = `${privacyHeadline.lead} ${privacyHeadline.emphasis} ${privacySummary}`;
  assert.equal(/\bCVs?\b/.test(intro), CV_MATCHING_ENABLED,
    'the privacy headline or summary disagrees with whether CV matching exists');
});

test('where the data lives matches the storage actually in use', () => {
  const lines = whereDataLives.join(' ');
  assert.equal(/\bCVs?\b/.test(lines), CV_MATCHING_ENABLED);
  // R2 holds CV files and nothing else. Naming it while the feature is off describes a bucket
  // that receives nothing.
  assert.equal(/\bR2\b/.test(lines), CV_MATCHING_ENABLED,
    'R2 is described as storing data while nothing writes to it');
  assert.match(lines, /Cloudflare D1/, 'the database is not disclosed at all');
});

test('no privacy copy offers a search filter that was removed', () => {
  // "role keywords and location" outlived the location filter by some months.
  assert.doesNotMatch(whereDataLives.join(' '), /keywords and location/i);
});
