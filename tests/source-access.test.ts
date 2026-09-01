import assert from 'node:assert/strict';
import test from 'node:test';
import { adminOnlySourceKeys, jobSourceAdapters } from '../lib/job-adapters';
import { isSafeManualJobUrl } from '../lib/job-sources';

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

test('covers the domains results are actually stored under, not just adapter keys', () => {
  const keys = adminOnlySourceKeys();
  // The bug this exists to prevent: Careerjet returns jobviewtrack.com links, and a job's source
  // key comes from the result URL rather than the adapter that fetched it. 218 Careerjet jobs sat
  // under "jobviewtrack.com" while the hidden list named careerjet-ch and careerjet-nl, so every
  // one of them was reachable by an ordinary account despite the source being administrator-only.
  assert.ok(keys.has('jobviewtrack.com'), 'Careerjet results are stored under jobviewtrack.com');
  assert.ok(keys.has('careerjet'), 'and under a plain careerjet key');
});

test('every administrator-only adapter that redirects declares where its results land', () => {
  // A source whose links point at its own domain needs no alias. One that hands back a different
  // host does, and forgetting it is silent: the source looks hidden and its jobs are not.
  const redirecting = jobSourceAdapters.filter((adapter) =>
    (adapter.adminOnly || adapter.access === 'restricted') && adapter.key.includes('-'));
  for (const adapter of redirecting) {
    const declared = [adapter.key, ...(adapter.resultSourceKeys ?? [])];
    assert.ok(
      declared.length > 1 || adapter.key.startsWith('indeed'),
      `${adapter.key} has a country-suffixed key, so its results are stored under something else - declare resultSourceKeys`,
    );
  }
});

test('a dangerous apply link is refused, whatever the source claims', () => {
  // The apply link becomes a clickable href. Adzuna returns redirect_url and Careerjet returns url
  // straight from their own responses, so a compromised source could put a javascript: URL there
  // and have it run in this origin when somebody clicks Apply.
  for (const url of [
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://plain-http.example/job/1',
    'https://user:pass@example.com/job/1',
  ]) assert.equal(isSafeManualJobUrl(url), false, `${url} must be refused`);
  assert.equal(isSafeManualJobUrl('https://www.example.com/job/1'), true);
});
