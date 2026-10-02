import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { baseSchemaStatements } from '../db/runtime';
import { CV_REMOVAL_VERSION, runtimeMigrations } from '../db/migrations';
import { openSqliteDatabase } from '../db/sqlite-adapter';

/**
 * T31 (F11) — encrypted-database migration, WAL/temp behavior and SQL
 * compatibility on fresh and existing synthetic databases.
 *
 * What already exists: tests/sqlite-adapter.test.ts proves a fresh
 * ensureSchema() build plus no-op rerun and the catalogue join;
 * tests/migrations.test.ts pins migration ordering and the one-statement
 * rule; scripts/verify-sqlite-{import,restore}.mjs rehearse the backup
 * drills. What was missing and lives here: the EXISTING-database upgrade
 * path (a genuine pre-28 database advanced through the real ensureSchema),
 * the WAL/temp artifact inventory, and the D1-dialect compatibility matrix
 * the ~197 prepare() call sites rely on.
 *
 * TRIPWIRE: there is no cipher in this tree yet (F11 Proposed), so the
 * byte-scan tests assert storage is currently PLAINTEXT at rest. When the
 * owner-selected cipher lands, these assertions must be flipped to
 * assert Nothing readable — if this file still passes unchanged after
 * that, the cipher trial forgot to update it.
 */

const root = dirname(fileURLToPath(import.meta.url));
const work = join(root, 'output', `t31-migration-${Date.now()}-${process.pid}`);
const LATEST = Math.max(...runtimeMigrations.map((migration) => migration.version));

type Db = ReturnType<typeof openSqliteDatabase>;

test.before(() => {
  mkdirSync(work, { recursive: true });
  // Keep SQLite temp files inside the work dir so the inventory below sees them.
  process.env.SQLITE_TMPDIR = work;
});

test.after(() => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Handles stay open for the process lifetime; the OS temp parent is fine to keep.
  }
});

async function applyMigrations(db: Db, upTo = LATEST) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`).run();
  for (const migration of runtimeMigrations) {
    if (migration.version > upTo) break;
    const statements = migration.statements.map((statement) => db.prepare(statement));
    statements.push(db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .bind(migration.version, migration.name, new Date().toISOString()));
    await db.batch(statements);
  }
}

async function appliedVersions(db: Db): Promise<number[]> {
  const rows = await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all<{ version: number }>();
  return rows.results.map((row) => row.version);
}

const T31 = `t31-${Date.now()}-${process.pid}`;

test('a fresh database migrates base plus every runtime migration', async () => {
  const db = openSqliteDatabase(join(work, 'fresh.sqlite'));
  for (const statement of baseSchemaStatements) await db.prepare(statement).run();
  await applyMigrations(db);

  assert.deepEqual(await appliedVersions(db), runtimeMigrations.map((migration) => migration.version));
  assert.equal((await appliedVersions(db)).at(-1), LATEST);
  for (const table of ['users', 'jobs', 'vacancies', 'vacancy_sources', 'user_vacancy_state',
    'language_feedback', 'dismissed_jobs', 'search_runs', 'public_refresh_state']) {
    const found = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(table).first<{ name: string }>();
    assert.equal(found?.name, table, `missing table ${table}`);
  }
  const cvs = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cvs'")
    .first<{ name: string }>();
  assert.equal(cvs, null, 'migration 28 must have removed CV storage on fresh builds too');
});

test('an existing pre-28 database upgrades in place with fixtures surviving', async () => {
  // Build a genuine v27-era database: legacy base plus migrations 1–27 only.
  const oldPath = join(work, 'existing-v27.sqlite');
  const setup = openSqliteDatabase(oldPath);
  for (const statement of baseSchemaStatements) await setup.prepare(statement).run();
  await applyMigrations(setup, 27);
  assert.deepEqual(await appliedVersions(setup), runtimeMigrations.filter((m) => m.version <= 27).map((m) => m.version));

  const now = new Date().toISOString();
  const userA = `t31-user-a-${T31}`;
  const userB = `t31-user-b-${T31}`;
  const jobA = `t31-job-a-${T31}`;
  const jobB = `t31-job-b-${T31}`;
  const canonical = `https://example.test/t31/${T31}`;
  for (const [id, email] of [[userA, `a-${T31}@example.test`], [userB, `b-${T31}@example.test`]]) {
    await setup.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, email, 'synthetic-hash', 'user', now).run();
  }
  // Two accounts holding the same advert: migration 30 must merge these into one catalogue row.
  for (const [id, userId, saved] of [[jobA, userA, 1], [jobB, userB, 0]]) {
    await setup.prepare(`INSERT INTO jobs (id, source_url, title, company, location, description,
        language_status, language_summary, status, created_at, updated_at, user_id, source_key, source_name,
        source_job_id, canonical_url, country, posted_at, first_seen_at, last_seen_at,
        identity_fingerprint, is_saved, application_status, visibility_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, canonical, `Engineer ${T31}`, 'Example', 'Zurich', `English-only probe ${T31}`,
        'pass', 'English sufficient', 'new', now, now, userId, 'example.test', 'Example', '1',
        canonical, 'switzerland', '2026-09-01', now, now, `fp-${T31}`, saved, 'not_applied', 'active').run();
  }
  await setup.prepare(`INSERT INTO language_feedback (job_id, user_id, verdict, corrected_status, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(jobA, userA, 'corrected', 'review', `probe correction ${T31}`, now).run();
  await setup.prepare(`INSERT INTO cvs (id, slot, file_name, object_key, cv_text, derived_role, updated_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`t31-cv-${T31}`, 'a', 'cv.pdf', 'k', 'text', 'role', now, userA).run();

  // The real entry point advances it: applied 1–27 are skipped, 28–31 run, backfills run.
  process.env.SQLITE_PATH = oldPath;
  const { bindings, ensureSchema } = await import('../db/runtime');
  await ensureSchema();
  const { db } = bindings();

  assert.deepEqual(await appliedVersions(db as unknown as Db),
    runtimeMigrations.map((migration) => migration.version));
  // Fixtures survived the upgrade.
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?)').bind(userA, userB)
    .first<{ n: number }>().then((r) => r?.n), 2);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE id IN (?, ?)').bind(jobA, jobB)
    .first<{ n: number }>().then((r) => r?.n), 2);
  const feedback = await db.prepare('SELECT corrected_status FROM language_feedback WHERE job_id = ?')
    .bind(jobA).first<{ corrected_status: string }>();
  assert.equal(feedback?.corrected_status, 'review');
  // Migration 28 removed CV storage and never recreates it.
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cvs'")
    .first(), null);
  // Migration 29 backfilled verification timestamps from account creation.
  const verified = await db.prepare('SELECT email_verified_at, created_at FROM users WHERE id = ?')
    .bind(userA).first<{ email_verified_at: string; created_at: string }>();
  assert.equal(verified?.email_verified_at, verified?.created_at);
  // Migration 30 merged the shared advert and mirrored private state 1:1, corrections included.
  const vacancies = await db.prepare('SELECT COUNT(*) AS n FROM vacancies').first<{ n: number }>();
  assert.equal(vacancies?.n, 1);
  const states = await db.prepare('SELECT COUNT(*) AS n FROM user_vacancy_state').first<{ n: number }>();
  assert.equal(states?.n, 2);
  const mirrored = await db.prepare('SELECT corrected_status FROM user_vacancy_state WHERE job_id = ?')
    .bind(jobA).first<{ corrected_status: string }>();
  assert.equal(mirrored?.corrected_status, 'review');
  // A second boot is a no-op.
  const before = (await appliedVersions(db as unknown as Db)).length;
  await ensureSchema();
  assert.equal((await appliedVersions(db as unknown as Db)).length, before);
  assert.ok(before > 27 && (await appliedVersions(db as unknown as Db)).includes(CV_REMOVAL_VERSION));
});

test('the D1-dialect compatibility matrix the call sites rely on', async () => {
  const db = openSqliteDatabase(join(work, 'compat.sqlite'));
  for (const statement of baseSchemaStatements) await db.prepare(statement).run();
  await applyMigrations(db);

  // Atomic upsert with RETURNING (rate limiting counts on exactly this shape).
  await db.prepare('CREATE TABLE t31_compat (k TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL DEFAULT 0)').run();
  const bumped = await db.prepare(`INSERT INTO t31_compat (k, n) VALUES (?, 1)
    ON CONFLICT(k) DO UPDATE SET n = t31_compat.n + 1 RETURNING n`).bind('probe').first<{ n: number }>();
  assert.equal(bumped?.n, 1);
  const bumpedAgain = await db.prepare(`INSERT INTO t31_compat (k, n) VALUES (?, 1)
    ON CONFLICT(k) DO UPDATE SET n = t31_compat.n + 1 RETURNING n`).bind('probe').first<{ n: number }>();
  assert.equal(bumpedAgain?.n, 2);

  // batch() is all-or-nothing: a failing statement rolls back the whole batch.
  await assert.rejects(db.batch([
    db.prepare('INSERT INTO t31_compat (k, n) VALUES (?, ?)').bind('rolled', 1),
    db.prepare('INSERT INTO nosuch_table (k) VALUES (1)'),
  ]));
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM t31_compat WHERE k = ?').bind('rolled')
    .first<{ n: number }>().then((r) => r?.n), 0);

  // Pragmas the adapter sets at open hold for the SQL layer too.
  const journal = await db.prepare('PRAGMA journal_mode').first<{ journal_mode: string }>();
  assert.equal(journal?.journal_mode.toLowerCase(), 'wal');
  const keys = await db.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
  assert.equal(keys?.foreign_keys, 1);
  // The retention delete in ensureSchema depends on datetime('now', ...).
  const swept = await db.prepare("SELECT datetime('now', '-30 days') AS cutoff").first<{ cutoff: string }>();
  assert.match(swept?.cutoff ?? '', /^\d{4}-\d{2}-\d{2} /);
});

test('WAL/temp artifacts stay beside the database and currently leak plaintext (F11 gap)', async () => {
  const dbPath = join(work, 'wal-probe.sqlite');
  const db = openSqliteDatabase(dbPath);
  for (const statement of baseSchemaStatements) await db.prepare(statement).run();
  await applyMigrations(db);

  const marker = `T31-PLAINTEXT-PROBE-${T31}`;
  await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(`t31-wal-${T31}`, `${marker}@example.test`, 'synthetic-hash', 'user', new Date().toISOString()).run();

  // Un-checkpointed frames live in -wal, not the main file: the sidecar must exist and
  // carry the fresh fixture bytes.
  const walPath = `${dbPath}-wal`;
  assert.equal(existsSync(walPath), true, 'WAL mode must keep a -wal sidecar while frames are un-checkpointed');
  assert.equal(readFileSync(walPath).includes(marker), true, 'fresh fixture bytes sit in -wal before checkpoint');

  // Checkpointing folds frames into the main file, after which a copied file is valid —
  // and, with no cipher, the copied bytes still read as plaintext.
  await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
  assert.equal(readFileSync(dbPath).includes(marker), true,
    'TRIPWIRE: private fixture readable in the main database file — fails F11 acceptance until the cipher lands');

  // Temp-file hygiene: with SQLITE_TMPDIR pointed at the work dir, nothing may spill
  // outside the database file family.
  const allowed = new Set(['fresh.sqlite', 'existing-v27.sqlite', 'compat.sqlite', 'wal-probe.sqlite']);
  for (const entry of readdirSync(work)) {
    const isDbFamily = [...allowed].some((base) => entry === base || entry.startsWith(`${base}-`));
    assert.equal(isDbFamily, true, `unexpected temp artifact beside the database: ${entry}`);
  }
});
