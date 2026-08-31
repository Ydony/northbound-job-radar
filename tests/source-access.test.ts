import assert from 'node:assert/strict';
import test from 'node:test';
import { adminOnlySourceKeys, jobSourceAdapters } from '../lib/job-adapters';

test('Careerjet and IamExpat are administrator-only', () => {
  const keys = adminOnlySourceKeys();
  // Named explicitly by the owner: Careerjet is licensed to one declared IP, and IamExpat is read
  // from public pages rather than an API. Fine for the owner; not something to offer to others.
  for (const key of ['careerjet-ch', 'careerjet-nl', 'iamexpat.nl']) {
    assert.ok(keys.has(key), `${key} must be administrator-only`);
  }
});

test('every restricted source is administrator-only too', () => {
  // `restricted` means page-fetching behind a verified VPN. That is a narrower rule than
  // `adminOnly`, but everything in it is also administrator-only, and the derived list has to
  // cover both — otherwise a source could be VPN-gated for searching yet have its stored results
  // visible to an ordinary account.
  const keys = adminOnlySourceKeys();
  for (const adapter of jobSourceAdapters.filter((entry) => entry.access === 'restricted')) {
    assert.ok(keys.has(adapter.key), `${adapter.key} is restricted but not hidden`);
  }
});

test('the sources an ordinary account may use are the ones we intend', () => {
  const keys = adminOnlySourceKeys();
  const open = jobSourceAdapters.filter((adapter) => !keys.has(adapter.key)).map((adapter) => adapter.key).sort();
  // Pinned deliberately. Adding a source is fine; adding one that ordinary accounts can reach
  // should be a decision someone made on purpose, so this test asks them to confirm it here.
  assert.deepEqual(open, [
    'adzuna-ch', 'adzuna-nl', 'ats-ch', 'ats-nl', 'eures-ch', 'eures-nl', 'job-room.ch',
  ]);
});
