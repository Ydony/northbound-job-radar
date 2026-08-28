import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeMigrations } from '../db/migrations';

test('runtime migrations are ordered and contain one statement per prepared query', () => {
  assert.deepEqual(runtimeMigrations.map((migration) => migration.version), [1, 2, 3, 4, 5]);
  for (const migration of runtimeMigrations) {
    assert.equal(migration.statements.length > 0, true);
    assert.equal(migration.statements.every((statement) => statement.trim().length > 0 && !/;\s*\S/.test(statement)), true);
  }
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
