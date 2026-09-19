import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { CLUSTER_VERSION, ensureCurrentJobClusters, normalizeStoredJobs } from '../lib/server-data';

// Use real D1 SQL and batch transactions, so a missing owner predicate or a malformed migration
// fails here instead of being papered over by a mock that reimplements the intended query.
async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  // Reconstruct the populated version-15 jobs table using its real table-rebuild migration
  // followed by the later clustering and normalization upgrades.
  const base = runtimeMigrations.find((m) => m.version === 7)!.statements[0]
    .replace('CREATE TABLE jobs_rebuilt', 'CREATE TABLE jobs');
  await db.prepare(base).run();
  for (const version of [13, 14]) {
    await db.batch(runtimeMigrations.find((m) => m.version === version)!.statements.map((sql) => db.prepare(sql)));
  }
  await db.prepare('CREATE TABLE language_feedback (job_id TEXT, user_id TEXT, corrected_status TEXT, reason TEXT)').run();
  await db.prepare('CREATE TABLE dismissed_jobs (id TEXT, user_id TEXT, canonical_url TEXT)').run();
  return { db, dispose: () => runtime.dispose() };
}

async function upgrade(db: D1Database) {
  await db.batch(runtimeMigrations.find((m) => m.name === 'track_cluster_rule_version')!
    .statements.map((sql) => db.prepare(sql)));
}

async function add(db: D1Database, id: string, userId = 'alice', firstSeen = '2026-09-01', company = 'Example') {
  await db.prepare(`INSERT INTO jobs
    (id, user_id, source_url, title, company, location, description, language_status,
     language_summary, first_seen_at, created_at, updated_at, cluster_key)
    VALUES (?, ?, ?, 'Data Analyst', ?, 'Amsterdam', 'Synthetic description', 'review',
      'Synthetic verdict', ?, ?, ?, 'existing-key')`)
    .bind(id, userId, `https://example.test/jobs/${id}`, company, firstSeen, firstSeen, firstSeen).run();
}

async function rows(db: D1Database) {
  return (await db.prepare('SELECT * FROM jobs ORDER BY id').all<Record<string, unknown>>()).results;
}

test('upgrading stored links reveals an old repost and preserves both accounts and personal actions', async () => {
  const { db, dispose } = await fixture();
  try {
    await add(db, 'old', 'alice', '2026-06-01');
    await add(db, 'repost', 'alice', '2026-09-01');
    await add(db, 'bob-job', 'bob');
    await db.prepare("UPDATE jobs SET duplicate_of = 'old', is_saved = 1, application_status = 'applied', visibility_status = 'dismissed' WHERE id = 'repost'").run();
    await db.prepare("INSERT INTO language_feedback VALUES ('repost', 'alice', 'blocked', 'Keep my correction')").run();
    await db.prepare("INSERT INTO dismissed_jobs VALUES ('repost', 'alice', 'https://example.test/jobs/repost')").run();
    const before = await rows(db);
    await upgrade(db);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE cluster_version = 0').first<{ n: number }>())?.n, 3);
    assert.deepEqual(await ensureCurrentJobClusters(db, 'alice'), { clusters: 0, duplicates: 0 });
    const after = await rows(db);
    for (const row of after) {
      const original = before.find((r) => r.id === row.id)!;
      for (const [key, value] of Object.entries(original)) {
        if (row.user_id === 'alice' && ['cluster_key', 'duplicate_of'].includes(key)) continue;
        assert.deepEqual(row[key], value, `${String(row.id)}.${key} must survive`);
      }
      assert.equal(row.cluster_version, row.user_id === 'alice' ? CLUSTER_VERSION : 0);
    }
    assert.equal(after.find((r) => r.id === 'repost')?.duplicate_of, '');
    assert.deepEqual(await db.prepare('SELECT * FROM language_feedback').first(),
      { job_id: 'repost', user_id: 'alice', corrected_status: 'blocked', reason: 'Keep my correction' });
    assert.deepEqual(await db.prepare('SELECT * FROM dismissed_jobs').first(),
      { id: 'repost', user_id: 'alice', canonical_url: 'https://example.test/jobs/repost' });
  } finally { await dispose(); }
});

test('an empty upgrade and new imports settle once, including jobs with no usable cluster key', async () => {
  const { db, dispose } = await fixture();
  try {
    await upgrade(db);
    assert.deepEqual(await ensureCurrentJobClusters(db, 'alice'), { clusters: 0, duplicates: 0 });
    await add(db, 'first');
    await add(db, 'copy', 'alice', '2026-09-03');
    await add(db, 'keyless', 'alice', '2026-09-01', '');
    await db.prepare("UPDATE jobs SET is_saved = 1 WHERE id = 'first'").run();
    assert.deepEqual(await ensureCurrentJobClusters(db, 'alice'), { clusters: 1, duplicates: 1 });
    assert.equal((await db.prepare("SELECT duplicate_of FROM jobs WHERE id = 'copy'").first<{ duplicate_of: string }>())?.duplicate_of, 'first');
    const checked = await rows(db);
    assert.ok(checked.every((r) => r.cluster_version === CLUSTER_VERSION));
    // A current workspace must not perform any write, even for unclusterable rows.
    const readOnly = {
      prepare: db.prepare.bind(db),
      batch: () => { throw new Error('Already-current jobs must not be rewritten'); },
    } as unknown as D1Database;
    assert.deepEqual(await ensureCurrentJobClusters(readOnly, 'alice'), { clusters: 0, duplicates: 0 });
    assert.deepEqual(await rows(db), checked);
    await add(db, 'later-copy', 'alice', '2026-09-04');
    assert.deepEqual(await ensureCurrentJobClusters(db, 'alice'), { clusters: 1, duplicates: 2 });
  } finally { await dispose(); }
});

test('an interrupted multi-batch update remains eligible and recovers on the next read', async () => {
  const { db, dispose } = await fixture();
  try {
    await upgrade(db);
    for (let index = 0; index < 51; index++) await add(db, `job-${index}`, 'alice', '2026-09-01', `Employer ${index}`);
    let batches = 0;
    const interrupted = {
      prepare: db.prepare.bind(db),
      batch: (statements: D1PreparedStatement[]) => {
        if (++batches === 2) throw new Error('Simulated interruption');
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await assert.rejects(ensureCurrentJobClusters(interrupted, 'alice'), /Simulated interruption/);
    assert.equal((await rows(db)).filter((r) => r.cluster_version === 0).length, 1);
    await ensureCurrentJobClusters(db, 'alice');
    assert.ok((await rows(db)).every((r) => r.cluster_version === CLUSTER_VERSION));
  } finally { await dispose(); }
});

test('normalization invalidates current clusters when their matching fields change', async () => {
  const { db, dispose } = await fixture();
  try {
    await upgrade(db);
    await add(db, 'entity');
    await db.prepare("UPDATE jobs SET title = 'Cost &amp; Inventory Analyst'").run();
    await ensureCurrentJobClusters(db, 'alice');
    assert.equal((await rows(db))[0].cluster_version, CLUSTER_VERSION);
    assert.equal(await normalizeStoredJobs(db, 'alice'), 1);
    assert.equal((await rows(db))[0].title, 'Cost & Inventory Analyst');
    assert.equal((await rows(db))[0].cluster_version, 0);
    await ensureCurrentJobClusters(db, 'alice');
    assert.equal((await rows(db))[0].cluster_version, CLUSTER_VERSION);
  } finally { await dispose(); }
});
