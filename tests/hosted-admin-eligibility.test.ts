import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { adminOnlySourceKeys, jobSourceAdapters } from '../lib/job-adapters';
import {
  HOSTED_ELIGIBILITIES,
  SOURCE_POLICY_REGISTRY,
  hostedBlockReason,
  hostedBlockedKeys,
  hostedEligibilityFor,
  hostedRunnableKeys,
  sourcePolicyFor,
} from '../lib/source-policy';
import { HOSTED_SOURCE_ASSESSMENTS } from '../lib/hosted-sources';

/**
 * T14b (F4): explicit hosted admin eligibility for the supported matrix.
 *
 * Every adapter carries a hosted decision — supported, configuration needed, or blocked
 * with the exact reason — so the owner can review the list before launch. The T15
 * wholesale page-fetch refusal stays exactly as it is: this gate covers what does run
 * (authorized-mode administrator sources on a hosted installation, e.g. phone-triggered
 * collection). Ordinary-account denial is preserved unchanged: this file re-pins the open
 * set rather than trusting the new field to imply it.
 *
 * Synthetic only: no upstream requests, no secrets, no production access.
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
      'iamexpat.nl',
      'iamsterdam.com',
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

test('the enforcement matrix agrees with the T13 assessment matrix', () => {
  // Two files state hosted verdicts; this cross-check keeps them from drifting apart.
  // `lib/hosted-sources.ts` is the assessed matrix, this registry is what runs.
  const assessed = new Map(HOSTED_SOURCE_ASSESSMENTS.map((entry) => [entry.key, entry.decision]));
  for (const entry of SOURCE_POLICY_REGISTRY.filter((row) => row.audience === 'admin-only')) {
    assert.ok(assessed.has(entry.key), `${entry.key} is admin-only but has no T13 assessment`);
    assert.equal(
      entry.hosted,
      assessed.get(entry.key),
      `${entry.key} enforcement (${entry.hosted}) disagrees with its T13 assessment (${assessed.get(entry.key)})`,
    );
  }
  for (const key of assessed.keys()) {
    assert.ok(sourcePolicyFor(key), `${key} is assessed but has no registry entry`);
  }
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

test('hostedBlockReason pins the per-source gate on real adapters', () => {
  const byKey = (key: string) => {
    const adapter = jobSourceAdapters.find((row) => row.key === key);
    assert.ok(adapter, `${key} has no adapter`);
    return adapter;
  };
  // Restricted without a VPN: blocked everywhere. Locally the message names the
  // launcher; on the host it names the exact registry reason. A VPN flag set on a
  // hosted installation cannot satisfy the boundary either, so it stays blocked there.
  const jobsCh = byKey('jobs.ch');
  assert.equal(jobsCh.access, 'restricted');
  assert.match(
    hostedBlockReason(jobsCh, { loopback: true, vpnEnforced: false }) ?? '',
    /npm run dev:private/,
  );
  assert.equal(
    hostedBlockReason(jobsCh, { loopback: false, vpnEnforced: false }),
    hostedEligibilityFor('jobs.ch')!.hostedBasis,
  );
  assert.equal(hostedBlockReason(jobsCh, { loopback: true, vpnEnforced: true }), null);
  assert.equal(
    hostedBlockReason(jobsCh, { loopback: false, vpnEnforced: true }),
    hostedEligibilityFor('jobs.ch')!.hostedBasis,
  );
  // Hosted-blocked but neither restricted nor keyed (the grey-area case that must
  // not fall through): blocked off loopback with the exact registry reason, runnable
  // on loopback. A VPN flag does not clear it either — the block is about permission,
  // not egress. Inverting `!loopback` would flip these — exactly what this
  // gate exists to prevent — and this test fails on that mutation.
  const iamexpat = byKey('iamexpat.nl');
  assert.equal(iamexpat.access, 'grey-area');
  assert.equal(
    hostedBlockReason(iamexpat, { loopback: false, vpnEnforced: false }),
    hostedEligibilityFor('iamexpat.nl')!.hostedBasis,
  );
  assert.equal(
    hostedBlockReason(iamexpat, { loopback: false, vpnEnforced: true }),
    hostedEligibilityFor('iamexpat.nl')!.hostedBasis,
  );
  assert.equal(hostedBlockReason(iamexpat, { loopback: true, vpnEnforced: false }), null);
  // Loopback-only local experiments are never silently generalized to the host.
  for (const key of ['indeed-ch', 'careerjet-ch']) {
    const adapter = byKey(key);
    assert.equal(
      hostedBlockReason(adapter, { loopback: false, vpnEnforced: false }),
      hostedEligibilityFor(key)!.hostedBasis,
      `${key} must stay blocked off loopback`,
    );
    assert.equal(
      hostedBlockReason(adapter, { loopback: true, vpnEnforced: false }),
      null,
      `${key} must run for a local loopback administrator`,
    );
  }
  // Configuration-needed runs on the host (missing credentials report unavailable
  // downstream, never blocked); supported public sources always run.
  assert.equal(
    hostedBlockReason(byKey('adzuna-ch'), { loopback: false, vpnEnforced: false }),
    null,
  );
  for (const key of ['ats-ch', 'eures-nl', 'job-room.ch', 'freehire-ch']) {
    assert.equal(hostedBlockReason(byKey(key), { loopback: false, vpnEnforced: false }), null);
    assert.equal(hostedBlockReason(byKey(key), { loopback: true, vpnEnforced: false }), null);
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

test('the scrape route keeps the T15 wholesale refusal and gates per source', async () => {
  const root = new URL('..', import.meta.url);
  const scrape = await readFile(new URL('app/api/scrape/route.ts', root), 'utf8');
  const policy = await readFile(new URL('lib/source-policy.ts', root), 'utf8');
  // Server-side administrator authorization still protects trigger, results, URLs, counts,
  // history and source discovery: the role gates are untouched.
  assert.match(scrape, /requestedAll && user\.role !== 'admin'/);
  assert.match(scrape, /That search mode is not available on this account/);
  assert.match(scrape, /That search selection is not available/);
  // The T15 wholesale page-fetch refusal stays: without the VPN-enforced marker the mode
  // is refused before any source is contacted (409), with a hosted-aware message, so VPN
  // absence cannot silently produce a misleading success.
  assert.match(scrape, /requestedAll && !authSecrets\(\)\.vpnEnforced/);
  assert.match(scrape, /pageFetchRefusalMessage\(\{ hosted:/);
  assert.match(scrape, /isHostedCollectionRequest\(request\)/);
  assert.match(scrape, /status: 409/);
  // Alongside it, the route delegates to the single pure decision point per source and
  // reports its reason — the known T14b wiring over the T15 refusal.
  assert.match(scrape, /hostedBlockReason\(adapter, \{ loopback, vpnEnforced \}\)/);
  assert.match(scrape, /blocked: true, policyBlocked: true, error: hostedBlock/);
  assert.match(scrape, /isLoopbackRequest\(request\)/);
  // A policy block carries the registry reason on its own: the source was never
  // contacted, so the run history must not claim it refused anything.
  assert.match(scrape, /policyBlocked \? error :/);
  // The gate itself lives in lib/source-policy.ts and reads the explicit hosted
  // matrix: every hosted-blocked source is blocked off-loopback on its own merit —
  // including grey-area admin-only rows like IamExpat that are neither restricted
  // nor keyed — while restricted sources still need the VPN launcher locally.
  // Naming Indeed/Careerjet explicitly here would let the next hosted-blocked
  // source slip through, so the narrow form must not return.
  assert.match(policy, /export function hostedBlockReason/);
  assert.match(policy, /hostedEligibilityFor\(adapter\.key\)/);
  assert.match(policy, /hostedEligibilityFor\(adapter\.key\)\?\.hosted === 'blocked'/);
  assert.match(policy, /adapter\.access === 'restricted' && !vpnEnforced/);
  assert.match(policy, /!loopback && hostedEligibilityFor/);
  assert.doesNotMatch(policy, /adapter\.experimentalIndeed \|\| adapter\.key\.startsWith\('careerjet-'\)/);
  assert.doesNotMatch(scrape, /adapter\.experimentalIndeed \|\| adapter\.key\.startsWith\('careerjet-'\)/);
  // Aggregates still sum the visible rows only, so an ordinary account's totals disclose
  // nothing about admin-only volume on any runtime.
  assert.match(scrape, /visibleSourceReports\(sourceReports, user\.role === 'admin', hiddenForAccount\)/);
  assert.doesNotMatch(scrape, /sourceReports\.reduce\(\(sum, source\) => sum \+ source\.foundCount/);
  // F4 forbids working around a refusal: no evasion, proxy rotation, challenge bypass,
  // login automation or higher collection volume may ride along with hosted work.
  assert.doesNotMatch(scrape, /from '[^']*(puppeteer|playwright|proxy|stealth|socks)[^']*'/i,
    'no evasion library may ride along with hosted work');
  assert.doesNotMatch(scrape, /stealth|fingerprint.{0,20}spoof|rotate.{0,20}(proxy|ip)|captcha.{0,20}(solv|bypass)/i,
    'no disguise-shaped code may ride along with hosted work');
});
