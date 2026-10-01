import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { adminOnlySourceKeys, jobSourceAdapters } from '../lib/job-adapters';
import {
  HOSTED_ELIGIBILITIES,
  SOURCE_POLICY_REGISTRY,
  hostedBlockedKeys,
  hostedEligibilityFor,
  hostedRunnableKeys,
  sourcePolicyFor,
} from '../lib/source-policy';

/**
 * T14 (F4): explicit hosted admin eligibility for the supported matrix.
 *
 * Every administrator adapter carries a hosted decision — supported, configuration
 * needed, or blocked with the exact reason — so the owner can review the list before
 * launch. Ordinary-account denial is preserved unchanged: this file re-pins the open
 * set rather than trusting the new field to imply it.
 */

test('every adapter has exactly one hosted decision with its reason', () => {
  assert.ok(jobSourceAdapters.length > 0, 'expected at least one adapter');
  for (const adapter of jobSourceAdapters) {
    const entry = hostedEligibilityFor(adapter.key);
    assert.ok(entry, `${adapter.key} has no hosted decision: add one to SOURCE_POLICY_REGISTRY`);
    assert.ok(
      (HOSTED_ELIGIBILITIES as readonly string[]).includes(entry.hosted),
      `${adapter.key} has an unknown hosted eligibility: ${entry.hosted}`,
    );
    assert.match(entry.hostedBasis.trim(), /.{20,}/, `${adapter.key} records no hosted reason`);
  }
  const adapterKeys = new Set(jobSourceAdapters.map((adapter) => adapter.key));
  for (const entry of SOURCE_POLICY_REGISTRY) {
    assert.ok(adapterKeys.has(entry.key), `${entry.key} has a registry entry but no adapter`);
  }
});

test('public sources all run on the host without further decisions', () => {
  for (const entry of SOURCE_POLICY_REGISTRY.filter((row) => row.audience === 'public')) {
    assert.equal(entry.hosted, 'supported', `${entry.key} is public but not hosted-supported`);
  }
});

test('the hosted matrix is the one the owner reviews: supported, configuration-needed, blocked', () => {
  // Pinned deliberately. Moving a source between these rows changes what an administrator
  // can trigger by phone on the host, so it must be a decision recorded here, not drift.
  // No admin source is supported on the host today (T12/T13 assessments): IamExpat stays
  // blocked pending a terms review — "no VPN required locally" is not hosted clearance.
  // Lifting any blocked row needs an explicit, source-specific owner decision.
  assert.deepEqual(
    SOURCE_POLICY_REGISTRY.filter((row) => row.audience === 'admin-only' && row.hosted === 'supported')
      .map((row) => row.key).sort(),
    [],
  );
  assert.deepEqual(
    SOURCE_POLICY_REGISTRY.filter((row) => row.audience === 'admin-only' && row.hosted === 'configuration-needed')
      .map((row) => row.key).sort(),
    ['adzuna-ch', 'adzuna-nl'],
  );
  assert.deepEqual(
    SOURCE_POLICY_REGISTRY.filter((row) => row.audience === 'admin-only' && row.hosted === 'blocked')
      .map((row) => row.key).sort(),
    [
      'careerjet-ch', 'careerjet-nl',
      'iamsterdam.com',
      'iamexpat.nl',
      'indeed-ch', 'indeed-nl',
      'jobs.ch', 'jobscout24.ch', 'jobup.ch',
      'nationalevacaturebank.nl',
      'undutchables.nl',
    ],
  );
});

test('hosted helpers partition the registry without drift', () => {
  assert.deepEqual(
    [...hostedRunnableKeys()].sort(),
    SOURCE_POLICY_REGISTRY.filter((row) => row.hosted !== 'blocked').map((row) => row.key).sort(),
  );
  assert.deepEqual(
    [...hostedBlockedKeys()].sort(),
    SOURCE_POLICY_REGISTRY.filter((row) => row.hosted === 'blocked').map((row) => row.key).sort(),
  );
  assert.equal(sourcePolicyFor('iamexpat.nl')?.hosted, 'blocked');
  assert.equal(sourcePolicyFor('adzuna-ch')?.hosted, 'configuration-needed');
  assert.equal(sourcePolicyFor('jobs.ch')?.hosted, 'blocked');
});

test('blocked hosted rows name the exact reason an administrator will see', () => {
  assert.match(hostedEligibilityFor('jobs.ch')!.hostedBasis, /no hosted exception has been approved/i);
  assert.match(hostedEligibilityFor('undutchables.nl')!.hostedBasis, /HTTP 403/i);
  assert.match(hostedEligibilityFor('careerjet-ch')!.hostedBasis, /leave .* unset in hosted environments/i);
  // IamExpat stays blocked pending a terms review: local no-VPN is not hosted clearance,
  // and lifting it needs an explicit owner decision — not a quiet flag flip (T12).
  assert.match(hostedEligibilityFor('iamexpat.nl')!.hostedBasis, /pending a terms review/i);
  assert.match(hostedEligibilityFor('iamexpat.nl')!.hostedBasis, /not the same as hosted clearance/i);
  // Indeed's local experimental exception is never silently generalized: a
  // source-specific decision is required before any hosted implementation of it.
  for (const key of ['indeed-ch', 'indeed-nl']) {
    assert.match(hostedEligibilityFor(key)!.hostedBasis, /loopback/i, `${key} must stay loopback-only`);
    assert.match(hostedEligibilityFor(key)!.hostedBasis, /source-specific decision/i);
  }
});

test('ordinary-account denial is unchanged by the hosted matrix', () => {
  // Same pinned open set as tests/source-access.test.ts: adding a source ordinary
  // accounts can reach must stay a deliberate decision, and the hosted work must not
  // widen it by accident.
  const keys = adminOnlySourceKeys();
  const open = jobSourceAdapters.filter((adapter) => !keys.has(adapter.key)).map((adapter) => adapter.key).sort();
  assert.deepEqual(open, [
    'ats-ch', 'ats-nl', 'eures-ch', 'eures-nl', 'freehire-ch', 'freehire-nl', 'job-room.ch',
  ]);
  // The hosted-blocked admin source stays hidden from ordinary accounts.
  assert.ok(keys.has('iamexpat.nl'), 'hosted-blocked IamExpat must stay administrator-only');
});

test('the scrape route gates per source instead of refusing the hosted run', async () => {
  const root = new URL('..', import.meta.url);
  const scrape = await readFile(new URL('app/api/scrape/route.ts', root), 'utf8');
  // Server-side administrator authorization still protects trigger, results, URLs, counts,
  // history and source discovery: the role gates are untouched.
  assert.match(scrape, /requestedAll && user\.role !== 'admin'/);
  assert.match(scrape, /That search mode is not available on this account/);
  assert.match(scrape, /That search selection is not available/);
  // No wholesale refusal of the hosted run: mode=all without a VPN now yields the
  // supported sources plus truthful per-source blocked rows, so phone-triggered
  // collection continues on the host and can be inspected later.
  assert.doesNotMatch(scrape, /Start the app with "npm run dev:private" first\. That checks for a full VPN route before these sources will run\.',\s*\n\s*\}, \{ status: 409 \}\)/);
  // The per-source gate reads the explicit hosted matrix and reports the exact reason.
  assert.match(scrape, /hostedBlockReason/);
  assert.match(scrape, /hostedEligibilityFor\(adapter\.key\)/);
  assert.match(scrape, /blocked: true, error: hostedBlock/);
  // The local-only exception stays local: every hosted-blocked source is blocked
  // off-loopback on its own merit — including grey-area admin-only rows like IamExpat
  // that are neither restricted nor keyed — while restricted sources still need the
  // VPN launcher locally. Naming Indeed/Careerjet explicitly here would let the next
  // hosted-blocked source slip through, so the narrow form must not return.
  assert.match(scrape, /isLoopbackRequest\(request\)/);
  assert.match(scrape, /hostedEligibilityFor\(adapter\.key\)\?\.hosted === 'blocked'/);
  assert.doesNotMatch(scrape, /adapter\.experimentalIndeed \|\| adapter\.key\.startsWith\('careerjet-'\)/);
  assert.match(scrape, /adapter\.access === 'restricted' && !vpnEnforced/);
  // Aggregates still sum the visible rows only, so an ordinary account's totals disclose
  // nothing about admin-only volume on any runtime.
  assert.match(scrape, /visibleSourceReports\(sourceReports, user\.role === 'admin', hiddenForAccount\)/);
  assert.doesNotMatch(scrape, /sourceReports\.reduce\(\(sum, source\) => sum \+ source\.foundCount/);
});
