import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CV_REMOVAL_VERSION, runtimeMigrations } from '../db/migrations';

test('runtime migrations are ordered and contain one statement per prepared query', () => {
  assert.deepEqual(runtimeMigrations.map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
  for (const migration of runtimeMigrations) {
    assert.equal(migration.statements.length > 0, true);
    assert.equal(migration.statements.every((statement) => statement.trim().length > 0 && !/;\s*\S/.test(statement)), true);
  }
});

test('the final schema removes CV storage without recreating it after restart', async () => {
  const migration = runtimeMigrations.find((entry) => entry.version === CV_REMOVAL_VERSION);
  assert.ok(migration);
  assert.match(migration.statements.join('\n'), /DROP TABLE IF EXISTS cvs/);
  const runtime = await readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /schemaStatements\.slice\(appliedVersions\.has\(CV_REMOVAL_VERSION\) \? 1 : 0\)/);
});

test('Job-Room backfill migration records successful detail fetches per owned job', () => {
  const sql = runtimeMigrations[15].statements.join('\n');
  assert.match(sql, /job_room_detail_version INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /jobs\(user_id, source_key, job_room_detail_version\)/);
});

test('Job-Room posting-date backfill tracks date repair separately from text repair', () => {
  // A row upgraded to full text is still dateless until re-fetched for its date, and a
  // full-length row stored dateless was never eligible for the text repair at all — so the
  // date repair needs its own version marker rather than reusing job_room_detail_version.
  const sql = runtimeMigrations[21].statements.join('\n');
  assert.match(sql, /job_room_posted_at_version INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /jobs\(user_id, source_key, job_room_posted_at_version\)/);
});

test('expiry is a stored date, not a re-fetch', () => {
  // #97: publication.endDate was checked at import and discarded, so a stored card kept
  // looking current after its window closed. The date is now kept; no request is needed to
  // derive expiry, and empty means "no expiry published", never "expired".
  const sql = runtimeMigrations[22].statements.join('\n');
  assert.match(sql, /ALTER TABLE jobs ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''/);
});

test('page-fetch rejections are remembered per owner, with roles for role mismatches', () => {
  // #93: four permanently-unimportable listings at the head of a page-fetching source starved
  // everything behind them, because a rejected URL was written nowhere. The table keys a
  // rejection to its owner like jobs and dismissed_jobs do, and carries the roles a
  // role-mismatch was judged against so a later change of roles reconsiders the listing.
  const sql = runtimeMigrations[23].statements.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rejected_listings/);
  assert.match(sql, /user_id TEXT NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS rejected_user_canonical_idx ON rejected_listings\(user_id, canonical_url\)/);
  assert.match(sql, /rejected_user_source_identity_idx ON rejected_listings\(user_id, source_key, source_job_id\)/);
});

test('cross-source fingerprints require a posting day', () => {
  const sql = runtimeMigrations[2].statements.join('\n');
  assert.match(sql, /posted_at = ''/);
  assert.match(sql, /dismissed_jobs/);
});

test('legacy identity migration normalizes URLs and preserves dismissed-job tombstones', () => {
  const sql = runtimeMigrations[1].statements.join('\n');
  assert.match(sql, /rtrim\(canonical_url/);
  assert.match(sql, /source_job_id/);
  assert.match(sql, /INSERT OR IGNORE INTO dismissed_jobs/);
});

test('multi-source migration preserves legacy jobs while adding required state', () => {
  const sql = runtimeMigrations[0].statements.join('\n');
  assert.match(sql, /ALTER TABLE jobs ADD COLUMN application_status/);
  assert.match(sql, /visibility_status/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS search_runs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dismissed_jobs/);
  assert.match(sql, /CASE WHEN status = 'ignored' THEN 'dismissed'/);
});

test('workplace migration separates "not yet detected" from a detected "unknown"', () => {
  const added = runtimeMigrations[3].statements.join('\n');
  assert.match(added, /ALTER TABLE jobs ADD COLUMN workplace_type/);
  // Empty is the not-yet-analysed marker the backfill looks for; 'unknown' is a real verdict.
  assert.match(added, /DEFAULT ''/);
  const reset = runtimeMigrations[4].statements.join('\n');
  assert.match(reset, /workplace_type = '' WHERE workplace_type = 'unknown'/);
});

test('tenancy migration adds an owner to every table holding user data', () => {
  const sql = runtimeMigrations[5].statements.join('\n');
  for (const table of ['cvs', 'jobs', 'search_settings', 'search_roles', 'language_feedback',
    'dismissed_jobs', 'search_runs']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN user_id`), `${table} has no owner column`);
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/);
});

test('uniqueness is scoped per owner so one account cannot block another', () => {
  const sql = runtimeMigrations[6].statements.join('\n');
  // A global UNIQUE on source_url would let the first user to import a vacancy block everyone else.
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS jobs_user_source_url_idx ON jobs\(user_id, source_url\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS cvs_user_slot_idx ON cvs\(user_id, slot\)/);
  assert.match(sql, /INSERT INTO jobs_rebuilt SELECT/, 'the old UNIQUE constraint needs a table rebuild');

  const searchRoleSql = runtimeMigrations[10].statements.join('\n');
  assert.match(searchRoleSql, /DROP INDEX IF EXISTS search_roles_position_idx/);
  assert.match(searchRoleSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS search_roles_user_position_idx ON search_roles\(user_id, position\)/);
});

test('fresh databases reach every migration: base columns must not duplicate a later ALTER', async () => {
  // Found because a fresh checkout failed its first request: the legacy base created
  // search_settings already carrying search_netherlands/search_switzerland, so migration 18's
  // ALTER TABLE ADD COLUMN failed with "duplicate column name" and every request 500'd.
  // Existing databases never noticed (their tables predate the columns and migrate cleanly),
  // which is exactly why the overlap needs a test rather than just a fix.
  const runtime = await readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8');
  const added = new Set(
    runtimeMigrations.flatMap((migration) => migration.statements).flatMap((statement) => {
      const match = statement.match(/ALTER TABLE \w+ ADD COLUMN (\w+)/);
      return match ? [match[1]] : [];
    }),
  );
  const baseTables = [...runtime.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\)`/g)];
  assert.ok(baseTables.length > 0, 'expected base CREATE TABLE statements in db/runtime.ts');
  for (const [, table, columns] of baseTables) {
    for (const column of added) {
      assert.doesNotMatch(columns, new RegExp(`\\b${column}\\b`),
        `base table ${table} already defines ${column}, which a migration re-adds`);
    }
  }
});
