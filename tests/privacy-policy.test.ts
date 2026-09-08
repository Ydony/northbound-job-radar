import assert from 'node:assert/strict';
import test from 'node:test';
import { CV_MATCHING_ENABLED } from '../lib/features';
import { dataWeHold, notCollected, yourRights } from '../lib/privacy-policy';

/**
 * The privacy page is the one page whose entire purpose is being true.
 *
 * AGENTS.md requires it to describe what the code actually does, changed in the same commit as
 * any change to data handling. Nothing enforced that, and it drifted: it told a stranger their CV
 * was stored and read to score jobs, months after CV matching was shelved behind a flag that
 * makes the upload unreachable. These tests are the enforcement.
 */

const everything = JSON.stringify({ dataWeHold, notCollected, yourRights });

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
