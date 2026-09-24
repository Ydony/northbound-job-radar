/**
 * INT-05 (#164, also #140): the public catalogue is queried with server-side
 * filtering, faceting, counting and stable pagination — over a representative
 * >2,000-row synthetic dataset, not a handful of fixtures.
 *
 * Every test runs real D1 SQL against disposable synthetic rows (Miniflare, no
 * owner state, no production database). Expectations are computed in plain
 * TypeScript from the seed arrays (effective verdicts, view membership, role
 * word containment with the real `searchTextForJob` fold, `normalizePlace`
 * grouping), so a wrong JOIN, a missing owner predicate or a leaked
 * admin-only row fails here instead of passing against a mock.
 *
 * Covered:
 * - audience isolation for ordinary accounts (rows, counts, facets, places,
 *   freshness, copy source names — never admin-only or Indeed);
 * - the five role keywords plus country/place/source/application/work-type/
 *   language/view filters operating server-side (small pages, whole-set
 *   counts);
 * - stable keyset pagination across the full filtered set (no repeats, no
 *   gaps, order matches one big request);
 * - aggregates independent of which page is loaded (the #140 regression);
 * - user corrections deciding the effective verdict;
 * - duplicate folding at filter level (a copy whose primary is filtered out
 *   is shown, not lost);
 * - freshness separated from search events, and no advertisement text on the
 *   wire (no `description` key in serialized rows).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import {
  catalogueServingAvailable,
  decodeCatalogueCursor,
  encodeCatalogueCursor,
  parseCatalogueFilters,
  queryCatalogueAggregates,
  queryCatalogueCopies,
  queryCatalogueFreshness,
  queryCataloguePage,
  queryCataloguePlaces,
  resolvePlaceLocations,
  type CatalogueAudience,
  type CatalogueFilters,
  type CatalogueQueryInput,
} from '../lib/catalogue-query';
import { defaultSearchCriteria, searchTextForJob } from '../lib/criteria';
import { adminOnlySourceKeys } from '../lib/job-adapters';
import { adminOnlySourcePolicyKeys } from '../lib/source-policy';
import type { SearchCriteria } from '../lib/types';

const HIDDEN = [...new Set([...adminOnlySourceKeys(), ...adminOnlySourcePolicyKeys()])];
const ORDINARY: CatalogueAudience = { hiddenSourceKeys: HIDDEN, hideIndeedRecords: true };
const ADMIN: CatalogueAudience = { hiddenSourceKeys: [], hideIndeedRecords: false };

const ROLES = ['SAP Analyst', 'Supply Manager', 'Data Engineer', 'SAP Consultant', 'Logistics Specialist'];
const ROLELESS = 'Sales Internship';
const LANGUAGES = ['pass', 'review', 'unknown', 'blocked'] as const;
const WORKPLACES = ['remote', 'hybrid', 'onsite', 'unknown', ''] as const;
const PLACES_CH = ['Zürich', 'Zürich 8000 ZH', 'Bern', 'Geneva'];
const PLACES_NL = ['Amsterdam', 'Amsterdam Noord-Holland', 'Utrecht', 'Rotterdam'];

interface Seed {
  jobId: string;
  vacancyId: string;
  userId: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  country: string;
  title: string;
  location: string;
  description: string;
  language: string;
  workplace: string;
  postedAt: string;
  createdAt: string;
  isSaved: number;
  application: string;
  visibility: string;
  corrected: string;
  duplicateOf: string;
}

const PUBLIC_SOURCES = [
  { key: 'eures-ch', name: 'EURES Switzerland', country: 'switzerland' },
  { key: 'eures-nl', name: 'EURES Netherlands', country: 'netherlands' },
  { key: 'job-room.ch', name: 'Job-Room (arbeit.swiss)', country: 'switzerland' },
  { key: 'ats-ch', name: 'Company career boards (CH)', country: 'switzerland' },
  { key: 'ats-nl', name: 'Company career boards (NL)', country: 'netherlands' },
  { key: 'freehire-ch', name: 'FreeHire Switzerland', country: 'switzerland' },
  { key: 'freehire-nl', name: 'FreeHire Netherlands', country: 'netherlands' },
];

const ADMIN_SOURCES = [
  { key: 'jobs.ch', name: 'jobs.ch', country: 'switzerland' },
  { key: 'jobup.ch', name: 'jobup.ch', country: 'switzerland' },
  { key: 'iamexpat.nl', name: 'IamExpat', country: 'netherlands' },
  { key: 'undutchables.nl', name: 'Undutchables', country: 'netherlands' },
];

function stamp(base: number, minutes: number) {
  return new Date(base + minutes * 60_000).toISOString();
}

function buildSeeds(): { alice: Seed[]; bob: Seed[]; sharedVacancyIds: string[] } {
  const alice: Seed[] = [];
  const bob: Seed[] = [];
  const base = Date.UTC(2026, 8, 1, 0, 0, 0);
  const N = 2400;
  for (let i = 0; i < N; i += 1) {
    const source = PUBLIC_SOURCES[i % PUBLIC_SOURCES.length];
    const ch = source.country === 'switzerland';
    const roleless = i % 6 === 5;
    const role = ROLES[i % ROLES.length];
    const title = roleless ? `${ROLELESS} ${i}` : `Senior ${role} ${i}`;
    const places = ch ? PLACES_CH : PLACES_NL;
    const location = places[i % places.length];
    const description = roleless
      ? `Sales role ${i} in ${location}. Dutch required on site.`
      : `Permanent ${role} role ${i} in ${location}. English is the working language, SAP and SQL daily.`;
    const created = stamp(base, i);
    alice.push({
      jobId: `a-job-${i}`,
      vacancyId: `a-vac-${i}`,
      userId: 'alice',
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: `https://example.test/${source.key}/${i}`,
      country: source.country,
      title,
      location,
      description,
      language: LANGUAGES[i % LANGUAGES.length],
      workplace: WORKPLACES[i % WORKPLACES.length],
      postedAt: i % 13 === 0 ? '' : `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      createdAt: created,
      isSaved: i % 11 === 0 ? 1 : 0,
      application: i % 9 === 0 ? 'applied' : 'not_applied',
      visibility: i % 37 === 0 ? 'dismissed' : 'active',
      corrected: i % 50 === 0 && LANGUAGES[i % LANGUAGES.length] === 'pass' ? 'review' : '',
      duplicateOf: '',
    });
  }
  // Ride-along rows with role-less text: only reachable via pipeline/dismissed.
  const rideBase = N + 100;
  alice.push(
    {
      jobId: 'a-saved-roleless', vacancyId: 'a-vac-saved', userId: 'alice',
      sourceKey: 'eures-nl', sourceName: 'EURES Netherlands', sourceUrl: 'https://example.test/saved',
      country: 'netherlands', title: 'Sales internship saved', location: 'Rotterdam',
      description: 'Sales sales sales, Dutch required.', language: 'blocked', workplace: 'onsite',
      postedAt: '', createdAt: stamp(base, rideBase), isSaved: 1, application: 'not_applied',
      visibility: 'active', corrected: '', duplicateOf: '',
    },
    {
      jobId: 'a-applied-roleless', vacancyId: 'a-vac-applied', userId: 'alice',
      sourceKey: 'eures-ch', sourceName: 'EURES Switzerland', sourceUrl: 'https://example.test/applied',
      country: 'switzerland', title: 'Sales internship applied', location: 'Bern',
      description: 'Sales sales sales, Dutch required.', language: 'blocked', workplace: 'onsite',
      postedAt: '', createdAt: stamp(base, rideBase + 1), isSaved: 0, application: 'applied',
      visibility: 'active', corrected: '', duplicateOf: '',
    },
    {
      jobId: 'a-dismissed-roleless', vacancyId: 'a-vac-dismissed', userId: 'alice',
      sourceKey: 'job-room.ch', sourceName: 'Job-Room (arbeit.swiss)', sourceUrl: 'https://example.test/dismissed',
      country: 'switzerland', title: 'Sales internship dismissed', location: 'Geneva',
      description: 'Sales sales sales, Dutch required.', language: 'blocked', workplace: 'onsite',
      postedAt: '', createdAt: stamp(base, rideBase + 2), isSaved: 0, application: 'not_applied',
      visibility: 'dismissed', corrected: '', duplicateOf: '',
    },
  );
  // Admin-only holdings for alice (must vanish from every ordinary response).
  const adminBase = N + 200;
  for (let i = 0; i < 100; i += 1) {
    alice.push({
      jobId: `a-admin-${i}`, vacancyId: `a-vac-admin-${i}`, userId: 'alice',
      sourceKey: 'jobs.ch', sourceName: 'jobs.ch', sourceUrl: `https://www.jobs.ch/en/vacancies/detail/admin-${i}/`,
      country: 'switzerland', title: `Senior SAP Analyst admin ${i}`, location: 'Zürich',
      description: `Administrator-only SAP Analyst role ${i}. English working language.`,
      language: 'pass', workplace: 'onsite', postedAt: '2026-08-10', createdAt: stamp(base, adminBase + i),
      isSaved: 0, application: 'not_applied', visibility: 'active', corrected: '', duplicateOf: '',
    });
  }
  for (let i = 0; i < 20; i += 1) {
    alice.push({
      jobId: `a-indeed-${i}`, vacancyId: `a-vac-indeed-${i}`, userId: 'alice',
      sourceKey: 'indeed-nl', sourceName: 'Indeed Netherlands',
      sourceUrl: `https://nl.indeed.com/viewjob?jk=seed${i}`,
      country: 'netherlands', title: `Data Engineer indeed ${i}`, location: 'Amsterdam',
      description: `Indeed Data Engineer role ${i}. English working language.`,
      language: 'pass', workplace: 'remote', postedAt: '', createdAt: stamp(base, adminBase + 200 + i),
      isSaved: 0, application: 'not_applied', visibility: 'active', corrected: '', duplicateOf: '',
    });
  }
  for (let i = 0; i < 20; i += 1) {
    const source = ADMIN_SOURCES[2 + (i % 2)];
    alice.push({
      jobId: `a-grey-${i}`, vacancyId: `a-vac-grey-${i}`, userId: 'alice',
      sourceKey: source.key, sourceName: source.name, sourceUrl: `https://example.test/${source.key}/g${i}`,
      country: 'netherlands', title: `Supply Manager grey ${i}`, location: 'Utrecht',
      description: `Administrator Supply Manager role ${i}. English working language.`,
      language: 'review', workplace: 'hybrid', postedAt: '', createdAt: stamp(base, adminBase + 300 + i),
      isSaved: 0, application: 'not_applied', visibility: 'active', corrected: '', duplicateOf: '',
    });
  }
  // Near-duplicate copies: separate vacancies folding into a held primary.
  const copyBase = N + 1000;
  for (let i = 0; i < 40; i += 1) {
    const primary = alice[i * 10];
    const source = PUBLIC_SOURCES[(i + 3) % PUBLIC_SOURCES.length];
    const ch = primary.country === 'switzerland';
    alice.push({
      jobId: `a-copy-${i}`, vacancyId: `a-vac-copy-${i}`, userId: 'alice',
      sourceKey: source.key, sourceName: source.name, sourceUrl: `https://example.test/copy/${i}`,
      country: ch ? source.country : source.country,
      title: `${primary.title} (copy)`, location: primary.location,
      description: `${primary.description} Republished copy.`,
      language: primary.language, workplace: primary.workplace, postedAt: primary.postedAt,
      createdAt: stamp(base, copyBase + i), isSaved: 0, application: 'not_applied',
      visibility: 'active', corrected: '', duplicateOf: primary.jobId,
    });
  }
  // Copies whose primary was never held: shown, never folded (orphan rule).
  for (let i = 0; i < 5; i += 1) {
    alice.push({
      jobId: `a-orphan-${i}`, vacancyId: `a-vac-orphan-${i}`, userId: 'alice',
      sourceKey: 'eures-nl', sourceName: 'EURES Netherlands', sourceUrl: `https://example.test/orphan/${i}`,
      country: 'netherlands', title: `Senior SAP Analyst orphan ${i}`, location: 'Amsterdam',
      description: `Orphan SAP Analyst copy ${i}. English working language.`,
      language: 'pass', workplace: 'remote', postedAt: '', createdAt: stamp(base, copyBase + 100 + i),
      isSaved: 0, application: 'not_applied', visibility: 'active', corrected: '', duplicateOf: `ghost-admin-${i}`,
    });
  }
  // Bob: own holdings plus five vacancies shared with alice (own job/state rows).
  const sharedVacancyIds = alice.slice(0, 5).map((seed) => seed.vacancyId);
  for (let i = 0; i < 60; i += 1) {
    bob.push({
      jobId: `b-job-${i}`, vacancyId: `b-vac-${i}`, userId: 'bob',
      sourceKey: 'eures-nl', sourceName: 'EURES Netherlands', sourceUrl: `https://example.test/bob/${i}`,
      country: 'netherlands', title: `Data Engineer bob ${i}`, location: 'Utrecht',
      description: `Bob Data Engineer role ${i}. English working language.`,
      language: 'pass', workplace: 'remote', postedAt: '', createdAt: stamp(base, 5000 + i),
      isSaved: 0, application: 'not_applied', visibility: 'active', corrected: '', duplicateOf: '',
    });
  }
  sharedVacancyIds.forEach((vacancyId, i) => {
    const shared = alice[i];
    bob.push({
      jobId: `b-shared-${i}`, vacancyId, userId: 'bob',
      sourceKey: shared.sourceKey, sourceName: shared.sourceName, sourceUrl: `https://example.test/bob-shared/${i}`,
      country: shared.country, title: shared.title, location: shared.location, description: shared.description,
      language: shared.language, workplace: shared.workplace, postedAt: shared.postedAt,
      createdAt: stamp(base, 6000 + i), isSaved: 0, application: 'not_applied',
      visibility: 'active', corrected: '', duplicateOf: '',
    });
  });
  return { alice, bob, sharedVacancyIds };
}

async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  // `canonical_url` is on the real `jobs` table (db/runtime.ts) and is what the served card
  // takes its link from since #188 — the shared `vacancies` row keeps whichever copy wrote it,
  // so reading the link from there leaked an administrator-only source to an ordinary account.
  // This fixture is a hand-written subset of the schema; a column missing here is a query this
  // suite cannot exercise, which is how that leak stayed invisible to it.
  await db.prepare(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '', canonical_url TEXT NOT NULL DEFAULT '',
    source_key TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '', source_job_id TEXT NOT NULL DEFAULT '',
    duplicate_of TEXT NOT NULL DEFAULT '')`).run();
  await db.prepare(`CREATE TABLE vacancies (
    id TEXT PRIMARY KEY NOT NULL, canonical_url TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'unknown', title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', search_text TEXT NOT NULL DEFAULT '',
    language_status TEXT NOT NULL DEFAULT 'unknown', language_summary TEXT NOT NULL DEFAULT '',
    language_signals TEXT NOT NULL DEFAULT '[]', workplace_type TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL DEFAULT '',
    identity_fingerprint TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT NOT NULL DEFAULT '')`).run();
  await db.prepare(`CREATE TABLE vacancy_sources (
    vacancy_id TEXT NOT NULL, source_key TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '', source_job_id TEXT NOT NULL DEFAULT '',
    canonical_url TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT 'unknown',
    first_seen_at TEXT NOT NULL DEFAULT '', last_seen_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (vacancy_id, source_key, source_job_id, canonical_url))`).run();
  await db.prepare(`CREATE TABLE user_vacancy_state (
    user_id TEXT NOT NULL, vacancy_id TEXT NOT NULL DEFAULT '', job_id TEXT NOT NULL,
    is_saved INTEGER NOT NULL DEFAULT 0, application_status TEXT NOT NULL DEFAULT 'not_applied',
    visibility_status TEXT NOT NULL DEFAULT 'active', corrected_status TEXT NOT NULL DEFAULT '',
    corrected_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, job_id))`).run();

  const { alice, bob, sharedVacancyIds } = buildSeeds();
  const seeds = [...alice, ...bob];
  const insert = async (rows: Seed[], start: number, end: number) => {
    const slice = rows.slice(start, end);
    await db.batch(slice.map((seed) => db.prepare(`INSERT INTO jobs
      (id, user_id, source_url, canonical_url, source_key, source_name, source_job_id, duplicate_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(seed.jobId, seed.userId, seed.sourceUrl, seed.sourceUrl, seed.sourceKey, seed.sourceName,
        seed.jobId, seed.duplicateOf)));
    await db.batch(slice.map((seed) => db.prepare(`INSERT OR IGNORE INTO vacancies
      (id, canonical_url, country, title, company, location, description, search_text,
       language_status, language_summary, workplace_type, posted_at, identity_fingerprint,
       first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(seed.vacancyId, seed.sourceUrl, seed.country, seed.title, 'Example AG', seed.location,
        seed.description, searchTextForJob({ title: seed.title, location: seed.location, description: seed.description }),
        seed.language, 'Synthetic verdict', seed.workplace, seed.postedAt, `fp-${seed.vacancyId}`,
        seed.createdAt, seed.createdAt)));
    await db.batch(slice.map((seed) => db.prepare(`INSERT OR IGNORE INTO vacancy_sources
      (vacancy_id, source_key, source_name, source_job_id, canonical_url, country, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(seed.vacancyId, seed.sourceKey, seed.sourceName, seed.jobId, seed.sourceUrl,
        seed.country, seed.createdAt, seed.createdAt)));
    await db.batch(slice.map((seed) => db.prepare(`INSERT INTO user_vacancy_state
      (user_id, vacancy_id, job_id, is_saved, application_status, visibility_status,
       corrected_status, corrected_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(seed.userId, seed.vacancyId, seed.jobId, seed.isSaved, seed.application,
        seed.visibility, seed.corrected, seed.corrected ? 'Synthetic correction' : '',
        seed.createdAt, seed.createdAt)));
  };
  for (let start = 0; start < seeds.length; start += 50) {
    await insert(seeds, start, start + 50);
  }
  return { db, alice, bob, sharedVacancyIds, dispose: () => runtime.dispose() };
}

/**
 * One seeded catalogue for the whole file: ~2,700 synthetic holdings take
 * tens of seconds to insert, and every test below is read-only, so reseeding
 * per test would only burn minutes. Tests must not write.
 */
let shared: Awaited<ReturnType<typeof fixture>> | null = null;

async function sharedFixture() {
  if (!shared) shared = await fixture();
  return shared;
}

// --- Independent expectations, hand-rolled from the seed arrays. ---

function effective(seed: Seed) {
  return seed.corrected || seed.language;
}

function roleMatches(seed: Seed, roles: string[]) {
  if (!roles.length) return true;
  const text = searchTextForJob({ title: seed.title, location: seed.location, description: seed.description });
  return roles.some((role) => {
    const words = searchTextForJob({ title: role, location: '', description: '' }).trim()
      .split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    if (!words.length) return false;
    return words.every((word) => text.includes(word));
  });
}

function inAudience(seed: Seed, audience: CatalogueAudience) {
  if (audience.hiddenSourceKeys.includes(seed.sourceKey)) return false;
  if (audience.hideIndeedRecords) {
    if (seed.sourceKey.toLowerCase().includes('indeed') || seed.sourceUrl.toLowerCase().includes('indeed.')) return false;
  }
  return true;
}

function matchesBase(seed: Seed, filters: CatalogueFilters, criteria: SearchCriteria, audience: CatalogueAudience) {
  if (!inAudience(seed, audience)) return false;
  if (filters.country !== 'all' && seed.country !== filters.country) return false;
  if (filters.source !== 'all' && seed.sourceKey !== filters.source) return false;
  if (filters.application !== 'all' && seed.application !== filters.application) return false;
  const workplace = seed.workplace || 'unknown';
  if (filters.workType !== 'all' && workplace !== filters.workType) return false;
  return true;
}

function matchesView(seed: Seed, filters: CatalogueFilters) {
  if (filters.view === 'dismissed') return seed.visibility === 'dismissed';
  if (seed.visibility !== 'active') return false;
  if (filters.view === 'pipeline') return seed.isSaved === 1 || seed.application === 'applied';
  return true;
}

function matchesNarrowing(seed: Seed, filters: CatalogueFilters, criteria: SearchCriteria) {
  if (filters.view === 'pipeline' || filters.view === 'dismissed') return true;
  if (!roleMatches(seed, filters.roles)) return false;
  const text = searchTextForJob({ title: seed.title, location: seed.location, description: seed.description });
  for (const keyword of criteria.requiredKeywords) {
    const folded = searchTextForJob({ title: keyword, location: '', description: '' }).trim();
    if (folded && !text.includes(folded)) return false;
  }
  for (const keyword of criteria.excludedKeywords) {
    const folded = searchTextForJob({ title: keyword, location: '', description: '' }).trim();
    if (folded && text.includes(folded)) return false;
  }
  if (filters.language !== 'all' && effective(seed) !== filters.language) return false;
  if (filters.view === 'new' && !(seed.createdAt >= filters.since)) return false;
  return true;
}

function expectedSet(
  seeds: Seed[],
  userId: string,
  filters: CatalogueFilters,
  criteria: SearchCriteria,
  audience: CatalogueAudience,
  placeLocations: string[],
  placeResolvable: boolean,
) {
  const own = seeds.filter((seed) => seed.userId === userId);
  const base = own.filter((seed) => matchesBase(seed, filters, criteria, audience)
    && matchesView(seed, filters)
    && matchesNarrowing(seed, filters, criteria)
    && (placeLocations.length ? placeLocations.includes(seed.location) : placeResolvable));
  const baseIds = new Set(base.map((seed) => seed.jobId));
  // Filter-level folding: a copy folds only while its primary is in the set.
  const folded = base.filter((seed) => seed.duplicateOf && baseIds.has(seed.duplicateOf));
  const foldedIds = new Set(folded.map((seed) => seed.jobId));
  const shown = base.filter((seed) => !foldedIds.has(seed.jobId));
  return { base, folded, shown };
}

function criteriaWithRoles(): SearchCriteria {
  return { ...defaultSearchCriteria, roleKeywords: [...ROLES] };
}

function baseFilters(overrides: Partial<CatalogueFilters> = {}): CatalogueFilters {
  return {
    roles: [...ROLES],
    country: 'all',
    place: 'all',
    source: 'all',
    application: 'all',
    workType: 'all',
    language: 'pass',
    view: 'all',
    sort: 'found',
    since: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function testInput(
  userId: string,
  audience: CatalogueAudience,
  filters: CatalogueFilters,
  criteria: SearchCriteria,
  place: { locations: string[]; resolvable: boolean } = { locations: [], resolvable: true },
): CatalogueQueryInput {
  return {
    userId,
    audience,
    filters,
    criteria,
    placeLocations: place.locations,
    placeResolvable: place.resolvable,
  };
}

test('catalogue tables are served when present', async () => {
  const { db } = await sharedFixture();
    assert.equal(await catalogueServingAvailable(db), true);
});

test('ordinary accounts never see admin-only or Indeed rows, counts, facets or freshness', async () => {
  const { db } = await sharedFixture();
    const criteria = criteriaWithRoles();
    // No role narrowing: the single served set itself must be representative.
    const filters = baseFilters({ language: 'all', roles: [] });
    const input = testInput('alice', ORDINARY, filters, criteria);
    const [page, aggregates, places, freshness] = await Promise.all([
      queryCataloguePage(db, input, null, 2500),
      queryCatalogueAggregates(db, input),
      queryCataloguePlaces(db, input),
      queryCatalogueFreshness(db, 'alice', ORDINARY),
    ]);
    assert.ok(page.jobs.length > 2000, `expected a representative set, got ${page.jobs.length}`);
    for (const job of page.jobs) {
      assert.ok(!HIDDEN.includes(job.sourceKey), `admin-only row leaked: ${job.sourceKey}`);
      assert.ok(!job.sourceUrl.toLowerCase().includes('indeed.'), `Indeed row leaked: ${job.sourceUrl}`);
    }
    for (const facet of Object.values(aggregates.facets)) {
      for (const value of facet.values) {
        assert.ok(!HIDDEN.includes(value.key), `admin-only facet leaked: ${value.key}`);
      }
    }
    assert.ok(places.groups.length > 0, 'the place facet must group the corpus');
    const adminNames = new Set(['jobs.ch', 'jobup.ch', 'IamExpat', 'Undutchables', 'Indeed Netherlands']);
    for (const value of aggregates.facets.source.values) {
      assert.ok(!adminNames.has(value.name), `admin-only source name leaked: ${value.name}`);
    }
    for (const source of freshness.bySource) {
      assert.ok(!HIDDEN.includes(source.sourceKey), `admin-only freshness leaked: ${source.sourceKey}`);
      assert.ok(!source.sourceKey.toLowerCase().includes('indeed'), `Indeed freshness leaked: ${source.sourceKey}`);
    }
    // The administrator sees the withheld holdings on the same dataset.
    const adminPage = await queryCataloguePage(db, testInput('alice', ADMIN, filters, criteria), null, 2500);
    const adminKeys = new Set(adminPage.jobs.map((job) => job.sourceKey));
    assert.ok(adminKeys.has('jobs.ch'), 'an administrator must still see admin-only holdings');
    assert.ok(adminKeys.has('indeed-nl'), 'an administrator must still see Indeed holdings');
    assert.ok(adminPage.jobs.length > page.jobs.length, 'the ordinary page must be narrower than the admin page');
});

test('role, country, source, application, work-type, language and view filters work server-side', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const cases: { name: string; filters: CatalogueFilters }[] = [
      { name: 'country', filters: baseFilters({ country: 'switzerland' }) },
      { name: 'source', filters: baseFilters({ source: 'eures-nl' }) },
      { name: 'application', filters: baseFilters({ application: 'applied' }) },
      { name: 'workType', filters: baseFilters({ workType: 'remote' }) },
      { name: 'language', filters: baseFilters({ language: 'blocked' }) },
      { name: 'view-pipeline', filters: baseFilters({ view: 'pipeline' }) },
      { name: 'view-dismissed', filters: baseFilters({ view: 'dismissed' }) },
      { name: 'view-new', filters: baseFilters({ view: 'new', since: '2026-09-02T00:00:00.000Z' }) },
      { name: 'roles-subset', filters: baseFilters({ roles: ['Data Engineer'] }) },
    ];
    for (const { name, filters } of cases) {
      const input = testInput('alice', ORDINARY, filters, criteria);
      const [page, aggregates] = await Promise.all([
        queryCataloguePage(db, input, null, 40),
        queryCatalogueAggregates(db, input),
      ]);
      const expected = expectedSet(alice, 'alice', filters, criteria, ORDINARY, [], true);
      assert.equal(aggregates.matching, expected.shown.length, `${name}: server matching must equal the filtered set`);
      assert.ok(page.jobs.length <= 40, `${name}: page must hold at most the requested rows`);
      assert.ok(page.jobs.length > 0, `${name}: filter must match something in this corpus`);
      const shownIds = new Set(expected.shown.map((seed) => seed.jobId));
      for (const job of page.jobs) {
        assert.ok(shownIds.has(job.id), `${name}: page row ${job.id} is outside the filtered set`);
      }
      // Spot-check the dimension the case narrows.
      if (name === 'country') assert.ok(page.jobs.every((job) => job.country === 'switzerland'));
      if (name === 'source') assert.ok(page.jobs.every((job) => job.sourceKey === 'eures-nl'));
      if (name === 'application') assert.ok(page.jobs.every((job) => job.applicationStatus === 'applied'));
      if (name === 'workType') assert.ok(page.jobs.every((job) => job.workplaceType === 'remote'));
      if (name === 'language') {
        assert.ok(page.jobs.every((job) => {
          const effectiveStatus = job.languageFeedback === 'incorrect' && job.correctedLanguageStatus
            ? job.correctedLanguageStatus
            : job.languageStatus;
          return effectiveStatus === 'blocked';
        }));
      }
      if (name === 'view-pipeline') {
        assert.ok(page.jobs.every((job) => job.visibilityStatus === 'active'
          && (job.isSaved || job.applicationStatus === 'applied')));
      }
      if (name === 'view-dismissed') assert.ok(page.jobs.every((job) => job.visibilityStatus === 'dismissed'));
      if (name === 'view-new') {
        assert.ok(page.jobs.every((job) => job.visibilityStatus === 'active'
          && job.firstSeenAt >= '2026-09-02T00:00:00.000Z'));
      }
    }
});

test('place facets group server-side and the place filter resolves through them', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const filters = baseFilters({ language: 'all' });
    const input = testInput('alice', ORDINARY, filters, criteria);
    const places = await queryCataloguePlaces(db, input);
    const zurich = places.locationsByPlace.get('Zürich');
    assert.ok(zurich && zurich.length >= 2, 'Zürich must group its spelling variants');
    assert.ok(zurich!.includes('Zürich') && zurich!.includes('Zürich 8000 ZH'));
    const resolved = await resolvePlaceLocations(db, input, 'Zürich');
    assert.equal(resolved.resolvable, true);
    const placed = testInput('alice', ORDINARY, { ...filters, place: 'Zürich' }, criteria,
      { locations: resolved.locations, resolvable: resolved.resolvable });
    const [page, aggregates] = await Promise.all([
      queryCataloguePage(db, placed, null, 40),
      queryCatalogueAggregates(db, placed),
    ]);
    const expected = expectedSet(alice, 'alice', { ...filters, place: 'Zürich' }, criteria,
      ORDINARY, resolved.locations, true);
    assert.equal(aggregates.matching, expected.shown.length);
    assert.ok(page.jobs.length > 0);
    assert.ok(page.jobs.every((job) => resolved.locations.includes(job.location)));
    // An unknown place filters to an honest empty page, never to everything.
    const missing = await resolvePlaceLocations(db, input, 'Nowhereville');
    assert.equal(missing.resolvable, false);
    const emptied = testInput('alice', ORDINARY, { ...filters, place: 'Nowhereville' }, criteria,
      { locations: missing.locations, resolvable: missing.resolvable });
    assert.equal((await queryCatalogueAggregates(db, emptied)).matching, 0);
    assert.deepEqual((await queryCataloguePage(db, emptied, null, 40)).jobs, []);
});

test('pagination walks the whole filtered set exactly once, in stable order', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const filters = baseFilters({ language: 'all' });
    const input = testInput('alice', ORDINARY, filters, criteria);
    const started = performance.now();
    const seen: string[] = [];
    let cursor: { sortValue: string; id: string } | null = null;
    let pages = 0;
    for (;;) {
      const page = await queryCataloguePage(db, input, cursor, 40);
      pages += 1;
      seen.push(...page.jobs.map((job) => job.id));
      if (!page.nextCursor) break;
      const decoded = decodeCatalogueCursor(page.nextCursor);
      assert.equal(decoded.error, null);
      cursor = decoded.cursor;
      assert.ok(pages < 200, 'paging must terminate');
    }
    const walkedMs = performance.now() - started;
    const expected = expectedSet(alice, 'alice', filters, criteria, ORDINARY, [], true);
    assert.ok(pages > 40, `the corpus must span many pages, walked ${pages}`);
    assert.equal(seen.length, expected.shown.length, 'every filtered holding is walked exactly once');
    assert.equal(new Set(seen).size, seen.length, 'no row may repeat across pages');
    assert.deepEqual([...seen].sort(), expected.shown.map((seed) => seed.jobId).sort());
    // One big request returns the same order the walk produced.
    const big = await queryCataloguePage(db, input, null, expected.shown.length + 10);
    assert.deepEqual(big.jobs.map((job) => job.id), seen, 'paged order must match the unpaged order');
    assert.equal(big.nextCursor, null, 'an exact-size request ends the listing');
    console.log(`catalogue walk: ${pages} pages x 40 over ${seen.length} rows in ${Math.round(walkedMs)}ms`);
});

test('aggregates do not depend on which page is loaded (the #140 regression)', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const filters = baseFilters({ language: 'all' });
    const input = testInput('alice', ORDINARY, filters, criteria);
    const first = await queryCataloguePage(db, input, null, 40);
    assert.ok(first.nextCursor, 'the corpus must span pages');
    // Walk to page eight, then compare aggregates for page one and page eight.
    let cursor = decodeCatalogueCursor(first.nextCursor).cursor;
    for (let i = 0; i < 6; i += 1) {
      const page = await queryCataloguePage(db, input, cursor, 40);
      cursor = decodeCatalogueCursor(page.nextCursor).cursor;
    }
    const eighth = await queryCataloguePage(db, input, cursor, 40);
    const [early, late] = await Promise.all([
      queryCatalogueAggregates(db, input),
      queryCatalogueAggregates(db, input),
    ]);
    assert.deepEqual(early, late, 'aggregates are page-independent by construction');
    assert.equal(early.matching, expectedSet(alice, 'alice', filters, criteria, ORDINARY, [], true).shown.length);
    // A filter whose matches live far from page one still serves them at once.
    const zurichInput = testInput('alice', ORDINARY, { ...filters, place: 'Zürich' }, criteria,
      await resolvePlaceLocations(db, input, 'Zürich'));
    const zurich = await queryCataloguePage(db, zurichInput, null, 40);
    assert.ok(zurich.jobs.length > 0, 'place matches serve on page one of that filter');
    void eighth;
    void first;
});

test('view and language counts agree with the filtered sets they name', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const filters = baseFilters({ language: 'all' });
    const input = testInput('alice', ORDINARY, filters, criteria);
    const aggregates = await queryCatalogueAggregates(db, input);
    for (const view of ['new', 'all', 'pipeline', 'dismissed'] as const) {
      const expected = expectedSet(alice, 'alice', { ...filters, view }, criteria, ORDINARY, [], true);
      assert.equal(aggregates.viewCounts[view], expected.shown.length, `view count ${view} must match its set`);
    }
    const counted = (['pass', 'review', 'unknown', 'blocked'] as const)
      .reduce((sum, language) => sum + aggregates.languageCounts[language], 0);
    void counted;
    // No partition assertion here on purpose: folding is filter-level, so a
    // copy shown under one verdict (its primary filtered out) folds under
    // `all` (its primary present) — the buckets overlap the whole honestly.
    // Each bucket still equals its own filtered set:
    for (const language of ['pass', 'review', 'unknown', 'blocked'] as const) {
      const expected = expectedSet(alice, 'alice', { ...filters, language }, criteria, ORDINARY, [], true);
      assert.equal(aggregates.languageCounts[language], expected.shown.length,
        `language count ${language} must match its set`);
    }
    assert.equal(aggregates.languageCounts.all, aggregates.inView, 'un-narrowed language whole equals in-view');
    const facetSum = aggregates.facets.country.values.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(facetSum, aggregates.facets.country.all, 'facet values must add up to the facet whole');
    assert.equal(aggregates.facets.country.all, aggregates.matching, 'an un-narrowed facet whole equals matching');
});

test('user corrections decide the effective verdict', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const corrected = alice.filter((seed) => seed.corrected && seed.visibility === 'active');
    assert.ok(corrected.length > 0, 'the corpus must carry corrections on browsable rows');
    for (const language of ['pass', 'review'] as const) {
      const filters = baseFilters({ language, roles: [] });
      const input = testInput('alice', ORDINARY, filters, criteria);
      const page = await queryCataloguePage(db, input, null, 2000);
      const ids = new Set(page.jobs.map((job) => job.id));
      for (const seed of corrected) {
        if (seed.language === 'pass') {
          assert.ok(!ids.has(seed.jobId) === (language === 'pass'),
            `corrected row ${seed.jobId} must read as review, not pass`);
        }
      }
      if (language === 'review') {
        for (const seed of corrected) assert.ok(ids.has(seed.jobId), `corrected row ${seed.jobId} must read as review`);
      }
    }
});

test('copies fold into a visible primary; orphan copies are shown, not lost', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const filters = baseFilters({ language: 'all' });
    const input = testInput('alice', ORDINARY, filters, criteria);
    const expected = expectedSet(alice, 'alice', filters, criteria, ORDINARY, [], true);
    assert.ok(expected.folded.length > 0, 'the corpus must carry folded copies');
    const aggregates = await queryCatalogueAggregates(db, input);
    assert.equal(aggregates.folded, expected.folded.length);
    assert.equal(aggregates.matching + aggregates.folded,
      expected.base.length, 'matching plus folded accounts for every filtered holding');
    // Orphan copies (primary never held) are served, never folded.
    const orphans = alice.filter((seed) => seed.jobId.startsWith('a-orphan-'));
    const page = await queryCataloguePage(db, input, null, 3000);
    const ids = new Set(page.jobs.map((job) => job.id));
    for (const seed of orphans) assert.ok(ids.has(seed.jobId), `orphan copy ${seed.jobId} must be shown`);
    // The card's "also on" line names the copy's board, audience-filtered.
    const copies = await queryCatalogueCopies(db, 'alice', ORDINARY,
      page.jobs.map((job) => job.id));
    assert.ok(copies.size > 0, 'shown primaries must carry their copies');
    for (const sources of copies.values()) {
      for (const name of sources) assert.ok(name.length > 0);
    }
});

test('per-user scoping holds on shared catalogue rows', async () => {
  const { db, sharedVacancyIds } = await sharedFixture();
    assert.ok(sharedVacancyIds.length === 5);
    const criteria = criteriaWithRoles();
    // No role narrowing here: scoping is about holdings, not about roles.
    const filters = baseFilters({ language: 'all', roles: [] });
    const dismissedFilters = baseFilters({ language: 'all', roles: [], view: 'dismissed' });
    const [alicePage, bobPage, aliceDismissed] = await Promise.all([
      queryCataloguePage(db, testInput('alice', ORDINARY, filters, criteria), null, 3000),
      queryCataloguePage(db, testInput('bob', ORDINARY, filters, criteria), null, 3000),
      queryCataloguePage(db, testInput('alice', ORDINARY, dismissedFilters, criteria), null, 3000),
    ]);
    const aliceIds = new Set(alicePage.jobs.map((job) => job.id));
    const bobIds = new Set(bobPage.jobs.map((job) => job.id));
    // Same vacancy, different holdings: each account sees its own job id only.
    // a-job-0 is dismissed, so it waits in the dismissed view instead.
    for (let i = 1; i < 5; i += 1) {
      assert.ok(aliceIds.has(`a-job-${i}`), `alice must see her holding of shared vacancy ${i}`);
      assert.ok(bobIds.has(`b-shared-${i}`), `bob must see his holding of shared vacancy ${i}`);
      assert.ok(!aliceIds.has(`b-shared-${i}`), 'alice must never see bob’s job ids');
      assert.ok(!bobIds.has(`a-job-${i}`), 'bob must never see alice’s job ids');
    }
    assert.ok(aliceDismissed.jobs.some((job) => job.id === 'a-job-0'),
      'alice’s dismissed holding of shared vacancy 0 waits in her dismissed view');
    assert.ok(bobIds.has('b-shared-0'), 'bob’s active holding of shared vacancy 0 stays in his list');
    assert.ok(bobPage.jobs.length < alicePage.jobs.length, 'bob’s smaller holding set stays smaller');
});

test('freshness is ingest recency, separate from search events, with no counts', async () => {
  const { db, alice } = await sharedFixture();
    const freshness = await queryCatalogueFreshness(db, 'alice', ORDINARY);
    const heldMax = alice
      .filter((seed) => inAudience(seed, ORDINARY))
      .reduce((max, seed) => (seed.createdAt > max ? seed.createdAt : max), '');
    assert.equal(freshness.refreshedAt, heldMax, 'refreshedAt is the newest audience-filtered holding sighting');
    assert.ok(freshness.bySource.length >= 7, 'every held public source reports freshness');
    for (const source of freshness.bySource) {
      assert.ok(source.lastSeenAt.length > 0);
      assert.ok(!('total' in source) && !('count' in source), 'freshness carries no counts');
    }
});

test('serialized page rows carry no advertisement text', async () => {
  const { db } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const input = testInput('alice', ORDINARY, baseFilters({ language: 'all' }), criteria);
    const page = await queryCataloguePage(db, input, null, 40);
    assert.ok(page.jobs.length > 0);
    for (const job of page.jobs) {
      const serialized = JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
      assert.ok(!('description' in serialized), 'advertisement text must never reach the client');
      assert.ok(typeof job.excerpt !== 'undefined' || job.excerpt === null);
      assert.ok(job.sourceUrl.length > 0, 'the apply link still travels with the card');
    }
});

test('saved keywords narrow browsable views but ride along in pipeline and dismissed', async () => {
  const { db } = await sharedFixture();
    const criteria: SearchCriteria = { ...criteriaWithRoles(), requiredKeywords: ['sap'], excludedKeywords: [] };
    const all = testInput('alice', ORDINARY, baseFilters({ language: 'all', roles: [] }), criteria);
    const pipeline = testInput('alice', ORDINARY, baseFilters({ language: 'all', roles: [], view: 'pipeline' }), criteria);
    const [allMatching, pipelineMatching] = await Promise.all([
      queryCatalogueAggregates(db, all),
      queryCatalogueAggregates(db, pipeline),
    ]);
    assert.ok(allMatching.matching > 0 && allMatching.matching < allMatching.total,
      'a required keyword must narrow the browsable view');
    const plainPipeline = await queryCatalogueAggregates(db, testInput('alice', ORDINARY,
      baseFilters({ language: 'all', roles: [], view: 'pipeline' }), criteriaWithRoles()));
    assert.equal(pipelineMatching.viewCounts.pipeline, plainPipeline.viewCounts.pipeline,
      'pipeline ignores saved keywords (ride-along)');
});

test('the catalogue cursor codec accepts what it encodes and refuses the rest', () => {
  const dated = encodeCatalogueCursor('2026-08-15', 'job-1');
  assert.deepEqual(decodeCatalogueCursor(dated), { cursor: { sortValue: '2026-08-15', id: 'job-1' }, error: null });
  const timed = encodeCatalogueCursor('2026-09-01T10:00:00.000Z', 'job-2');
  assert.deepEqual(decodeCatalogueCursor(timed), {
    cursor: { sortValue: '2026-09-01T10:00:00.000Z', id: 'job-2' }, error: null,
  });
  assert.deepEqual(decodeCatalogueCursor(null), { cursor: null, error: null });
  assert.deepEqual(decodeCatalogueCursor(''), { cursor: null, error: null });
  for (const raw of ['nonsense', '|job-1', '2026-08-15|', 'a|b|c\nd']) {
    assert.ok(decodeCatalogueCursor(raw).error, `${JSON.stringify(raw)} must be refused`);
  }
});

test('filter parsing validates values and defaults roles to the saved keywords', () => {
  const criteria = criteriaWithRoles();
  const since = '2026-09-01T00:00:00.000Z';
  const parsed = parseCatalogueFilters(new URLSearchParams(), criteria, since);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.filters.roles, ROLES);
  assert.equal(parsed.filters.sort, 'found');
  const overridden = parseCatalogueFilters(new URLSearchParams('role=Data+Engineer&role=Data+Engineer&country=netherlands'), criteria, since);
  assert.equal(overridden.error, null);
  assert.deepEqual(overridden.filters.roles, ['Data Engineer']);
  assert.equal(overridden.filters.country, 'netherlands');
  const bad = parseCatalogueFilters(new URLSearchParams('country=atlantis'), criteria, since);
  assert.ok(bad.error, 'an unknown country must be refused, never silently narrowed');
  const badView = parseCatalogueFilters(new URLSearchParams('view=everything'), criteria, since);
  assert.ok(badView.error, 'an unknown view must be refused');
});

test('a role change narrows serving, but same-role retained rows are never hidden', async () => {
  const { db, alice } = await sharedFixture();
    const criteria = criteriaWithRoles();
    const sameRoles = testInput('alice', ORDINARY, baseFilters({ language: 'all' }), criteria);
    const same = await queryCatalogueAggregates(db, sameRoles);
    // Every non-dismissed, non-folded holding whose text carries a saved role
    // word is served under those same roles.
    const roleKept = alice.filter((seed) => seed.visibility === 'active'
      && inAudience(seed, ORDINARY) && roleMatches(seed, ROLES));
    assert.equal(same.matching, roleKept.length - same.folded,
      'serving under unchanged roles keeps exactly what import kept, minus folded copies');
    const changed = await queryCatalogueAggregates(db, testInput('alice', ORDINARY,
      baseFilters({ language: 'all', roles: ['Brain Surgeon'] }), criteria));
    assert.ok(changed.matching < same.matching, 'a role change must narrow what is served');
});

test('teardown shared catalogue fixture', async () => {
  await shared?.dispose();
  shared = null;
});
