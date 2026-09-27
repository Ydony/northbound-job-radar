import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublicRefreshFetchers,
  parseRefreshTerms,
  resolvePublicRefreshFetcher,
} from '../lib/public-refresh-scheduler';
import { jobSourceAdapters, adminOnlySourceKeys } from '../lib/job-adapters';
import { adminOnlySourcePolicyKeys, sourcePolicyFor, SOURCE_POLICY_REGISTRY } from '../lib/source-policy';

/**
 * INT-12 (#168): the public collector can never reach an administrator-only source.
 *
 * `docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` §3: "Never run admin traffic through the public
 * collector. Separate outbound paths reduce shared-IP exposure." INT-02 proved that admin-only
 * *records* stay invisible to ordinary accounts. This file proves the other direction, which is
 * the one INT-06's public catalogue and refresh work put at risk: that the public path never
 * *calls* those sources at all.
 *
 * Why the sources are named here rather than derived. A test that only asks "no admin-only source
 * is wired" passes the moment a source stops being marked admin-only - including by accident. The
 * VPN-gated JobCloud sites, IamExpat and Undutchables carry real terms-of-service and legal risk
 * (AGENTS.md records them as knowingly against terms, at the operator's explicit instruction), and
 * Indeed is under a separate negotiated arrangement. Naming them means a change of audience on any
 * of them fails here and has to be argued for, rather than silently widening what the public
 * collector touches.
 *
 * The public refresh runs unattended on a schedule, from a shared address, with nobody watching -
 * which is exactly why it is the wrong path for a source that must be manually triggered behind a
 * VPN.
 */

/** The sources INT-12 names. Keys, not display names, because keys are what the code gates on. */
const NAMED_ADMIN_SOURCES = [
  'jobs.ch',
  'jobup.ch',
  'jobscout24.ch',
  'iamexpat.nl',
  'undutchables.nl',
];

const TERMS = parseRefreshTerms('data analyst,supply chain');

test('the named VPN-gated and unresolved sources are still administrator-only', () => {
  for (const key of NAMED_ADMIN_SOURCES) {
    const policy = sourcePolicyFor(key);
    assert.ok(policy, `${key} has no registry entry; INT-01 requires one`);
    assert.equal(policy.audience, 'admin-only',
      `${key} must stay administrator-only: it is manually triggered behind a VPN and carries stated legal risk`);
  }
  // Indeed is administrator-only for a different reason - a negotiated arrangement rather than a
  // terms conflict - so it is asserted separately rather than lumped in above.
  for (const key of ['indeed-ch', 'indeed-nl']) {
    assert.equal(sourcePolicyFor(key)?.audience, 'admin-only', `${key} must stay administrator-only`);
  }
});

test('resolving a public refresh fetcher refuses every administrator-only source by name', () => {
  for (const key of [...NAMED_ADMIN_SOURCES, 'indeed-ch', 'indeed-nl']) {
    assert.throws(() => resolvePublicRefreshFetcher(key, TERMS), /not a public-eligible enabled source/,
      `the public refresh must refuse ${key} outright, not skip it quietly`);
  }
});

test('resolving refuses every administrator-only source in the registry, not only the named ones', () => {
  // The named list is the floor. This is the ceiling: a source added as admin-only in future is
  // covered without anyone remembering to extend the list above.
  for (const key of adminOnlySourcePolicyKeys()) {
    assert.throws(() => resolvePublicRefreshFetcher(key, TERMS), /Public refresh refused/,
      `the public refresh must refuse ${key}`);
  }
});

test('the wired fetcher set contains no administrator-only key, under any alias', () => {
  const fetchers = buildPublicRefreshFetchers(TERMS);
  const wired = Object.keys(fetchers);
  assert.ok(wired.length > 0, 'a refresh with terms must wire the public sources, or this proves nothing');

  // `adminOnlySourceKeys()` is the enforced gate and includes each adapter's `resultSourceKeys`
  // aliases, so a source wired under the key its results are stored under is caught too.
  const hidden = adminOnlySourceKeys();
  for (const key of wired) {
    assert.ok(!hidden.has(key), `${key} is administrator-only and must never be wired into the public refresh`);
  }
  for (const key of [...NAMED_ADMIN_SOURCES, 'indeed-ch', 'indeed-nl']) {
    assert.ok(!(key in fetchers), `${key} must not appear in the public refresh fetcher set`);
  }
  // Every wired source is public *and* enabled in the registry: enabled alone is not the gate.
  for (const key of wired) {
    const policy = sourcePolicyFor(key);
    assert.equal(policy?.audience, 'public', `${key} was wired without being public`);
    assert.equal(policy?.enabled, true, `${key} was wired while disabled`);
  }
});

test('an administrator-only source with a bulk search path is still refused', () => {
  // The two gates are independent, and this is the one that could rot. `resolvePublicRefreshFetcher`
  // rejects a source for being non-public *before* it checks for a bulk search path, so an
  // admin-only adapter that gains `searchDetailed` - Adzuna and Careerjet already have one - must
  // not become eligible by that alone.
  const withBulkPath = jobSourceAdapters
    .filter((adapter) => adapter.searchDetailed)
    .filter((adapter) => sourcePolicyFor(adapter.key)?.audience === 'admin-only')
    .map((adapter) => adapter.key);
  assert.ok(withBulkPath.length > 0,
    'no administrator-only adapter has a bulk search path, so this test is not exercising the case it exists for');
  for (const key of withBulkPath) {
    assert.throws(() => resolvePublicRefreshFetcher(key, TERMS), /not a public-eligible enabled source/,
      `${key} has a bulk search path but is administrator-only, and must stay refused`);
  }
});

test('a page-fetching source can never be reached through the public refresh', () => {
  // The second gate, in its own right: detail-page fetching stays administrator-only whatever the
  // audience says, so a public source without a bulk path is refused rather than page-fetched on a
  // schedule. This is the rule that keeps an unattended run from crawling detail pages.
  const publicWithoutBulk = SOURCE_POLICY_REGISTRY
    .filter((policy) => policy.audience === 'public' && policy.enabled)
    .map((policy) => policy.key)
    .filter((key) => !jobSourceAdapters.find((adapter) => adapter.key === key)?.searchDetailed);
  for (const key of publicWithoutBulk) {
    assert.throws(() => resolvePublicRefreshFetcher(key, TERMS), /no bulk search path/,
      `${key} has no bulk search path, so the public refresh must refuse it rather than fetch pages`);
  }
});

test('a refresh with no terms wires nothing at all', () => {
  // Not an optimisation. Empty terms are the default in production, and the run still has to keep
  // locks, cursors and freshness truthful - it just must not contact anything while doing so.
  assert.deepEqual(buildPublicRefreshFetchers([]), {});
  assert.deepEqual(buildPublicRefreshFetchers(parseRefreshTerms(undefined)), {});
  assert.deepEqual(buildPublicRefreshFetchers(parseRefreshTerms('  ,  ,')), {});
});
