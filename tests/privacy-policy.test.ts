import assert from 'node:assert/strict';
import test from 'node:test';
import { dataWeHold, notCollected, privacyHeadline, privacySummary, retentionReviewNote,
  visitCounting, whereDataLives, yourRights } from '../lib/privacy-policy';

/**
 * The privacy page is the one page whose entire purpose is being true.
 *
 * AGENTS.md requires it to describe what the code actually does, changed in the same commit as
 * any change to data handling. These tests guard the removal of CV handling.
 */

// Everything the page renders, not only the parts that were already in this module. The first
// version of this test covered dataWeHold/notCollected/yourRights and passed while the page's own
// hardcoded JSX still said "Your CV stays yours" and "R2 (your CV file)" — the copy was simply
// somewhere the test could not see. That copy now lives here, so this really is everything.
const everything = JSON.stringify({
  dataWeHold, notCollected, yourRights, privacyHeadline, privacySummary, whereDataLives,
});

test('privacy copy does not claim active CV storage or matching', () => {
  assert.doesNotMatch(everything, /\bCVs?\b/i);
  assert.doesNotMatch(everything, /\bR2\b/);
});

test('the page does not offer to delete something the app cannot hold', () => {
  const erasure = yourRights.find((right) => right.right === 'Erasure');
  assert.ok(erasure, 'the erasure right is missing');
  assert.doesNotMatch(erasure!.how, /\bCV\b/);
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
  assert.doesNotMatch(intro, /\bCVs?\b/);
});

test('where the data lives matches the storage actually in use', () => {
  const lines = whereDataLives.join(' ');
  assert.doesNotMatch(lines, /\bCVs?\b|\bR2\b/);
  assert.match(lines, /D1-compatible/, 'the database is not disclosed at all');
});

test('no privacy copy offers a search filter that was removed', () => {
  // "role keywords and location" outlived the location filter by some months.
  assert.doesNotMatch(whereDataLives.join(' '), /keywords and location/i);
});

test('verification and reset emails name their delivery provider', () => {
  // Sending through Resend shares the address with a third party, so the page must say so in
  // the same commit that introduces it — "shared with anyone" would otherwise be untrue.
  const everything = JSON.stringify({ dataWeHold, notCollected, whereDataLives });
  assert.match(everything, /Resend/);
  const tokens = dataWeHold.find((item) => /verification and password-reset/i.test(item.what));
  assert.ok(tokens, 'verification/reset tokens are not disclosed at all');
  assert.match(tokens!.kept, /expir/i);
});

test('hosting disclosure covers the private production installation, not only local', () => {
  // T38: the old copy claimed the data sits on "this computer" and the setup is
  // "not publicly hosted", which is false for the live Cloudflare installation.
  const lines = whereDataLives.join(' ');
  assert.match(lines, /Cloudflare/);
  assert.match(lines, /registration closed/);
  assert.doesNotMatch(lines, /not publicly hosted/);
  assert.match(lines, /D1-compatible/);
});

test('the notice is honest about backups: none attached, replica undecided', () => {
  const lines = whereDataLives.join(' ');
  assert.match(lines, /No automated backup replica is currently attached/);
  assert.match(lines, /undecided/);
});

test('the retention note promises no schedule the code does not run', () => {
  assert.match(retentionReviewNote.body, /not enforced|does not run|waiting/i);
  assert.doesNotMatch(retentionReviewNote.body, /\bCV\b/);
});

test('the newly added notice copy stays free of removed-feature claims', () => {
  const added = JSON.stringify({ retentionReviewNote, visitCounting, whereDataLives });
  assert.doesNotMatch(added, /\bCVs?\b/i);
  assert.doesNotMatch(added, /\bR2\b/);
});
