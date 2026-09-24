import assert from 'node:assert/strict';
import test from 'node:test';
import { jobSourceAdapters } from '../lib/job-adapters';
import { sourceInfoForUrl, sourceJobIdFromUrl } from '../lib/job-identity';
import {
  FREEHIRE_ELIGIBLE_SOURCES,
  FREEHIRE_PAGE_SIZE,
  FREEHIRE_REQUEST_DELAY_MS,
  freehireJobTargetsCountry,
  freehireJobToParsedJob,
  isEligibleFreehireSource,
  MAX_FREEHIRE_PAGES_PER_TERM,
  searchFreehire,
  type FreehireJob,
} from '../lib/freehire';
import {
  recordedEligibleCh,
  recordedEligibleNl,
  recordedIneligibleUpstream,
} from './fixtures/freehire';

test('maps a recorded Swiss record onto the shared job shape', () => {
  const parsed = freehireJobToParsedJob(recordedEligibleCh, 'Switzerland');
  assert.ok(parsed);
  assert.equal(parsed.title, 'Account Executive');
  assert.equal(parsed.company, 'Commvault');
  assert.equal(parsed.location, 'Wallisellen, Switzerland');
  assert.equal(
    parsed.sourceUrl,
    'https://freehire.me/jobs/account-executive-commvault-yumjjeqf',
  );
  assert.equal(parsed.postedAt, '2026-09-24T12:17:22Z');
  // The full advertisement arrives in the search response: no detail fetch needed.
  assert.ok(parsed.descriptionHtml.length > 1000);
  assert.equal(parsed.upstreamSource, 'greenhouse');
  assert.match(parsed.upstreamUrl, /job-boards\.greenhouse\.io\/commvault/);
});

test('maps a recorded Dutch record and keeps its upstream provenance', () => {
  const parsed = freehireJobToParsedJob(recordedEligibleNl, 'Netherlands');
  assert.ok(parsed);
  assert.equal(parsed.company, 'Adyen');
  assert.equal(parsed.location, 'Amsterdam');
  assert.match(parsed.sourceUrl, /^https:\/\/freehire\.me\/jobs\//);
  assert.equal(parsed.upstreamSource, 'greenhouse');
});

test('refuses records with no usable identity, text, or an open posting', () => {
  assert.equal(freehireJobToParsedJob({ ...recordedEligibleCh, public_slug: '' }, 'Switzerland'), null);
  assert.equal(freehireJobToParsedJob({ ...recordedEligibleCh, title: '  ' }, 'Switzerland'), null);
  assert.equal(freehireJobToParsedJob({ ...recordedEligibleCh, description: '' }, 'Switzerland'), null);
  assert.equal(
    freehireJobToParsedJob({ ...recordedEligibleCh, closed_at: '2026-09-20T00:00:00Z' }, 'Switzerland'),
    null,
  );
});

test('falls back to the country name when the record carries no location', () => {
  const parsed = freehireJobToParsedJob({ ...recordedEligibleCh, location: '' }, 'Netherlands');
  assert.equal(parsed?.location, 'Netherlands');
});

test('the allowlist accepts exactly the seven reviewed employer-board upstreams', () => {
  assert.deepEqual([...FREEHIRE_ELIGIBLE_SOURCES].sort(), [
    'ashby', 'greenhouse', 'lever', 'personio', 'recruitee', 'teamtailor', 'workable',
  ]);
  for (const source of FREEHIRE_ELIGIBLE_SOURCES) {
    assert.equal(isEligibleFreehireSource(source), true);
  }
  assert.equal(isEligibleFreehireSource('Greenhouse'), true, 'matching is case-insensitive');
  // Re-served aggregators and unreviewed boards are refused, however well-formed.
  for (const source of ['eures', 'adzuna', 'whatjobs-ch', 'whatjobs-nl', 'workday', 'smartrecruiters',
    'oracle', 'join', 'manatal', '', undefined]) {
    assert.equal(isEligibleFreehireSource(source), false, `${source} must stay outside the allowlist`);
  }
  assert.equal(isEligibleFreehireSource(recordedIneligibleUpstream.source), false);
});

test('country matching reads the record countries, case-insensitively', () => {
  assert.equal(freehireJobTargetsCountry(recordedEligibleCh, 'switzerland'), true);
  assert.equal(freehireJobTargetsCountry(recordedEligibleCh, 'netherlands'), false);
  assert.equal(freehireJobTargetsCountry(recordedEligibleNl, 'netherlands'), true);
  const upper: FreehireJob = { ...recordedEligibleNl, countries: ['NL'] };
  assert.equal(freehireJobTargetsCountry(upper, 'netherlands'), true);
  assert.equal(freehireJobTargetsCountry({}, 'netherlands'), false);
});

test('a FreeHire job URL identifies as a Swiss or Dutch source with a stable id', () => {
  const ch = sourceInfoForUrl('https://freehire.me/jobs/account-executive-commvault-yumjjeqf', 'Wallisellen, Switzerland');
  assert.equal(ch.key, 'freehire-ch');
  assert.equal(ch.country, 'switzerland');
  const nl = sourceInfoForUrl('https://freehire.me/jobs/some-role-adyen-abc123', 'Amsterdam');
  assert.equal(nl.key, 'freehire-nl');
  assert.equal(nl.country, 'netherlands');
  const unknown = sourceInfoForUrl('https://freehire.me/jobs/some-role-xyz', 'London, United Kingdom');
  assert.equal(unknown.country, 'unknown');
  assert.equal(
    sourceJobIdFromUrl('https://freehire.me/jobs/account-executive-commvault-yumjjeqf'),
    'account-executive-commvault-yumjjeqf',
  );
});

test('collection limits stay explicit and bounded', () => {
  assert.equal(FREEHIRE_PAGE_SIZE, 100);
  assert.equal(MAX_FREEHIRE_PAGES_PER_TERM, 4);
  assert.equal(FREEHIRE_REQUEST_DELAY_MS, 400);
});

test('both countries register an enabled full-description adapter', () => {
  for (const [key, country] of [['freehire-ch', 'switzerland'], ['freehire-nl', 'netherlands']] as const) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key);
    assert.ok(adapter, `${key} is not registered`);
    assert.equal(adapter.country, country);
    assert.equal(adapter.access, 'authorized-api');
    assert.equal(adapter.availability, 'enabled');
    assert.equal(adapter.adminOnly, undefined, `${key} must stay reachable by ordinary accounts`);
    assert.equal(typeof adapter.searchDetailed, 'function');
  }
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = realFetch; }, seen };
}

function pageResponse(jobs: FreehireJob[], ignoredParams?: string[]) {
  return Response.json({
    data: jobs,
    meta: { total: jobs.length, limit: 100, offset: 0, ...(ignoredParams ? { ignored_params: ignoredParams } : {}) },
  });
}

test('search pages with the documented filters and stops at the first short page', async () => {
  const stub = stubFetch(() => pageResponse([recordedEligibleCh]));
  try {
    const jobs = await searchFreehire(['analyst'], 'switzerland', 4);
    assert.equal(stub.seen.length, 1, 'a short first page ends paging');
    const url = new URL(stub.seen[0]);
    assert.equal(url.searchParams.get('countries'), 'CH');
    assert.equal(url.searchParams.get('posting_language'), 'en');
    assert.equal(url.searchParams.get('q'), 'analyst');
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('offset'), '0');
    const sources = (url.searchParams.get('source') ?? '').split(',');
    assert.deepEqual(sources.sort(), [...FREEHIRE_ELIGIBLE_SOURCES].sort());
    assert.equal(url.searchParams.get('description_format'), null, 'default HTML is the verbatim description');
    assert.equal(jobs.length, 1);
  } finally {
    stub.restore();
  }
});

test('search refuses ineligible upstreams, wrong-country rows and closed postings', async () => {
  const wrongCountry: FreehireJob = { ...recordedEligibleCh, countries: ['nl'] };
  const closed: FreehireJob = { ...recordedEligibleCh, public_slug: 'closed-x', closed_at: '2026-09-20T00:00:00Z' };
  const stub = stubFetch(() => pageResponse([recordedEligibleCh, recordedIneligibleUpstream, wrongCountry, closed]));
  try {
    const jobs = await searchFreehire([''], 'switzerland', 1);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].upstreamSource, 'greenhouse');
  } finally {
    stub.restore();
  }
});

test('search deduplicates across terms and walks pages', async () => {
  const second: FreehireJob = { ...recordedEligibleNl, public_slug: 'second-adyen-xyz' };
  const full = Array.from({ length: FREEHIRE_PAGE_SIZE }, (_, index) => ({
    ...recordedEligibleNl,
    public_slug: `paged-adyen-${index}`,
  }));
  const stub = stubFetch((url) => {
    if (url.includes('offset=0')) return pageResponse([...full, second].slice(0, FREEHIRE_PAGE_SIZE));
    return pageResponse([second]);
  });
  try {
    const jobs = await searchFreehire(['analyst', 'engineer'], 'netherlands', 2);
    // The full first page continues; the shared `second` record answers on both
    // terms' second pages but is stored once.
    assert.equal(jobs.filter((job) => job.sourceUrl.endsWith('/second-adyen-xyz')).length, 1);
    assert.ok(jobs.length > FREEHIRE_PAGE_SIZE);
  } finally {
    stub.restore();
  }
});

test('search stops on a refusal without retrying', async () => {
  for (const status of [403, 429]) {
    const stub = stubFetch(() => new Response('refused', { status }));
    try {
      await assert.rejects(() => searchFreehire(['analyst'], 'switzerland', 2), /FreeHire request failed/);
      assert.equal(stub.seen.length, 1, `HTTP ${status} must stop the source, never retry it`);
    } finally {
      stub.restore();
    }
  }
});

test('search fails safe when the API ignores one of our filters', async () => {
  const stub = stubFetch(() => pageResponse([recordedEligibleCh], ['source']));
  try {
    // A dropped `source` filter would ingest the entire unreviewed catalogue
    // looking like a real result; fail the term instead of importing it.
    await assert.rejects(() => searchFreehire(['analyst'], 'switzerland', 1), /ignored request params/);
  } finally {
    stub.restore();
  }
});
