#!/usr/bin/env node
/**
 * T31 (F11 Proposed): verify encrypted-database migration, WAL/temp behavior
 * and SQL compatibility on fresh and existing synthetic databases.
 *
 * ensureSchema() caches per process, so one process cannot boot two
 * databases through it. This harness therefore drives the adapter directly
 * (openSqliteDatabase + the exported base statements + runtimeMigrations,
 * the same loop ensureSchema runs) once per scenario in a single process:
 * fresh build, pre-28 upgrade, WAL/temp inventory, byte scans, the
 * checkpoint-then-copy backup drill, and the SQL compatibility matrix.
 * The in-test upgrade through the REAL ensureSchema lives in
 * tests/encrypted-db-migration.test.ts instead.
 *
 * Synthetic fixtures only; nothing leaves the throwaway work dir.
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 *
 * The byte scans are expected to FIND plaintext today: there is no cipher
 * in the tree yet, so `f11_at_rest` reports FAIL by design. The cipher trial
 * must flip those two booleans to false (and this script to expect it).
 *
 * Run with: `node --import tsx scripts/verify-encrypted-db.mjs`
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SQLITE_TMPDIR = tmpdir();
const work = mkdtempSync(join(tmpdir(), 't31-encrypted-db-'));
process.env.SQLITE_TMPDIR = work;

const { openSqliteDatabase } = await import('../db/sqlite-adapter.ts');
const { baseSchemaStatements } = await import('../db/runtime.ts');
const { CV_REMOVAL_VERSION, runtimeMigrations } = await import('../db/migrations.ts');

const failures = [];
function check(name, condition, detail = '') {
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

async function build(db, upTo = Infinity) {
  for (const statement of baseSchemaStatements) await db.prepare(statement).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`).run();
  const applied = new Set((await db.prepare('SELECT version FROM schema_migrations').all()).results.map((r) => r.version));
  for (const migration of runtimeMigrations) {
    if (migration.version > upTo || applied.has(migration.version)) continue;
    const statements = migration.statements.map((statement) => db.prepare(statement));
    statements.push(db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .bind(migration.version, migration.name, new Date().toISOString()));
    await db.batch(statements);
  }
}

async function versions(db) {
  const rows = await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return rows.results.map((row) => row.version);
}

const tag = `t31-${Date.now()}`;
const now = new Date().toISOString();

// --- Scenario 1: fresh database migrates fully and serves reads/writes. ---
const freshPath = join(work, 'fresh.sqlite');
const fresh = openSqliteDatabase(freshPath);
await build(fresh);
const freshVersions = await versions(fresh);
check('fresh versions complete', JSON.stringify(freshVersions) === JSON.stringify(runtimeMigrations.map((m) => m.version)));
await fresh.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(`fresh-${tag}`, `fresh-${tag}@example.test`, 'synthetic', 'user', now).run();
const freshUser = await fresh.prepare('SELECT email FROM users WHERE id = ?').bind(`fresh-${tag}`).first();
check('fresh round-trip', freshUser?.email === `fresh-${tag}@example.test`);

// --- Scenario 2: existing pre-28 database upgrades with fixtures surviving. ---
const oldPath = join(work, 'existing.sqlite');
const old = openSqliteDatabase(oldPath);
await build(old, 27);
await old.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(`old-${tag}`, `old-${tag}@example.test`, 'synthetic', 'user', now).run();
const canonical = `https://example.test/t31/${tag}`;
for (const [id, userId] of [[`job-a-${tag}`, `old-${tag}`]]) {
  await old.prepare(`INSERT INTO jobs (id, source_url, title, company, location, description,
      language_status, language_summary, status, created_at, updated_at, user_id, source_key,
      source_name, source_job_id, canonical_url, country, posted_at, first_seen_at, last_seen_at,
      identity_fingerprint, is_saved, application_status, visibility_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, canonical, `Engineer ${tag}`, 'Example', 'Zurich', `English-only probe ${tag}`,
      'pass', 'English sufficient', 'new', now, now, userId, 'example.test', 'Example', '1',
      canonical, 'switzerland', '2026-09-01', now, now, `fp-${tag}`, 1, 'not_applied', 'active').run();
}
await old.prepare(`INSERT INTO cvs (id, slot, file_name, object_key, cv_text, derived_role, updated_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(`cv-${tag}`, 'a', 'cv.pdf', 'k', 'text', 'role', now, `old-${tag}`).run();
await build(old); // applies 28..31 over the v27 base, migrations 1–27 already recorded
const upgradedVersions = await versions(old);
check('upgrade reaches latest', upgradedVersions.at(-1) === Math.max(...runtimeMigrations.map((m) => m.version)));
check('upgrade keeps every version', upgradedVersions.length === runtimeMigrations.length);
check('upgrade keeps user fixture',
  (await old.prepare('SELECT email FROM users WHERE id = ?').bind(`old-${tag}`).first())?.email === `old-${tag}@example.test`);
check('upgrade keeps job fixture',
  (await old.prepare('SELECT title FROM jobs WHERE id = ?').bind(`job-a-${tag}`).first())?.title === `Engineer ${tag}`);
check('upgrade ran CV removal',
  (await old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cvs'").first()) === null);
check('upgrade backfilled catalogue from jobs',
  (await old.prepare('SELECT COUNT(*) AS n FROM vacancies').first())?.n === 1);
check('upgrade backfilled verification timestamps',
  (await old.prepare('SELECT email_verified_at, created_at FROM users WHERE id = ?').bind(`old-${tag}`).first())?.email_verified_at === now);

// --- Scenario 3: WAL/temp behavior and byte-level artifact inventory. ---
const journal = await fresh.prepare('PRAGMA journal_mode').first();
check('journal mode is WAL', journal?.journal_mode?.toLowerCase() === 'wal', String(journal?.journal_mode));
const marker = `T31-PLAINTEXT-PROBE-${tag}`;
await fresh.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(`wal-${tag}`, `${marker}@example.test`, 'synthetic', 'user', now).run();
const walPath = `${freshPath}-wal`;
const walExists = existsSync(walPath);
check('wal sidecar present while frames un-checkpointed', walExists);
const walLeaks = walExists && readFileSync(walPath).includes(marker);
await fresh.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
const mainLeaks = readFileSync(freshPath).includes(marker);
const dirFiles = readdirSync(work).filter((f) => !f.endsWith('.sqlite') && !f.startsWith('fresh.sqlite-') && !f.startsWith('existing.sqlite-'));
check('no stray temp files beside the databases', dirFiles.length === 0, dirFiles.join(','));

// --- Scenario 4: checkpoint-then-copy backup drill on the upgraded database. ---
await old.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
const scratchPath = join(work, 'restored.sqlite');
copyFileSync(oldPath, scratchPath);
const restored = openSqliteDatabase(scratchPath);
check('restored copy reports same schema version',
  JSON.stringify(await versions(restored)) === JSON.stringify(upgradedVersions));
check('restored copy serves the same catalogue join',
  (await restored.prepare(`SELECT v.title FROM vacancies v
      JOIN user_vacancy_state s ON s.vacancy_id = v.id WHERE s.job_id = ?`).bind(`job-a-${tag}`).first())?.title === `Engineer ${tag}`);

// --- Scenario 5: SQL compatibility matrix through the adapter. ---
await fresh.prepare('CREATE TABLE t31_matrix (k TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL DEFAULT 0)').run();
const upserted = await fresh.prepare(`INSERT INTO t31_matrix (k, n) VALUES (?, 1)
  ON CONFLICT(k) DO UPDATE SET n = t31_matrix.n + 1 RETURNING n`).bind('m').first();
check('upsert returning', upserted?.n === 1);
let rolledBack = false;
try {
  await fresh.batch([
    fresh.prepare('INSERT INTO t31_matrix (k, n) VALUES (?, ?)').bind('ghost', 1),
    fresh.prepare('INSERT INTO nosuch_table (k) VALUES (1)'),
  ]);
} catch { rolledBack = true; }
check('batch is all-or-nothing', rolledBack
  && (await fresh.prepare('SELECT COUNT(*) AS n FROM t31_matrix WHERE k = ?').bind('ghost').first())?.n === 0);
check('foreign keys enforced', (await fresh.prepare('PRAGMA foreign_keys').first())?.foreign_keys === 1);
check('datetime arithmetic available',
  /^\d{4}-\d{2}-\d{2} /.test((await fresh.prepare("SELECT datetime('now', '-30 days') AS c").first())?.c ?? ''));

const evidence = {
  fresh_versions: freshVersions.length,
  latest_version: Math.max(...runtimeMigrations.map((m) => m.version)),
  cv_removal_version: CV_REMOVAL_VERSION,
  upgrade_versions: upgradedVersions.length,
  wal_sidecar_present: walExists,
  f11_at_rest: mainLeaks || walLeaks
    ? 'FAIL: synthetic private fixture readable in database bytes — no cipher in tree yet'
    : 'PASS: no readable fixture bytes',
  wal_bytes_readable: walLeaks,
  main_file_bytes_readable: mainLeaks,
  backup_drill: 'checkpoint-then-copy restored with same version and catalogue join',
  failures,
};
console.log(JSON.stringify(evidence, null, 2));
if (failures.length > 0) {
  console.error(`VERIFY FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
