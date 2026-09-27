#!/usr/bin/env node
/**
 * VPS-07 (#200): synthetic rehearsal for the Litestream restore drill.
 *
 * The real drill is owner-run on the VPS — stop both units, `litestream
 * restore` into a scratch path, serve the app from it, record row counts,
 * `schema_migrations` version and a signed-in dashboard load on #200 — and
 * the restored copy holds real account data, so nothing from it goes into
 * the repo, an issue, or a transcript.
 *
 * This script rehearses the SHAPE of that drill on throwaway synthetic data
 * only, using a plain file copy where Litestream would be (Litestream
 * understands WAL; the checkpoint below is what makes a copy valid at all):
 * build, checkpoint, back up, restore into a scratch path, and confirm the
 * restored copy reports the same schema version, the same row counts, and
 * the same catalogue join — i.e. the app would serve the same dashboard.
 *
 * Run with: `node --import tsx scripts/verify-sqlite-restore.mjs`
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 */
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const work = mkdtempSync(join(tmpdir(), 'vps07-restore-'));
const livePath = join(work, 'live.sqlite');
const backupDir = join(mkdtempSync(join(tmpdir(), 'vps07-remote-')), 'remote.sqlite');
const scratchPath = join(work, 'scratch.sqlite');
process.env.SQLITE_PATH = livePath;

const { bindings, ensureSchema } = await import('../db/runtime.ts');
const { runtimeMigrations } = await import('../db/migrations.ts');
await ensureSchema();
const { db } = bindings();

const now = new Date().toISOString();
const userId = `vps07-${Date.now()}`;
const vacancyId = `vac-vps07-${Date.now()}`;
const jobId = `job-vps07-${Date.now()}`;

await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(userId, `vps07-${Date.now()}@example.test`, 'x', 'user', now).run();
await db.prepare(`INSERT INTO vacancies (id, canonical_url, title, company, description, content_hash,
    identity_fingerprint, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, 'https://example.com/vps07', 'Engineer', 'Example', 'English-only role',
    'h', 'fp-vps07', now, now, now, now).run();
await db.prepare(`INSERT INTO vacancy_sources (vacancy_id, source_key, source_name, canonical_url,
    source_job_id, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, 'example.com', 'Example', 'https://example.com/vps07', '1', 'nl', now, now).run();
await db.prepare(`INSERT INTO user_vacancy_state (user_id, job_id, vacancy_id, is_saved, application_status,
    visibility_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(userId, jobId, vacancyId, 1, 'not_applied', 'active', now, now).run();

const liveVersions = (await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
  .results.map((row) => row.version);
const liveCounts = {};
for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
  liveCounts[table] = await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first('total');
}

// BACK UP: checkpoint WAL into the file first. In production this line is
// `litestream replicate` running continuously; the checkpoint is spelled out
// here because a copy without one is exactly the truncated-restore failure
// the drill exists to catch.
{
  const checkpoint = new DatabaseSync(livePath);
  try {
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
}
copyFileSync(livePath, backupDir);
for (const suffix of ['-wal', '-shm', '-journal']) {
  if (existsSync(livePath + suffix)) copyFileSync(livePath + suffix, backupDir + suffix);
}

// RESTORE: production runs `litestream restore -o <scratch> <replica-url>`
// with both units stopped, then serves the app from the scratch copy. Here
// the copy stands in for the replica.
copyFileSync(backupDir, scratchPath);
for (const suffix of ['-wal', '-shm', '-journal']) {
  if (existsSync(backupDir + suffix)) copyFileSync(backupDir + suffix, scratchPath + suffix);
}

const restored = new DatabaseSync(scratchPath);
restored.exec('PRAGMA foreign_keys = ON');
const restoredVersions = restored.prepare('SELECT version FROM schema_migrations ORDER BY version')
  .all().map((row) => row.version);
const restoredCounts = {};
for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
  restoredCounts[table] = restored.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
}
// A good restore opens clean; a truncated one fails here with
// "file is not a database" or "database disk image is malformed".
let integrity = '';
try {
  integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
} catch (error) {
  integrity = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
}
const joinRow = restored.prepare(`SELECT v.title, s.source_key, st.is_saved
  FROM vacancies v
  JOIN vacancy_sources s ON s.vacancy_id = v.id
  JOIN user_vacancy_state st ON st.vacancy_id = v.id
  WHERE st.user_id = ? AND v.id = ?`).get(userId, vacancyId);
restored.close();

const expected = runtimeMigrations.map((migration) => migration.version);
const evidence = {
  schemaVersion: restoredVersions.at(-1),
  versionsMatchLive: JSON.stringify(restoredVersions) === JSON.stringify(liveVersions),
  ensureSchemaNoOp: JSON.stringify(restoredVersions) === JSON.stringify(expected),
  countsMatch: JSON.stringify(restoredCounts) === JSON.stringify(liveCounts),
  counts: restoredCounts,
  integrity,
  joinOk: joinRow?.title === 'Engineer' && joinRow?.source_key === 'example.com' && joinRow?.is_saved === 1,
};
console.log(JSON.stringify(evidence, null, 2));

if (!evidence.versionsMatchLive || !evidence.ensureSchemaNoOp || !evidence.countsMatch
    || evidence.integrity !== 'ok' || !evidence.joinOk) {
  console.error('Restore drill FAILED: the restored copy is not serving the same state.');
  process.exit(1);
}
console.log('Restore drill PASS: scratch copy reports the live version, counts, integrity ok, and the catalogue join.');
