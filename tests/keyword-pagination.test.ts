import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { defaultSearchCriteria, escapeLikePattern, keywordFilterClause, matchesSearchCriteria,
  pageFilterClause, searchTextForJob } from '../lib/criteria';
import { decodeJobsCursor, encodeJobsCursor, parsePageLimit } from '../lib/paging';
import { ensureSearchText, queryJobsPage, upsertJob } from '../lib/server-data';
import type { SearchCriteria } from '../lib/types';

// Real D1 SQL throughout, so a malformed migration, a missing owner predicate, or a LIKE
// that disagrees with matchesSearchCriteria fails here instead of passing against a mock.

interface CorpusJob {
  id: string;
  userId: string;
  title: string;
  location: string;
  description: string;
  sourceKey: string;
  sourceUrl: string;
  updatedAt: string;
  isSaved: number;
  applicationStatus: string;
  visibilityStatus: string;
  searchText: string;
}

function stamp(minute: number) {
  return new Date(Date.UTC(2026, 8, 1, 10, minute)).toISOString();
}

function corpus(): CorpusJob[] {
  const jobs: CorpusJob[] = [];
  const add = (job: Omit<CorpusJob, 'searchText'> & { searchText?: string }) => {
    jobs.push({
      ...job,
      searchText: job.searchText ?? searchTextForJob(job),
    });
  };
  // Sixty generated rows with a spread of keywords, accents and timestamps. Every third row
  // carries SAP, every fourth Power BI, every fifth sits in Zürich; indices 0..59 double as
  // minutes so updated_at orders them, with rows 10/11 sharing a stamp for the id tiebreak.
  for (let index = 0; index < 60; index += 1) {
    const minute = index === 11 ? 10 : index;
    add({
      id: `job-${String(index).padStart(3, '0')}`,
      userId: 'alice',
      title: index % 3 === 0 ? `Senior SAP Analyst ${index}` : `Data Analyst ${index}`,
      location: index % 5 === 0 ? 'Zürich' : 'Amsterdam',
      description: index % 4 === 0
        ? `Permanent role ${index} using SAP, SQL and Power BI. English is the working language.`
        : `Permanent role ${index} in logistics. English is the working language.`,
      sourceKey: 'job-room.ch',
      sourceUrl: `https://www.job-room.ch/job-search/gen-${index}`,
      updatedAt: stamp(minute),
      isSaved: 0,
      applicationStatus: 'not_applied',
      visibilityStatus: 'active',
    });
  }
  // LIKE metacharacters in both the text and the keyword must match literally, not as wildcards.
  add({
    id: 'job-meta', userId: 'alice', title: '100% Remote SAP role', location: 'Utrecht',
    description: 'Uses C++ and a_b testing on C:\\tools. English only.',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/meta',
    updatedAt: stamp(61), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'active',
  });
  // Personal rows that the current keywords exclude: they still ride along on the page.
  add({
    id: 'job-saved', userId: 'alice', title: 'Sales internship', location: 'Rotterdam',
    description: 'Sales sales sales, Dutch required.',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/saved',
    updatedAt: stamp(62), isSaved: 1, applicationStatus: 'not_applied', visibilityStatus: 'active',
  });
  add({
    id: 'job-applied', userId: 'alice', title: 'Sales internship', location: 'Rotterdam',
    description: 'Sales sales sales, Dutch required.',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/applied',
    updatedAt: stamp(63), isSaved: 0, applicationStatus: 'applied', visibilityStatus: 'active',
  });
  add({
    id: 'job-dismissed', userId: 'alice', title: 'Sales internship', location: 'Rotterdam',
    description: 'Sales sales sales, Dutch required.',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/dismissed',
    updatedAt: stamp(64), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'dismissed',
  });
  // Audience-hidden rows: never on the page and never in either count for an ordinary account.
  add({
    id: 'job-hidden-key', userId: 'alice', title: 'SAP Analyst hidden', location: 'Amsterdam',
    description: 'SAP role found nowhere.',
    sourceKey: 'careerjet-test-key', sourceUrl: 'https://www.careerjet.test/hidden',
    updatedAt: stamp(65), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'active',
  });
  add({
    id: 'job-hidden-indeed', userId: 'alice', title: 'SAP Analyst indeed', location: 'Amsterdam',
    description: 'SAP role on Indeed.',
    sourceKey: 'indeed', sourceUrl: 'https://nl.indeed.com/viewjob?jk=abc123',
    updatedAt: stamp(66), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'active',
  });
  // A pre-migration row whose folded text was never written.
  add({
    id: 'job-legacy', userId: 'alice', title: 'Legacy SAP entry', location: 'Bern',
    description: 'An old SAP row from before the search_text column existed.',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/legacy',
    updatedAt: stamp(67), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'active',
    searchText: '',
  });
  // Degenerate but possible: nothing to fold. Both judges agree on it, and the backfill skips
  // it so the loop always terminates.
  add({
    id: 'job-empty', userId: 'alice', title: '', location: '',
    description: '',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/empty',
    updatedAt: stamp(68), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'active',
    searchText: '',
  });
  // Another account's rows, one of them keyword-matching: never visible, never counted.
  add({
    id: 'job-bob-1', userId: 'bob', title: 'SAP Analyst', location: 'Amsterdam',
    description: 'Bob SAP role.',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/bob-1',
    updatedAt: stamp(69), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'active',
  });
  add({
    id: 'job-bob-2', userId: 'bob', title: 'Logistics lead', location: 'Utrecht',
    description: 'Bob logistics role.',
    sourceKey: 'job-room.ch', sourceUrl: 'https://www.job-room.ch/job-search/bob-2',
    updatedAt: stamp(70), isSaved: 0, applicationStatus: 'not_applied', visibilityStatus: 'active',
  });
  return jobs;
}

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return { ...defaultSearchCriteria, ...overrides };
}

async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  // The post-tenancy jobs table plus every later column the page query reads or writes.
  const base = runtimeMigrations.find((entry) => entry.version === 7)!.statements[0]
    .replace('CREATE TABLE jobs_rebuilt', 'CREATE TABLE jobs');
  await db.prepare(base).run();
  for (const version of [13, 14, 16, 17, 20, 21, 22, 23]) {
    const migration = runtimeMigrations.find((entry) => entry.version === version)!;
    await db.batch(migration.statements.map((sql) => db.prepare(sql)));
  }
  await db.prepare(`CREATE TABLE dismissed_jobs (
    id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL DEFAULT '', source_key TEXT NOT NULL DEFAULT '',
    source_job_id TEXT NOT NULL DEFAULT '', canonical_url TEXT NOT NULL DEFAULT '',
    identity_fingerprint TEXT NOT NULL DEFAULT '')`).run();
  await db.prepare(`CREATE TABLE language_feedback (
    job_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT '',
    corrected_status TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '')`).run();
  const jobs = corpus();
  for (let index = 0; index < jobs.length; index += 50) {
    await db.batch(jobs.slice(index, index + 50).map((job) => db.prepare(`INSERT INTO jobs
      (id, user_id, source_url, source_key, title, company, location, description, search_text,
       language_status, language_summary, is_saved, application_status, visibility_status,
       posted_at, first_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'review', 'Synthetic verdict', ?, ?, ?, '', ?, ?, ?)`)
      .bind(job.id, job.userId, job.sourceUrl, job.sourceKey, job.title, job.location,
        job.description, job.searchText, job.isSaved, job.applicationStatus,
        job.visibilityStatus, job.updatedAt, job.updatedAt, job.updatedAt)));
  }
  return { db, jobs, dispose: () => runtime.dispose() };
}

async function sqlMatches(db: D1Database, userId: string, filter: { clause: string; params: string[] }) {
  const rows = await db.prepare(`SELECT id FROM jobs WHERE user_id = ?${filter.clause}`)
    .bind(userId, ...filter.params).all<{ id: string }>();
  return rows.results.map((row) => row.id).sort();
}

test('the SQL keyword filter agrees with matchesSearchCriteria on every corpus row', async () => {
  const { db, jobs, dispose } = await fixture();
  try {
    // Backfill first: the legacy row carries real text but an empty search_text until then.
    assert.equal(await ensureSearchText(db, 'alice'), 1);
    assert.equal(await ensureSearchText(db, 'alice'), 0);
    const alice = jobs.filter((job) => job.userId === 'alice');
    const expected = (filterCriteria: SearchCriteria) => alice
      .filter((job) => matchesSearchCriteria(job, filterCriteria)).map((job) => job.id).sort();
    const cases: SearchCriteria[] = [
      criteria(),
      criteria({ requiredKeywords: ['sap'] }),
      criteria({ requiredKeywords: ['sap', 'power bi'] }),
      criteria({ requiredKeywords: ['zurich'] }),
      criteria({ requiredKeywords: ['SAP', 'ZÜRICH'] }),
      criteria({ excludedKeywords: ['sales'] }),
      criteria({ requiredKeywords: ['sap'], excludedKeywords: ['logistics'] }),
      criteria({ requiredKeywords: ['100%'] }),
      criteria({ requiredKeywords: ['c++'] }),
      criteria({ requiredKeywords: ['a_b'] }),
      criteria({ requiredKeywords: ['c:\\tools'] }),
      criteria({ requiredKeywords: ['nomatchhere'] }),
      criteria({ requiredKeywords: [''], excludedKeywords: [''] }),
    ];
    for (const filterCriteria of cases) {
      assert.deepEqual(
        await sqlMatches(db, 'alice', keywordFilterClause(filterCriteria, 'search_text')),
        expected(filterCriteria),
        `SQL disagrees on required=${JSON.stringify(filterCriteria.requiredKeywords)}`
        + ` excluded=${JSON.stringify(filterCriteria.excludedKeywords)}`,
      );
    }
  } finally { await dispose(); }
});

test('LIKE metacharacters in keywords match literally', () => {
  assert.equal(escapeLikePattern('100%_\\'), '100\\%\\_\\\\');
});

test('saved, applied and dismissed rows ride along when the keywords exclude them', async () => {
  const { db, dispose } = await fixture();
  try {
    await ensureSearchText(db, 'alice');
    const filterCriteria = criteria({ requiredKeywords: ['sap'] });
    const ids = await sqlMatches(db, 'alice', pageFilterClause(filterCriteria));
    for (const id of ['job-saved', 'job-applied', 'job-dismissed']) {
      assert.ok(ids.includes(id), `${id} must ride along on the page`);
    }
    // A plain non-matching row stays out, and the hidden-audience rows stay out too.
    assert.ok(!ids.includes('job-001'), 'a plain excluded row must not ride along');
    const matching = await sqlMatches(db, 'alice', keywordFilterClause(filterCriteria, 'search_text'));
    for (const id of ['job-saved', 'job-applied', 'job-dismissed']) {
      assert.ok(!matching.includes(id), `${id} must not count as matching`);
    }
    // With no keywords there is no page predicate at all.
    assert.deepEqual(pageFilterClause(criteria()), { clause: '', params: [] });
  } finally { await dispose(); }
});

test('paging walks every visible row exactly once, in newest-first order', async () => {
  const { db, dispose } = await fixture();
  try {
    await ensureSearchText(db, 'alice');
    const filterCriteria = criteria({ requiredKeywords: ['sap'] });
    const query = {
      hiddenSourceKeys: ['careerjet-test-key'],
      hideIndeedRecords: true,
      criteria: filterCriteria,
      limit: 25,
    };
    const seen: string[] = [];
    let cursor: { updatedAt: string; id: string } | null = null;
    let pages = 0;
    let first: Awaited<ReturnType<typeof queryJobsPage>> | null = null;
    for (;;) {
      const page = await queryJobsPage(db, 'alice', { ...query, cursor });
      if (!first) first = page;
      pages += 1;
      const ids = page.rows.map((row) => row.id);
      // Newest first, with the id tiebreak keeping equal timestamps stable.
      const ordered = [...page.rows].sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
      assert.deepEqual(ids, ordered.map((row) => row.id), `page ${pages} is out of order`);
      seen.push(...ids);
      if (!page.nextCursor) break;
      const decoded = decodeJobsCursor(page.nextCursor);
      assert.equal(decoded.error, null);
      cursor = decoded.cursor;
      assert.ok(pages < 10, 'paging must terminate');
    }
    assert.ok(pages >= 2, 'the corpus must actually span pages');
    assert.equal(new Set(seen).size, seen.length, 'no row may repeat across pages');
    const expected = await sqlMatches(db, 'alice', pageFilterClause(filterCriteria));
    // The hidden-audience rows match the keywords, so they are in the unfiltered expectation;
    // the query itself excludes them before the limit, which is what the next line proves.
    assert.deepEqual([...seen].sort(), expected.filter((id) => id !== 'job-hidden-key' && id !== 'job-hidden-indeed').sort());
    assert.ok(!seen.includes('job-hidden-key') && !seen.includes('job-hidden-indeed'),
      'hidden-audience rows must never reach the page');
    assert.equal(first!.total, 66, 'total counts every visible row regardless of keywords');
    assert.equal(first!.matching, expected.filter((id) => id !== 'job-hidden-key' && id !== 'job-hidden-indeed'
      && !['job-saved', 'job-applied', 'job-dismissed'].includes(id)).length);
    // Tenancy: another account's rows never appear and never count, while the shared
    // keyword filter still applies to what it sees.
    const bob = await queryJobsPage(db, 'bob', { ...query, cursor: null });
    assert.deepEqual(bob.rows.map((row) => row.id).sort(), ['job-bob-1']);
    assert.equal(bob.total, 2);
    assert.equal(bob.matching, 1);
  } finally { await dispose(); }
});

test('a page that ends exactly on the limit does not invent another one', async () => {
  const { db, dispose } = await fixture();
  try {
    for (let index = 0; index < 4; index += 1) {
      await db.prepare(`INSERT INTO jobs (id, user_id, source_url, title, location, description,
        search_text, language_status, language_summary, first_seen_at, created_at, updated_at)
        VALUES (?, 'carol', ?, ?, 'Amsterdam', ?, ?, 'review', 'Synthetic verdict', ?, ?, ?)`)
        .bind(`carol-${index}`, `https://www.job-room.ch/job-search/carol-${index}`,
          `Role ${index}`, `Description ${index}`, searchTextForJob({
            title: `Role ${index}`, location: 'Amsterdam', description: `Description ${index}`,
          }), stamp(index), stamp(index), stamp(index)).run();
    }
    const query = { hiddenSourceKeys: [], hideIndeedRecords: false, criteria: criteria(), limit: 2 };
    const first = await queryJobsPage(db, 'carol', { ...query, cursor: null });
    assert.equal(first.rows.length, 2);
    assert.ok(first.nextCursor, 'a following row exists, so the cursor must be set');
    const decoded = decodeJobsCursor(first.nextCursor);
    assert.equal(decoded.error, null);
    const second = await queryJobsPage(db, 'carol', { ...query, cursor: decoded.cursor });
    assert.equal(second.rows.length, 2);
    assert.equal(second.nextCursor, null, 'ending exactly on the limit is still the end');
    assert.deepEqual(
      [...first.rows, ...second.rows].map((row) => row.id).sort(),
      ['carol-0', 'carol-1', 'carol-2', 'carol-3'],
    );
  } finally { await dispose(); }
});

test('upserted jobs carry folded search text that follows later edits', async () => {
  const { db, dispose } = await fixture();
  try {
    const first = await upsertJob(db, 'alice', {
      sourceUrl: 'https://www.job-room.ch/job-search/upsert-1',
      title: 'SAP Consultant Zürich',
      company: 'Example AG',
      location: 'Zürich',
      description: 'A role using SAP and Power BI, 100% remote.',
      languageStatus: 'pass',
      languageSummary: 'English sufficient.',
      languageSignals: [],
      postedAt: '2026-09-01',
    });
    assert.equal(first.wasKnown, false);
    const stored = await db.prepare('SELECT search_text FROM jobs WHERE id = ?').bind(first.job.id)
      .first<{ search_text: string }>();
    assert.equal(stored?.search_text, searchTextForJob({
      title: 'SAP Consultant Zürich', location: 'Zürich',
      description: 'A role using SAP and Power BI, 100% remote.',
    }));
    assert.ok((stored?.search_text ?? '').includes('zurich'), 'accents must be folded on write');
    const second = await upsertJob(db, 'alice', {
      sourceUrl: 'https://www.job-room.ch/job-search/upsert-1',
      title: 'SAP Consultant Zürich',
      company: 'Example AG',
      location: 'Zürich',
      description: 'A role using SAP and Kubernetes.',
      languageStatus: 'pass',
      languageSummary: 'English sufficient.',
      languageSignals: [],
      postedAt: '2026-09-01',
    });
    assert.equal(second.wasKnown, true);
    const restored = await db.prepare('SELECT search_text FROM jobs WHERE id = ?').bind(first.job.id)
      .first<{ search_text: string }>();
    assert.ok(!(restored?.search_text ?? '').includes('power bi'), 'edited text must replace the old fold');
    assert.ok((restored?.search_text ?? '').includes('kubernetes'));
  } finally { await dispose(); }
});

test('upserted jobs keep the published expiry and never clear one held', async () => {
  // #97 on real D1: migration 23 must have applied for the write to exist at all, the expiry
  // must survive the round trip through jobFromRow, and an empty re-import must not clear it.
  const { db, dispose } = await fixture();
  try {
    const input = {
      sourceUrl: 'https://www.job-room.ch/job-search/expiry-1',
      title: 'Data Analyst',
      company: 'Example AG',
      location: 'Zürich',
      description: 'English working language, permanent role.',
      languageStatus: 'pass' as const,
      languageSummary: 'English sufficient.',
      languageSignals: [] as string[],
      postedAt: '2026-09-01',
      expiresAt: '2026-10-01',
    };
    const first = await upsertJob(db, 'alice', input);
    assert.equal(first.job.expiresAt, '2026-10-01');
    const stored = await db.prepare('SELECT expires_at FROM jobs WHERE id = ?').bind(first.job.id)
      .first<{ expires_at: string }>();
    assert.equal(stored?.expires_at, '2026-10-01');
    const second = await upsertJob(db, 'alice', { ...input, expiresAt: '' });
    assert.equal(second.wasKnown, true);
    assert.equal(second.job.expiresAt, '2026-10-01', 'an empty re-import must not clear a held expiry');
  } finally { await dispose(); }
});

test('the page cursor codec accepts what it encodes and refuses the rest', () => {
  assert.deepEqual(parsePageLimit(null, 2000), { size: 2000, error: null });
  assert.deepEqual(parsePageLimit('25', 2000), { size: 25, error: null });
  for (const raw of ['0', '-3', '2001', 'abc', '1.5', '']) {
    assert.ok(parsePageLimit(raw, 2000).error, `${JSON.stringify(raw)} must be refused`);
  }
  const encoded = encodeJobsCursor('2026-09-01T10:00:00.000Z', 'job-1');
  assert.deepEqual(decodeJobsCursor(encoded), {
    cursor: { updatedAt: '2026-09-01T10:00:00.000Z', id: 'job-1' },
    error: null,
  });
  assert.deepEqual(decodeJobsCursor(null), { cursor: null, error: null });
  assert.deepEqual(decodeJobsCursor(''), { cursor: null, error: null });
  for (const raw of ['nonsense', '2026-09-01|job-1', '2026-09-01T10:00:00.000Z|', 'a|b\nc']) {
    assert.ok(decodeJobsCursor(raw).error, `${JSON.stringify(raw)} must be refused`);
  }
});
