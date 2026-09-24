import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { defaultSearchCriteria } from '../lib/criteria';
import { INDEED_SOURCE_KEYS } from '../lib/indeed/access';
import {
  adminOnlySourceKeys,
  isHiddenSourceForRole,
  jobSourceAdapters,
} from '../lib/job-adapters';
import {
  audienceExclusionClause,
  queryCollectionTotals,
  queryJobsPage,
  visibleSearchRuns,
  visibleSourceReports,
  type SearchRunRow,
  type SearchRunSourceRow,
} from '../lib/server-data';
import { searchTextForJob } from '../lib/criteria';
import { adminOnlySourcePolicyKeys, sourcePolicyFor } from '../lib/source-policy';
import type { SearchRunSource } from '../lib/types';

/**
 * INT-02 (#161): an ordinary account's every response never mentions admin-only sources —
 * names, records, counts or links — across results, counts, search history, corrections,
 * exports and error messages. The same defect class as the tenancy leaks in AGENTS.md:
 * silent when broken, so the tests below seed *stored historical* admin rows (the demotion
 * case), not just fresh search output.
 *
 * Route handlers need live sessions, which this harness cannot mint, so each surface is
 * covered twice: the shared lib enforcement functionally against real D1 SQL, and the route
 * wiring structurally (the repo's established split — see tests/tenant-route-bindings.test.ts).
 */

const ORDINARY_USER = 'ordinary';
const ADMIN_USER = 'admin';

function stamp(minute: number) {
  return new Date(Date.UTC(2026, 8, 10, 9, minute)).toISOString();
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
  await db.prepare(`CREATE TABLE search_runs (
    id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE search_run_sources (
    run_id TEXT NOT NULL, source_key TEXT NOT NULL, source_name TEXT NOT NULL,
    country TEXT NOT NULL, status TEXT NOT NULL, roles_searched TEXT NOT NULL DEFAULT '[]',
    found_count INTEGER NOT NULL DEFAULT 0, known_count INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER, duplicate_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, source_key)
  )`).run();
  await db.prepare(`CREATE TABLE language_feedback (
    job_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL DEFAULT '', corrected_status TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    detected_status TEXT NOT NULL DEFAULT '', detected_summary TEXT NOT NULL DEFAULT '',
    detected_signals TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT ''
  )`).run();
  return { db, dispose: () => runtime.dispose() };
}

interface SeedJob {
  id: string;
  userId: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  minute: number;
}

async function seedJobs(db: D1Database, jobs: SeedJob[]) {
  for (let index = 0; index < jobs.length; index += 50) {
    await db.batch(jobs.slice(index, index + 50).map((job) => {
      const description = `A permanent analyst role in Zurich. English is the working language. (${job.id})`;
      return db.prepare(`INSERT INTO jobs
        (id, user_id, source_url, source_key, source_name, country, title, company, location,
         description, search_text, language_status, language_summary,
         is_saved, application_status, visibility_status,
         posted_at, first_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'switzerland', ?, 'Acme', 'Zurich', ?, ?, 'pass',
         'Synthetic verdict', 0, 'not_applied', 'active', '', ?, ?, ?)`)
        .bind(job.id, job.userId, job.sourceUrl, job.sourceKey, job.sourceName,
          job.title, description, searchTextForJob({ title: job.title, location: 'Zurich', description }),
          stamp(job.minute), stamp(job.minute), stamp(job.minute));
    }));
  }
}

async function seedRun(
  db: D1Database,
  userId: string,
  runId: string,
  minute: number,
  overallStatus: string,
  sources: { key: string; name: string; status: string; found: number; known: number }[],
) {
  await db.prepare('INSERT INTO search_runs (id, user_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)')
    .bind(runId, userId, overallStatus, stamp(minute), stamp(minute)).run();
  await db.batch(sources.map((source) => db.prepare(`INSERT INTO search_run_sources
    (run_id, source_key, source_name, country, status, roles_searched,
     found_count, known_count, new_count, imported_count, matched_count,
     duplicate_count, skipped_count, message)
    VALUES (?, ?, ?, 'switzerland', ?, '["analyst"]', ?, ?, 0, 0, 0, 0, 0, 'Synthetic run')`)
    .bind(runId, source.key, source.name, source.status, source.found, source.known)));
}

/** Every name, key, alias or URL fragment an ordinary account must never be shown. */
function forbiddenTokens(): string[] {
  const adminNames = jobSourceAdapters
    .filter((adapter) => sourcePolicyFor(adapter.key)?.audience !== 'public')
    .map((adapter) => adapter.name);
  return [...adminOnlySourceKeys(), ...adminNames, ...INDEED_SOURCE_KEYS, 'indeed'];
}

function assertNoAdminMention(payload: unknown, label: string) {
  const text = JSON.stringify(payload).toLowerCase();
  for (const token of forbiddenTokens()) {
    assert.equal(
      text.includes(token.toLowerCase()),
      false,
      `${label} mentions admin-only ${JSON.stringify(token)}`,
    );
  }
}

function hiddenKeys(): string[] {
  return [...adminOnlySourceKeys()];
}

/** The ordinary account's stored world: public rows plus historical admin rows. */
async function seedOrdinaryWorld(db: D1Database) {
  await seedJobs(db, [
    { id: 'u-pub-1', userId: ORDINARY_USER, sourceKey: 'eures-ch', sourceName: 'EURES Switzerland', sourceUrl: 'https://europa.eu/eures/job/u-pub-1', title: 'Data Analyst public one', minute: 1 },
    { id: 'u-pub-2', userId: ORDINARY_USER, sourceKey: 'job-room.ch', sourceName: 'Job-Room (arbeit.swiss)', sourceUrl: 'https://www.job-room.ch/job-search/u-pub-2', title: 'Data Analyst public two', minute: 2 },
    // Historical admin rows: stored before the change, or kept across a demotion.
    { id: 'u-adm-1', userId: ORDINARY_USER, sourceKey: 'jobs.ch', sourceName: 'jobs.ch', sourceUrl: 'https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/', title: 'Data Analyst historic admin one', minute: 3 },
    { id: 'u-adm-2', userId: ORDINARY_USER, sourceKey: 'iamexpat.nl', sourceName: 'IamExpat', sourceUrl: 'https://www.iamexpat.nl/career/jobs-netherlands/historic-two', title: 'Data Analyst historic admin two', minute: 4 },
    { id: 'u-adm-3', userId: ORDINARY_USER, sourceKey: 'jobviewtrack.com', sourceName: 'jobviewtrack.com', sourceUrl: 'https://jobviewtrack.com/historic-three', title: 'Data Analyst historic admin three', minute: 5 },
    { id: 'u-adm-4', userId: ORDINARY_USER, sourceKey: 'indeed', sourceName: 'Indeed', sourceUrl: 'https://nl.indeed.com/viewjob?jk=historic4', title: 'Data Analyst historic admin four', minute: 6 },
    { id: 'u-adm-5', userId: ORDINARY_USER, sourceKey: 'undutchables.nl', sourceName: 'Undutchables', sourceUrl: 'https://undutchables.nl/vacancies/historic-five', title: 'Data Analyst historic admin five', minute: 7 },
    // Another account's rows, public and admin alike: never visible, never counted.
    { id: 'a-pub-1', userId: ADMIN_USER, sourceKey: 'eures-ch', sourceName: 'EURES Switzerland', sourceUrl: 'https://europa.eu/eures/job/a-pub-1', title: 'Admin analyst public', minute: 8 },
    { id: 'a-adm-1', userId: ADMIN_USER, sourceKey: 'jobs.ch', sourceName: 'jobs.ch', sourceUrl: 'https://www.jobs.ch/en/vacancies/detail/22222222-2222-2222-2222-222222222222/', title: 'Admin analyst private', minute: 9 },
  ]);
  // A mixed run: public success beside admin rows, one of them failed.
  await seedRun(db, ORDINARY_USER, 'run-mixed', 10, 'partial', [
    { key: 'eures-ch', name: 'EURES Switzerland', status: 'complete', found: 12, known: 3 },
    { key: 'jobs.ch', name: 'jobs.ch', status: 'complete', found: 40, known: 9 },
    { key: 'indeed-nl', name: 'Indeed Netherlands', status: 'failed', found: 0, known: 0 },
  ]);
  // An admin-only run: must vanish entirely for the ordinary account, not arrive emptied.
  await seedRun(db, ORDINARY_USER, 'run-private', 11, 'complete', [
    { key: 'jobs.ch', name: 'jobs.ch', status: 'complete', found: 40, known: 9 },
  ]);
  // A public-only run: passes through untouched.
  await seedRun(db, ORDINARY_USER, 'run-public', 12, 'complete', [
    { key: 'eures-ch', name: 'EURES Switzerland', status: 'complete', found: 5, known: 1 },
  ]);
  await seedRun(db, ADMIN_USER, 'run-admin', 13, 'complete', [
    { key: 'jobs.ch', name: 'jobs.ch', status: 'complete', found: 40, known: 9 },
  ]);
  await db.prepare(`INSERT INTO language_feedback
    (job_id, user_id, verdict, corrected_status, reason, updated_at,
     detected_status, detected_summary, detected_signals, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('u-pub-1', ORDINARY_USER, 'correct', '', '', stamp(14),
      'pass', 'Synthetic verdict', '[]', 'Public evidence').run();
  await db.prepare(`INSERT INTO language_feedback
    (job_id, user_id, verdict, corrected_status, reason, updated_at,
     detected_status, detected_summary, detected_signals, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('u-adm-1', ORDINARY_USER, 'incorrect', 'blocked', 'Needs German',
      stamp(15), 'pass', 'Synthetic verdict', '[]',
      'Evidence naming https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/').run();
}

async function readRuns(db: D1Database, userId: string) {
  const runs = await db.prepare('SELECT * FROM search_runs WHERE user_id = ? ORDER BY started_at DESC')
    .bind(userId).all<SearchRunRow>();
  const runIds = runs.results.map((run) => run.id);
  const runSources = runIds.length
    ? await db.prepare(`SELECT * FROM search_run_sources WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY source_name`)
      .bind(...runIds).all<SearchRunSourceRow>()
    : { results: [] as SearchRunSourceRow[] };
  return { runs: runs.results, sources: runSources.results };
}

test('ordinary results expose no admin records, counts or links — including stored history', async () => {
  const { db, dispose } = await fixture();
  try {
    await seedOrdinaryWorld(db);
    const hidden = hiddenKeys();
    const page = await queryJobsPage(db, ORDINARY_USER, {
      hiddenSourceKeys: hidden,
      hideIndeedRecords: true,
      criteria: defaultSearchCriteria,
      cursor: null,
      limit: 50,
    });
    assert.deepEqual(page.rows.map((row) => row.id).sort(), ['u-pub-1', 'u-pub-2']);
    assert.equal(page.total, 2, 'stored admin rows must not count toward the total');
    assert.equal(page.matching, 2, 'stored admin rows must not count toward the matching total');
    assertNoAdminMention(page, 'ordinary jobs page');
    // The administrator's own view is untouched: controls preserved, no silent over-hiding.
    const adminPage = await queryJobsPage(db, ADMIN_USER, {
      hiddenSourceKeys: [],
      hideIndeedRecords: false,
      criteria: defaultSearchCriteria,
      cursor: null,
      limit: 50,
    });
    assert.deepEqual(adminPage.rows.map((row) => row.id).sort(), ['a-adm-1', 'a-pub-1']);
    assert.equal(adminPage.total, 2);
  } finally {
    await dispose();
  }
});

test('ordinary collection totals count public rows only', async () => {
  const { db, dispose } = await fixture();
  try {
    await seedOrdinaryWorld(db);
    const totals = await queryCollectionTotals(db, ORDINARY_USER, hiddenKeys(), true);
    assert.equal(totals.total, 2, 'five stored admin rows must add nothing to the ordinary total');
    assert.deepEqual(totals.bySource.map((entry) => entry.sourceKey).sort(), ['eures-ch', 'job-room.ch']);
    assertNoAdminMention(totals, 'ordinary collection totals');
    const adminTotals = await queryCollectionTotals(db, ADMIN_USER, [], false);
    assert.equal(adminTotals.total, 2, 'administrator totals still include their admin rows');
    assert.ok(adminTotals.bySource.some((entry) => entry.sourceKey === 'jobs.ch'));
  } finally {
    await dispose();
  }
});

test('ordinary search history drops admin sources, admin-only runs, and admin failures', async () => {
  const { db, dispose } = await fixture();
  try {
    await seedOrdinaryWorld(db);
    const hidden = new Set(hiddenKeys());
    const { runs, sources } = await readRuns(db, ORDINARY_USER);
    const visible = visibleSearchRuns(runs, sources, false, hidden);
    const byId = new Map(visible.map((run) => [run.id, run]));
    // The mixed run keeps its public source only; the stored partial (an admin Indeed failure)
    // recomputes to complete from the visible rows, so an admin-only failure can never flip it.
    assert.ok(byId.has('run-mixed'));
    assert.deepEqual(byId.get('run-mixed')!.sources.map((source) => source.sourceKey), ['eures-ch']);
    assert.equal(byId.get('run-mixed')!.status, 'complete');
    // The admin-only run vanishes entirely rather than arriving as an empty shell.
    assert.equal(byId.has('run-private'), false, 'an admin-only run must not appear at all');
    // The public run passes through untouched.
    assert.deepEqual(byId.get('run-public')!.sources.map((source) => source.sourceKey), ['eures-ch']);
    assertNoAdminMention(visible, 'ordinary search history');
    // Administrators retain the complete record.
    const adminReads = await readRuns(db, ADMIN_USER);
    const adminVisible = visibleSearchRuns(adminReads.runs, adminReads.sources, true, hidden);
    assert.equal(adminVisible.length, 1);
    assert.deepEqual(adminVisible[0].sources.map((source) => source.sourceKey), ['jobs.ch']);
    const ordinaryFull = visibleSearchRuns(runs, sources, true, hidden);
    assert.ok(ordinaryFull.some((run) => run.id === 'run-private'),
      'the hidden run still exists for an administrator reading this account');
  } finally {
    await dispose();
  }
});

test('ordinary corrections export excludes admin rows through the shared SQL predicate', async () => {
  const { db, dispose } = await fixture();
  try {
    await seedOrdinaryWorld(db);
    // The exact predicate /api/feedback splices into its export query, run here against real
    // D1 with the seeded historical rows — including the correction whose stored evidence
    // names an admin-only URL.
    const runExport = async (isAdmin: boolean) => {
      const audience = audienceExclusionClause('j', isAdmin ? [] : hiddenKeys());
      return db.prepare(`SELECT f.job_id, f.verdict, f.corrected_status, f.reason, f.updated_at,
          f.detected_status, f.detected_summary, f.detected_signals, f.evidence,
          j.title, j.company, j.location, j.source_name
        FROM language_feedback f JOIN jobs j ON j.id = f.job_id AND j.user_id = f.user_id
        WHERE f.user_id = ?${audience.clause} ORDER BY f.updated_at DESC LIMIT 500`)
        .bind(ORDINARY_USER, ...audience.params).all<Record<string, unknown>>();
    };
    const ordinary = await runExport(false);
    assert.deepEqual(ordinary.results.map((row) => row.job_id), ['u-pub-1']);
    assertNoAdminMention(ordinary.results, 'ordinary corrections export');
    const admin = await runExport(true);
    assert.deepEqual(
      (admin.results.map((row) => row.job_id) as string[]).sort(),
      ['u-adm-1', 'u-pub-1'],
      'the administrator export still carries the admin correction',
    );
  } finally {
    await dispose();
  }
});

test('fresh-search shaping hides admin sources and their counts from ordinary accounts', () => {
  const hidden = new Set(hiddenKeys());
  const reports: SearchRunSource[] = [
    { sourceKey: 'eures-ch', sourceName: 'EURES Switzerland', country: 'switzerland', status: 'complete', rolesSearched: ['analyst'], foundCount: 12, knownCount: 3, newCount: 9, importedCount: 4, matchedCount: 2, duplicateCount: 1, skippedCount: 0, message: '' },
    { sourceKey: 'jobs.ch', sourceName: 'jobs.ch', country: 'switzerland', status: 'complete', rolesSearched: ['analyst'], foundCount: 40, knownCount: 9, newCount: 31, importedCount: 4, matchedCount: 1, duplicateCount: 0, skippedCount: 0, message: '' },
    { sourceKey: 'indeed-nl', sourceName: 'Indeed Netherlands', country: 'netherlands', status: 'failed', rolesSearched: ['analyst'], foundCount: 0, knownCount: 0, newCount: 0, importedCount: 0, matchedCount: null, duplicateCount: 0, skippedCount: 0, message: 'Refused.' },
  ];
  const ordinary = visibleSourceReports(reports, false, hidden);
  assert.deepEqual(ordinary.map((source) => source.sourceKey), ['eures-ch']);
  // /api/scrape sums these same visible rows for scanned/alreadyKnown, so admin volume leaks
  // through no aggregate either.
  assert.equal(ordinary.reduce((sum, source) => sum + source.foundCount, 0), 12);
  assert.equal(ordinary.reduce((sum, source) => sum + source.knownCount, 0), 3);
  assertNoAdminMention({ run: { sources: ordinary }, scanned: 12, alreadyKnown: 3 }, 'ordinary search response');
  const admin = visibleSourceReports(reports, true, hidden);
  assert.equal(admin.length, 3, 'administrators keep every source row');
});

test('record-level hiding covers aliases, legacy Indeed rows and wrong-key rows', () => {
  const hidden = adminOnlySourceKeys();
  // Aliased storage keys, not just adapter keys.
  assert.equal(isHiddenSourceForRole('jobviewtrack.com', 'https://jobviewtrack.com/x', false, hidden), true);
  assert.equal(isHiddenSourceForRole('careerjet', 'https://www.careerjet.test/x', false, hidden), true);
  assert.equal(isHiddenSourceForRole('adzuna.ch', 'https://www.adzuna.ch/x', false, hidden), true);
  // A legacy Indeed row whose stored key is missing or wrong is still hidden by URL.
  assert.equal(isHiddenSourceForRole('', 'https://nl.indeed.com/viewjob?jk=abc', false, hidden), true);
  assert.equal(isHiddenSourceForRole('unknown', 'https://www.indeed.com/jobs?q=x', false, hidden), true);
  // A legacy admin row stored under a wrong key is re-resolved from its URL.
  assert.equal(
    isHiddenSourceForRole('unknown', 'https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/', false, hidden),
    true,
  );
  // Public rows stay visible, and administrators see everything.
  assert.equal(isHiddenSourceForRole('eures-ch', 'https://europa.eu/eures/job/x', false, hidden), false);
  assert.equal(isHiddenSourceForRole('job-room.ch', 'https://www.job-room.ch/job-search/x', false, hidden), false);
  assert.equal(isHiddenSourceForRole('jobs.ch', 'https://www.jobs.ch/x', true, hidden), false);
  assert.equal(isHiddenSourceForRole('indeed', 'https://nl.indeed.com/viewjob?jk=abc', true, hidden), false);
});

test('the enforced gate hides exactly the registry admin audience plus declared aliases', () => {
  // The gate derives from the registry, so this pins the only permitted difference: storage
  // aliases an adapter declares for where its results actually land (indeed-ch is both an
  // adapter key and an alias, so the check is by membership, not by set subtraction).
  const hidden = adminOnlySourceKeys();
  const adapterKeys = new Set(jobSourceAdapters.map((adapter) => adapter.key));
  for (const key of adminOnlySourcePolicyKeys()) {
    assert.ok(hidden.has(key), `${key} is registered admin-only but not hidden by the gate`);
  }
  for (const key of hidden) {
    if (adapterKeys.has(key)) continue;
    const declarer = jobSourceAdapters.find((adapter) => adapter.resultSourceKeys?.includes(key));
    assert.ok(
      declarer && sourcePolicyFor(declarer.key)?.audience === 'admin-only',
      `${key} is hidden but is neither an adapter key nor an admin-only adapter's declared alias`,
    );
  }
  for (const adapter of jobSourceAdapters) {
    for (const alias of adapter.resultSourceKeys ?? []) {
      const admin = sourcePolicyFor(adapter.key)?.audience === 'admin-only';
      assert.equal(hidden.has(alias), admin, `${alias} must be hidden exactly when ${adapter.key} is admin-only`);
    }
  }
});

test('routes enforce the audience through the shared helpers, not local splits', async () => {
  const root = new URL('..', import.meta.url);
  const read = (path: string) => readFile(new URL(path, root), 'utf8');
  const [state, scrape, feedback, singleJob, jobs, sources] = await Promise.all([
    read('app/api/state/route.ts'),
    read('app/api/scrape/route.ts'),
    read('app/api/feedback/route.ts'),
    read('app/api/jobs/[id]/route.ts'),
    read('app/api/jobs/route.ts'),
    read('app/sources/page.tsx'),
  ]);
  // Stored runs and fresh searches shape through the same functions tested above.
  assert.match(state, /visibleSearchRuns\(runs\.results, runSources\.results/);
  assert.match(scrape, /visibleSourceReports\(sourceReports, user\.role === 'admin', hiddenForAccount\)/);
  // Aggregates sum the visible rows, never the full per-source list.
  assert.match(scrape, /visibleSources\.reduce\(\(sum, source\) => sum \+ source\.foundCount, 0\)/);
  assert.match(scrape, /visibleSources\.reduce\(\(sum, source\) => sum \+ source\.knownCount, 0\)/);
  assert.doesNotMatch(scrape, /sourceReports\.reduce\(\(sum, source\) => sum \+ source\.foundCount/);
  // Corrections, single-record and bulk deletes share one SQL predicate from the registry gate.
  assert.match(feedback, /audienceExclusionClause\('j', hiddenSourceKeys\)/);
  assert.match(feedback, /adminOnlySourceKeys/);
  assert.match(singleJob, /isHiddenSourceForRole\(job\.source_key, job\.source_url, user\.role === 'admin'\)/);
  assert.match(singleJob, /audienceExclusionClause/);
  assert.match(jobs, /isHiddenSourceForRole\(sourceInfoForUrl\(sourceUrl\)\.key, sourceUrl, user\.role === 'admin'\)/);
  assert.match(jobs, /audienceExclusionClause/);
  // The transparency page gates on the signed-in administrator, never on client state.
  assert.match(sources, /sourcePoliciesForRole\(isAdmin\)/);
  assert.match(sources, /viewerIsAdmin/);
  // Refusals name no source: an error message must never teach the source list.
  assert.match(jobs, /error: 'This source is not available\.'/);
  assert.match(singleJob, /error: 'Job not found\.'/);
});
