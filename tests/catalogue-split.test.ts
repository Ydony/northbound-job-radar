import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { catalogueGroupKey, contentHashForDescription, mirrorCatalogueForJob, removeUserVacancyState } from '../lib/catalogue';

/**
 * INT-04 (#163): the shared public catalogue (`vacancies`, `vacancy_sources`)
 * split from per-user private records (`user_vacancy_state`).
 *
 * Every test below runs real D1 SQL against disposable synthetic rows — no owner
 * state, no production database. The contract under test:
 * - migration 30 groups one catalogue row per distinct advert across accounts and
 *   copies every account's saved/applied/dismissed state plus corrections 1:1;
 * - `jobs`, `language_feedback` and `dismissed_jobs` keep every row;
 * - forgetting one account's state never removes a catalogue row another holds,
 *   and only rows nobody holds are collected.
 */

const T1 = '2026-09-01T10:00:00.000Z';
const T2 = '2026-09-02T10:00:00.000Z';
const T3 = '2026-09-03T10:00:00.000Z';
const T4 = '2026-09-04T10:00:00.000Z';

async function miniflareDb() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  return { db, dispose: () => runtime.dispose() };
}

async function preSplitSchema(db: D1Database) {
  await db.prepare(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    canonical_url TEXT NOT NULL DEFAULT '',
    source_key TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '',
    source_job_id TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'unknown',
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL DEFAULT '',
    language_status TEXT NOT NULL DEFAULT 'unknown',
    language_summary TEXT NOT NULL DEFAULT '',
    language_signals TEXT NOT NULL DEFAULT '[]',
    workplace_type TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    identity_fingerprint TEXT NOT NULL DEFAULT '',
    is_saved INTEGER NOT NULL DEFAULT 0,
    application_status TEXT NOT NULL DEFAULT 'not_applied',
    visibility_status TEXT NOT NULL DEFAULT 'active',
    first_seen_at TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE language_feedback (
    job_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL DEFAULT '',
    corrected_status TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare(`CREATE TABLE dismissed_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    source_key TEXT NOT NULL DEFAULT '',
    source_job_id TEXT NOT NULL DEFAULT '',
    canonical_url TEXT NOT NULL DEFAULT '',
    identity_fingerprint TEXT NOT NULL DEFAULT '',
    dismissed_at TEXT NOT NULL DEFAULT ''
  )`).run();
}

interface SyntheticJob {
  id: string;
  userId: string;
  canonicalUrl?: string;
  fingerprint?: string;
  sourceKey?: string;
  sourceName?: string;
  sourceJobId?: string;
  isSaved?: number;
  applicationStatus?: string;
  visibilityStatus?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

async function addJob(db: D1Database, job: SyntheticJob) {
  await db.prepare(`INSERT INTO jobs (id, user_id, source_url, canonical_url, source_key, source_name,
      source_job_id, country, title, company, location, description, search_text, language_status,
      language_summary, identity_fingerprint, is_saved, application_status, visibility_status,
      first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'switzerland', ?, 'Example AG', 'Zurich', ?, ?, 'pass',
      'Synthetic verdict', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(job.id, job.userId, job.canonicalUrl ?? `https://example.test/${job.id}`,
      job.canonicalUrl ?? '', job.sourceKey ?? 'board-ch', job.sourceName ?? 'Board CH',
      job.sourceJobId ?? job.id, `Role ${job.id}`, `Description for ${job.id} with enough text.`,
      `folded role ${job.id}`, job.fingerprint ?? '', job.isSaved ?? 0,
      job.applicationStatus ?? 'not_applied', job.visibilityStatus ?? 'active',
      job.firstSeenAt ?? T1, job.lastSeenAt ?? T2, T1, T2).run();
}

async function applyCatalogueMigration(db: D1Database) {
  const migration = runtimeMigrations.find((entry) => entry.version === 30);
  assert.ok(migration, 'migration 30 is missing');
  for (const statement of migration.statements) {
    await db.prepare(statement).run();
  }
}

async function count(db: D1Database, table: string, where = '', ...params: unknown[]) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM ${table}${where ? ` WHERE ${where}` : ''}`)
    .bind(...params).first<{ total: number }>();
  return row?.total ?? -1;
}

/** Two accounts, one shared advert, one dismissed advert, one identity-less row. */
async function populatedDb() {
  const { db, dispose } = await miniflareDb();
  try {
    await preSplitSchema(db);
    await addJob(db, { id: 'a-shared', userId: 'alice', canonicalUrl: 'https://example.test/jobs/shared',
      fingerprint: 'job-v1-shared', sourceKey: 'board-ch', sourceName: 'Board CH', sourceJobId: 's1',
      isSaved: 1, applicationStatus: 'applied', firstSeenAt: T1, lastSeenAt: T2 });
    await addJob(db, { id: 'b-shared', userId: 'bob', canonicalUrl: 'https://example.test/jobs/shared',
      fingerprint: 'job-v1-shared', sourceKey: 'board-ch', sourceName: 'Board CH', sourceJobId: 's2',
      firstSeenAt: T3, lastSeenAt: T4 });
    await addJob(db, { id: 'a-dismissed', userId: 'alice', canonicalUrl: 'https://example.test/jobs/gone',
      fingerprint: 'job-v1-gone', visibilityStatus: 'dismissed' });
    await addJob(db, { id: 'b-lonely', userId: 'bob' });
    await db.prepare(`INSERT INTO language_feedback (job_id, user_id, verdict, corrected_status, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind('a-shared', 'alice', 'incorrect', 'blocked', 'Needs German on site.', T2).run();
    await db.prepare(`INSERT INTO dismissed_jobs (id, user_id, source_key, canonical_url, dismissed_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind('a-dismissed', 'alice', 'board-ch', 'https://example.test/jobs/gone', T2).run();
    return { db, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

test('catalogue grouping key prefers URL, then fingerprint, then source identity', () => {
  assert.equal(catalogueGroupKey({ canonical_url: 'https://x.test/1', identity_fingerprint: 'fp',
    source_key: 'k', source_job_id: 's', id: 'r' }), 'url:https://x.test/1');
  assert.equal(catalogueGroupKey({ canonical_url: '', identity_fingerprint: 'fp',
    source_key: 'k', source_job_id: 's', id: 'r' }), 'fp:fp');
  assert.equal(catalogueGroupKey({ canonical_url: '', identity_fingerprint: '',
    source_key: 'k', source_job_id: 's', id: 'r' }), 'sid:k|s');
  // No identity at all: rows stay separate rather than merging strangers.
  assert.equal(catalogueGroupKey({ canonical_url: '', identity_fingerprint: '',
    source_key: '', source_job_id: '', id: 'r' }), 'row:r');
});

test('content hashes are stable and separate different texts', () => {
  const text = 'A description with enough words.';
  assert.equal(contentHashForDescription(text), contentHashForDescription(text));
  assert.notEqual(contentHashForDescription(text), contentHashForDescription(`${text} More.`));
});

test('migration 30 backfills the split without losing a row', async () => {
  const { db, dispose } = await populatedDb();
  try {
    const before = {
      jobs: await count(db, 'jobs'),
      aliceJobs: await count(db, 'jobs', 'user_id = ?', 'alice'),
      bobJobs: await count(db, 'jobs', 'user_id = ?', 'bob'),
      feedback: await count(db, 'language_feedback'),
      dismissed: await count(db, 'dismissed_jobs'),
    };
    await applyCatalogueMigration(db);
    // Source tables are untouched: same rows, same owners.
    assert.equal(await count(db, 'jobs'), before.jobs);
    assert.equal(await count(db, 'jobs', 'user_id = ?', 'alice'), before.aliceJobs);
    assert.equal(await count(db, 'jobs', 'user_id = ?', 'bob'), before.bobJobs);
    assert.equal(await count(db, 'language_feedback'), before.feedback);
    assert.equal(await count(db, 'dismissed_jobs'), before.dismissed);
    // Three distinct adverts across both accounts: the shared one, the dismissed
    // one, and the identity-less row that must not merge with anything.
    assert.equal(await count(db, 'vacancies'), 3);
    // Private state mirrors every jobs row exactly.
    assert.equal(await count(db, 'user_vacancy_state'), before.jobs);
    assert.equal(await count(db, 'user_vacancy_state', 'user_id = ?', 'alice'), before.aliceJobs);
    assert.equal(await count(db, 'user_vacancy_state', 'user_id = ?', 'bob'), before.bobJobs);
    // The shared advert lands on one catalogue row for both accounts, spanning
    // the whole seen window.
    const aliceState = await db.prepare(`SELECT vacancy_id, is_saved, application_status,
        visibility_status, corrected_status, corrected_reason FROM user_vacancy_state
        WHERE user_id = ? AND job_id = ?`).bind('alice', 'a-shared')
      .first<{ vacancy_id: string; is_saved: number; application_status: string;
        visibility_status: string; corrected_status: string; corrected_reason: string }>();
    const bobState = await db.prepare('SELECT vacancy_id, is_saved, corrected_status FROM user_vacancy_state WHERE user_id = ? AND job_id = ?')
      .bind('bob', 'b-shared').first<{ vacancy_id: string; is_saved: number; corrected_status: string }>();
    assert.ok(aliceState && bobState);
    assert.equal(aliceState.vacancy_id, bobState.vacancy_id);
    assert.equal(aliceState.vacancy_id, 'a-shared', 'the representative row keeps its id');
    assert.equal(aliceState.is_saved, 1);
    assert.equal(aliceState.application_status, 'applied');
    assert.equal(aliceState.visibility_status, 'active');
    assert.equal(aliceState.corrected_status, 'blocked');
    assert.equal(aliceState.corrected_reason, 'Needs German on site.');
    assert.equal(bobState.is_saved, 0);
    assert.equal(bobState.corrected_status, '');
    const shared = await db.prepare('SELECT first_seen_at, last_seen_at FROM vacancies WHERE id = ?')
      .bind('a-shared').first<{ first_seen_at: string; last_seen_at: string }>();
    assert.deepEqual(shared, { first_seen_at: T1, last_seen_at: T4 });
    // Both board copies are recorded as provenance of the one catalogue row.
    assert.equal(await count(db, 'vacancy_sources', 'vacancy_id = ?', 'a-shared'), 2);
    // Dismissal survives as state, and the tombstone survives as a tombstone.
    const dismissedState = await db.prepare(`SELECT visibility_status FROM user_vacancy_state
      WHERE user_id = ? AND job_id = ?`).bind('alice', 'a-dismissed')
      .first<{ visibility_status: string }>();
    assert.equal(dismissedState?.visibility_status, 'dismissed');
    // The identity-less row gets its own catalogue row, joined back to its owner.
    const lonely = await db.prepare('SELECT vacancy_id FROM user_vacancy_state WHERE user_id = ? AND job_id = ?')
      .bind('bob', 'b-lonely').first<{ vacancy_id: string }>();
    assert.equal(lonely?.vacancy_id, 'b-lonely');
  } finally {
    await dispose();
  }
});

test('the mirror shares one catalogue row across accounts and syncs later edits', async () => {
  const { db, dispose } = await miniflareDb();
  try {
    await preSplitSchema(db);
    await applyCatalogueMigration(db);
    await addJob(db, { id: 'a1', userId: 'alice', canonicalUrl: 'https://example.test/jobs/m',
      fingerprint: 'job-v1-m', firstSeenAt: T1, lastSeenAt: T2 });
    const first = await mirrorCatalogueForJob(db, 'alice', 'a1', 10);
    assert.equal(first, 'a1');
    assert.equal(await count(db, 'vacancies'), 1);
    await addJob(db, { id: 'b1', userId: 'bob', canonicalUrl: 'https://example.test/jobs/m',
      fingerprint: 'job-v1-m', firstSeenAt: T3, lastSeenAt: T4 });
    const second = await mirrorCatalogueForJob(db, 'bob', 'b1', 10);
    assert.equal(second, 'a1', 'the second account joins the existing catalogue row');
    assert.equal(await count(db, 'vacancies'), 1);
    assert.equal(await count(db, 'user_vacancy_state'), 2);
    const widened = await db.prepare('SELECT first_seen_at, last_seen_at, detector_version FROM vacancies WHERE id = ?')
      .bind('a1').first<{ first_seen_at: string; last_seen_at: string; detector_version: number }>();
    assert.deepEqual(widened, { first_seen_at: T1, last_seen_at: T4, detector_version: 10 });
    // A later saved + correction edit on alice's row syncs her private state only.
    await db.prepare('UPDATE jobs SET is_saved = 1 WHERE id = ?').bind('a1').run();
    await db.prepare(`INSERT INTO language_feedback (job_id, user_id, verdict, corrected_status, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind('a1', 'alice', 'incorrect', 'review', 'Ambiguous.', T3).run();
    await mirrorCatalogueForJob(db, 'alice', 'a1', 10);
    const alice = await db.prepare('SELECT is_saved, corrected_status, corrected_reason FROM user_vacancy_state WHERE user_id = ? AND job_id = ?')
      .bind('alice', 'a1').first<{ is_saved: number; corrected_status: string; corrected_reason: string }>();
    assert.deepEqual(alice, { is_saved: 1, corrected_status: 'review', corrected_reason: 'Ambiguous.' });
    const bob = await db.prepare('SELECT is_saved, corrected_status FROM user_vacancy_state WHERE user_id = ? AND job_id = ?')
      .bind('bob', 'b1').first<{ is_saved: number; corrected_status: string }>();
    assert.deepEqual(bob, { is_saved: 0, corrected_status: '' });
    // Clearing the correction clears the mirrored copy too.
    await db.prepare('DELETE FROM language_feedback WHERE job_id = ?').bind('a1').run();
    await mirrorCatalogueForJob(db, 'alice', 'a1', 10);
    const cleared = await db.prepare('SELECT corrected_status FROM user_vacancy_state WHERE user_id = ? AND job_id = ?')
      .bind('alice', 'a1').first<{ corrected_status: string }>();
    assert.equal(cleared?.corrected_status, '');
  } finally {
    await dispose();
  }
});

test('forgetting one account keeps shared catalogue rows and collects only orphans', async () => {
  const { db, dispose } = await populatedDb();
  try {
    await applyCatalogueMigration(db);
    await removeUserVacancyState(db, 'alice');
    // Alice's private state is gone; bob's is untouched.
    assert.equal(await count(db, 'user_vacancy_state', 'user_id = ?', 'alice'), 0);
    assert.equal(await count(db, 'user_vacancy_state', 'user_id = ?', 'bob'), 2);
    // The shared advert survives because bob still holds it; alice's dismissed
    // advert is collected because nobody holds it anymore.
    assert.equal(await count(db, 'vacancies', 'id = ?', 'a-shared'), 1);
    assert.equal(await count(db, 'vacancies', 'id = ?', 'a-dismissed'), 0);
    assert.equal(await count(db, 'vacancy_sources', 'vacancy_id = ?', 'a-dismissed'), 0);
    assert.equal(await count(db, 'vacancy_sources', 'vacancy_id = ?', 'a-shared'), 2);
    // The helper never touches jobs rows themselves — the callers delete those.
    assert.equal(await count(db, 'jobs'), 4);
    // An explicitly empty id list forgets nothing.
    await removeUserVacancyState(db, 'bob', []);
    assert.equal(await count(db, 'user_vacancy_state', 'user_id = ?', 'bob'), 2);
    // A guarded single delete keeps state whose job row still exists.
    await removeUserVacancyState(db, 'bob', ['b-shared', 'missing-id']);
    assert.equal(await count(db, 'user_vacancy_state', 'user_id = ?', 'bob'), 2);
    await db.prepare('DELETE FROM jobs WHERE id = ?').bind('b-shared').run();
    await removeUserVacancyState(db, 'bob', ['b-shared']);
    assert.equal(await count(db, 'user_vacancy_state', 'user_id = ?', 'bob'), 1);
  } finally {
    await dispose();
  }
});

test('mirror and removal no-op on databases that predate the catalogue tables', async () => {
  const { db, dispose } = await miniflareDb();
  try {
    await preSplitSchema(db);
    await addJob(db, { id: 'a1', userId: 'alice' });
    assert.equal(await mirrorCatalogueForJob(db, 'alice', 'a1', 10), '');
    await removeUserVacancyState(db, 'alice');
    assert.equal(await count(db, 'jobs'), 1);
  } finally {
    await dispose();
  }
});
