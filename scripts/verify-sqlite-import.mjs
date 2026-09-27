#!/usr/bin/env node
/**
 * VPS-03 (#196): synthetic rehearsal for the D1 export/import step.
 *
 * The real step is owner-run — `wrangler d1 export ikbeneenappel-prod` into
 * the file `SQLITE_PATH` points at, then `ensureSchema()` confirming the
 * production `schema_migrations` version with nothing re-running — and the
 * production dump never enters the repo, an issue, or a transcript.
 *
 * So this script rehearses the SHAPE of that step on throwaway synthetic
 * data only: build a fresh SQLite file through the adapter, seed one
 * account's catalogue-split rows (migration 30), checkpoint WAL into the
 * file, copy it as the "export", open the copy, and confirm:
 * - `schema_migrations` reports the same version list (nothing would re-run),
 * - per-table row counts match,
 * - `vacancies` / `vacancy_sources` / `user_vacancy_state` still join for
 *   the account.
 *
 * Run with: `node --import tsx scripts/verify-sqlite-import.mjs`
 * (imports `.ts` sources, same pattern as `npm run refresh`).
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 */
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const work = mkdtempSync(join(tmpdir(), 'vps03-import-'));
const sourcePath = join(work, 'source.sqlite');
const exportPath = join(work, 'export.sqlite');
process.env.SQLITE_PATH = sourcePath;

const { bindings, ensureSchema } = await import('../db/runtime.ts');
const { runtimeMigrations } = await import('../db/migrations.ts');
await ensureSchema();
const { db } = bindings();

const now = new Date().toISOString();
const userId = `vps03-${Date.now()}`;
const vacancyId = `vac-vps03-${Date.now()}`;
const jobId = `job-vps03-${Date.now()}`;

await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(userId, `vps03-${Date.now()}@example.test`, 'x', 'user', now).run();
await db.prepare(`INSERT INTO vacancies (id, canonical_url, title, company, description, content_hash,
    identity_fingerprint, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, 'https://example.com/vps03', 'Engineer', 'Example', 'English-only role',
    'h', 'fp-vps03', now, now, now, now).run();
await db.prepare(`INSERT INTO vacancy_sources (vacancy_id, source_key, source_name, canonical_url,
    source_job_id, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, 'example.com', 'Example', 'https://example.com/vps03', '1', 'nl', now, now).run();
await db.prepare(`INSERT INTO user_vacancy_state (user_id, job_id, vacancy_id, is_saved, application_status,
    visibility_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(userId, jobId, vacancyId, 1, 'not_applied', 'active', now, now).run();

async function snapshot(database) {
  const versions = await database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  const counts = {};
  for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
    counts[table] = await database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first('total');
  }
  return { versions: versions.results.map((row) => row.version), counts };
}

const before = await snapshot(db);

// WAL keeps recent writes outside the main file; checkpoint first so the
// copy holds everything. (This is also why VPS-07 uses Litestream rather
// than a naive `cp`: it understands WAL, a copy does not.)
{
  const checkpoint = new DatabaseSync(sourcePath);
  try {
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
}
copyFileSync(sourcePath, exportPath);
for (const suffix of ['-wal', '-shm', '-journal']) {
  if (existsSync(sourcePath + suffix)) copyFileSync(sourcePath + suffix, exportPath + suffix);
}

// Open the "export" behind a fresh handle (never through the adapter cache
// for the source path) and confirm the migrated state survived intact.
const restored = new DatabaseSync(exportPath);
restored.exec('PRAGMA foreign_keys = ON');
const list = (sql, ...params) => restored.prepare(sql).all(...params);
const one = (sql, ...params) => restored.prepare(sql).get(...params);
const afterVersions = list('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version);
const afterCounts = {};
for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
  afterCounts[table] = one(`SELECT COUNT(*) AS total FROM ${table}`).total;
}
// `ensureSchema()` would be a no-op against this file: every known
// migration version is already recorded.
const expected = runtimeMigrations.map((migration) => migration.version);
const noOp = JSON.stringify(afterVersions) === JSON.stringify(expected);

const joinRow = restored.prepare(`SELECT v.title, s.source_key, st.is_saved
  FROM vacancies v
  JOIN vacancy_sources s ON s.vacancy_id = v.id
  JOIN user_vacancy_state st ON st.vacancy_id = v.id
  WHERE st.user_id = ? AND v.id = ?`).get(userId, vacancyId);
restored.close();

const countsMatch = JSON.stringify(afterCounts) === JSON.stringify(before.counts);
const joinOk = joinRow?.title === 'Engineer' && joinRow?.source_key === 'example.com' && joinRow?.is_saved === 1;

console.log(JSON.stringify({
  schemaVersion: afterVersions.at(-1),
  versionsMatchSource: JSON.stringify(afterVersions) === JSON.stringify(before.versions),
  ensureSchemaNoOp: noOp,
  countsMatch,
  counts: afterCounts,
  joinOk,
}, null, 2));

if (!noOp || !countsMatch || !joinOk) {
  console.error('Import rehearsal FAILED: the export did not survive intact.');
  process.exit(1);
}
console.log('Import rehearsal PASS: schema version, row counts and catalogue join all survived the copy.');
