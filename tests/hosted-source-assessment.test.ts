import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  adminOnlySourceKeys,
  jobSourceAdapters,
  REQUEST_DELAY_MS,
} from '../lib/job-adapters';
import {
  CollectionRunBudgets,
  isAccessRefusal,
  isRuntimeBudgetExhausted,
  MAX_NEW_PER_PAGE_SOURCE,
  MAX_NEW_PER_RUN,
} from '../lib/collection-budgets';
import { MAX_NEW_JOBS_PER_RUN, RESULTS_PAGE } from '../lib/jobsch';
import { sourcePolicyFor } from '../lib/source-policy';
import { sourcePoliciesForRole } from '../lib/source-policies';
import {
  buildPublicRefreshFetchers,
  parseRefreshTerms,
  resolvePublicRefreshFetcher,
} from '../lib/public-refresh-scheduler';

/**
 * T12 (F4 scope gate): hosted assessment for jobs.ch, jobup.ch, JobScout24, IamExpat and
 * Undutchables. Pins the assessment in `docs/HOSTED_ADMIN_SOURCES_ASSESSMENT.md` as code so
 * the owner gate and any later T14 implementation drift loudly instead of silently.
 *
 * Synthetic only: mocked fetch where a fetch is needed, no upstream requests, no secrets,
 * no production access. Mirrors the style of `tests/admin-discovery-isolation.test.ts` and
 * `tests/job-adapters.test.ts`.
 */

const T12_KEYS = ['jobs.ch', 'jobup.ch', 'jobscout24.ch', 'iamexpat.nl', 'undutchables.nl'] as const;
const RESTRICTED_FOUR = ['jobs.ch', 'jobup.ch', 'jobscout24.ch', 'undutchables.nl'] as const;

test('all five T12 sources exist with the assessed access tiers', () => {
  for (const key of RESTRICTED_FOUR) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key);
    assert.ok(adapter, `${key} has no adapter`);
    assert.equal(adapter.access, 'restricted', `${key} must stay behind the VPN-only mode`);
  }
  const iamExpat = jobSourceAdapters.find((entry) => entry.key === 'iamexpat.nl');
  assert.ok(iamExpat, 'iamexpat.nl has no adapter');
  assert.equal(iamExpat.access, 'grey-area', 'IamExpat must stay grey-area (no VPN required)');
  assert.equal(iamExpat.adminOnly, true, 'IamExpat must stay administrator-only');
});

test('all five T12 sources are administrator-only in the registry and the enforced gate', () => {
  const hidden = adminOnlySourceKeys();
  for (const key of T12_KEYS) {
    assert.equal(sourcePolicyFor(key)?.audience, 'admin-only', `${key} must be registered admin-only`);
    assert.ok(hidden.has(key), `${key} must be hidden from ordinary accounts by the enforced gate`);
  }
});

test('the T12 availability messages state the local/VPN boundary honestly', () => {
  for (const key of RESTRICTED_FOUR) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key)!;
    assert.match(adapter.availabilityMessage, /local administrator only/i, `${key} message must name the audience`);
    assert.match(adapter.availabilityMessage, /VPN required/i, `${key} message must name the VPN requirement`);
  }
  const iamExpat = jobSourceAdapters.find((entry) => entry.key === 'iamexpat.nl')!;
  assert.match(iamExpat.availabilityMessage, /local administrator only/i);
  assert.match(iamExpat.availabilityMessage, /no VPN required/i);
});

test('the T12 sources are credentialless page-fetch adapters, not keyed integrations', () => {
  // Keyed sources (Adzuna/Careerjet) report unavailable without credentials; these five are
  // unauthenticated public-page readers, so hosted configuration for them is about egress and
  // permission, never about keys.
  for (const key of T12_KEYS) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key)!;
    assert.ok(adapter.search, `${key} must have a listing search`);
    assert.ok(adapter.fetchDetail, `${key} must have a detail parser`);
    assert.equal(adapter.searchDetailed, undefined, `${key} must not use the bulk/keyed path`);
    assert.equal(adapter.hasCredentials, undefined, `${key} must not require credentials`);
  }
});

test('fixed caps and delays for hosted use are the assessed values', () => {
  assert.equal(MAX_NEW_PER_PAGE_SOURCE, 4, 'page-fetching sources stay capped at 4 detail attempts per run');
  assert.equal(MAX_NEW_PER_RUN, 800, 'whole-run ceiling stays 800');
  assert.equal(REQUEST_DELAY_MS, 1200, 'adapter inter-request delay stays 1200ms');
  assert.equal(RESULTS_PAGE, 1, 'search stays on the first results page');
  assert.equal(MAX_NEW_JOBS_PER_RUN, 8, 'legacy jobsch run cap stays recorded');
  const budgets = new CollectionRunBudgets();
  assert.equal(budgets.allowance('jobs.ch', false), MAX_NEW_PER_PAGE_SOURCE);
});

test('refusals stop a source for the run while transient faults stay retryable', () => {
  for (const status of [401, 403, 429, 451]) {
    assert.equal(isAccessRefusal(new Error(`jobs.ch request failed (${status}).`)), true);
  }
  assert.equal(isAccessRefusal(new Error('Undutchables request failed (403).')), true);
  assert.equal(isAccessRefusal(new Error('bot challenge')), true);
  assert.equal(isAccessRefusal(new Error('HTTP 404 Not Found')), false);
  assert.equal(isAccessRefusal(new Error('HTTP 500 Internal Server Error')), false);
  assert.equal(isAccessRefusal(new Error('network request failed')), false);
  // Platform budget exhaustion is reported as incomplete, never as a source refusal (#192).
  assert.equal(isRuntimeBudgetExhausted(new Error('Too many subrequests')), true);
  assert.equal(isAccessRefusal(new Error('Too many subrequests')), false);
});

test('the public refresh refuses every T12 source by name', () => {
  const terms = parseRefreshTerms('data analyst,supply chain');
  for (const key of T12_KEYS) {
    assert.throws(
      () => resolvePublicRefreshFetcher(key, terms),
      /not a public-eligible enabled source/,
      `the public refresh must refuse ${key} outright`,
    );
  }
  const fetchers = buildPublicRefreshFetchers(terms);
  for (const key of T12_KEYS) {
    assert.ok(!(key in fetchers), `${key} must not appear in the public refresh fetcher set`);
  }
});

test('ordinary accounts learn nothing about the T12 sources from the transparency page', () => {
  const ordinary = sourcePoliciesForRole(false);
  assert.equal(ordinary.some((policy) => policy.group === 'Restricted sites'), false);
  const names = ordinary.map((policy) => policy.name).join('\n');
  for (const probe of ['jobs.ch', 'jobup', 'JobScout24', 'IamExpat', 'Undutchables']) {
    assert.doesNotMatch(names, new RegExp(probe, 'i'), `ordinary /sources must not name ${probe}`);
  }
  const admin = sourcePoliciesForRole(true).map((policy) => policy.name).join('\n');
  assert.match(admin, /jobs\.ch/);
});

test('the scrape route keeps the hosted bars: admin-only all-mode plus VPN enforcement', async () => {
  const root = new URL('..', import.meta.url);
  const scrape = await readFile(new URL('app/api/scrape/route.ts', root), 'utf8');
  // Non-admin callers are refused the page-fetching mode outright.
  assert.match(scrape, /requestedAll && user\.role !== 'admin'/);
  // Without the VPN-enforced marker the mode is refused before any source is contacted (409),
  // so VPN absence cannot silently produce a misleading success.
  assert.match(scrape, /requestedAll && !authSecrets\(\)\.vpnEnforced/);
  // Restricted adapters never run in the default authorized mode.
  assert.match(scrape, /adapter\.access !== 'restricted'/);
  // The live response is shaped through the same audience filter as stored runs.
  assert.match(scrape, /visibleSourceReports\(sourceReports, user\.role === 'admin', hiddenForAccount\)/);
  // Refusal handling marks the source blocked with no retry, rotation or fallback.
  assert.match(scrape, /budgets\.markBlocked\(adapter\.key\)/);
  // The no-evasion rule is recorded at the refusal site itself: no proxy rotation, no
  // browser fallback. (Matched, not absent — the comment is the stated prohibition.)
  assert.match(scrape, /no proxy rotation, no browser fallback/);
});

test('the Indeed local experiment stays isolated from the five T12 adapters', () => {
  for (const key of ['indeed-ch', 'indeed-nl']) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key)!;
    assert.equal(adapter.access, 'local-experiment', `${key} must stay a local experiment`);
    assert.equal(adapter.availability, 'disabled', `${key} must stay disabled by default`);
    assert.equal(adapter.adminOnly, true);
    assert.equal(adapter.experimentalIndeed, true);
  }
  for (const key of T12_KEYS) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key)!;
    assert.equal(adapter.experimentalIndeed, undefined, `${key} must not share the Indeed path`);
    assert.notEqual(adapter.access, 'local-experiment', `${key} must not borrow the Indeed exception`);
  }
});
