import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteDatabase } from '../db/sqlite-adapter';
import { runtimeMigrations } from '../db/migrations';

/**
 * VPS-03 (#196): the self-hosted stack, proved on a synthetic SQLite database.
 *
 * The production `wrangler d1 export` step is owner-run and never enters the
 * repo, an issue, or a transcript — so what is proved here is the shape of
 * that step: a SQLite file the adapter opens, `ensureSchema()` building the
 * full schema on it, a second `ensureSchema()` being a no-op, and the
 * catalogue-split tables (`vacancies` / `vacancy_sources` /
 * `user_vacancy_state` from migration 30) joining correctly for one account.
 *
 * Adapter semantics are pinned too, because ~197 call sites rely on them:
 * `bind` returning a new statement, `first`/`all`/`run` shapes,
 * `.meta.changes`, all-or-nothing `batch()`, and rejecting `undefined`
 * bindings the way D1 does.
 */

const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-'));
const dbPath = join(dir, 'adapter.sqlite');

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // node:sqlite handles stay open for the process lifetime (the adapter
    // caches one handle per path), which blocks deletion on Windows. The
    // files live under the OS temp dir; leaving them is harmless.
  }
});

test('prepare/bind/first/all/run match the D1 shapes callers rely on', async () => {
  const db = openSqliteDatabase(join(dir, 'shapes.sqlite')) as unknown as D1Database;
  await db.prepare('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL DEFAULT 0)').run();
  const inserted = await db.prepare('INSERT INTO t (id, n) VALUES (?, ?)').bind('a', 3).run();
  assert.equal(inserted.success, true);
  assert.equal(inserted.meta.changes, 1);

  // `bind` returns a NEW statement: rebinding the same base must not alias.
  const base = db.prepare('INSERT INTO t (id, n) VALUES (?, ?)');
  await base.bind('b', 1).run();
  await base.bind('c', 2).run();
  const count = await db.prepare('SELECT COUNT(*) AS total FROM t').first<{ total: number }>();
  assert.equal(count?.total, 3);

  const one = await db.prepare('SELECT n FROM t WHERE id = ?').bind('a').first<{ n: number }>();
  assert.equal(one?.n, 3);
  const col = await db.prepare('SELECT n FROM t WHERE id = ?').bind('a').first<number>('n');
  assert.equal(col, 3);
  const missing = await db.prepare('SELECT n FROM t WHERE id = ?').bind('zzz').first('n');
  assert.equal(missing, null);

  const all = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: string }>();
  assert.deepEqual(all.results.map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(all.success, true);
});

test('batch is one all-or-nothing transaction', async () => {
  const db = openSqliteDatabase(join(dir, 'batch.sqlite')) as unknown as D1Database;
  await db.prepare('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)').run();
  await db.prepare("INSERT INTO t (id) VALUES ('keep')").run();
  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO t (id) VALUES ('new')"),
      // Duplicate primary key: the whole batch must roll back, not half-apply.
      db.prepare("INSERT INTO t (id) VALUES ('keep')"),
    ]),
  );
  const rows = await db.prepare('SELECT id FROM t').all<{ id: string }>();
  assert.deepEqual(rows.results.map((row) => row.id), ['keep']);
});

test('undefined bindings fail loudly instead of writing NULL', async () => {
  const db = openSqliteDatabase(join(dir, 'undef.sqlite')) as unknown as D1Database;
  await db.prepare('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL)').run();
  await assert.rejects(db.prepare('INSERT INTO t (id) VALUES (?)').bind(undefined).run(), TypeError);
});

test('a write with RETURNING hands back its rows, not an empty result', async () => {
  // This is the bug that made the whole app unusable on the self-hosted target while every unit
  // test passed. `returnsRows()` looked only at the leading keyword, so `durableRateLimit`'s
  // atomic `INSERT ... ON CONFLICT ... RETURNING count, reset_at` was routed to `run()`, which
  // yields no rows. That limiter fails closed, so every registration and sign-in answered 503.
  // D1 has one statement that both writes and reads, so nothing running against D1 could see it.
  const db = openSqliteDatabase(join(dir, 'returning.sqlite')) as unknown as D1Database;
  await db.prepare('CREATE TABLE buckets (bucket TEXT PRIMARY KEY NOT NULL, count INTEGER NOT NULL)').run();

  const inserted = await db.prepare(`INSERT INTO buckets (bucket, count) VALUES (?, 1)
    ON CONFLICT(bucket) DO UPDATE SET count = buckets.count + 1
    RETURNING count`).bind('auth:ip:local').first<{ count: number }>();
  assert.equal(inserted?.count, 1, 'the inserted row must come back');

  const bumped = await db.prepare(`INSERT INTO buckets (bucket, count) VALUES (?, 1)
    ON CONFLICT(bucket) DO UPDATE SET count = buckets.count + 1
    RETURNING count`).bind('auth:ip:local').first<{ count: number }>();
  assert.equal(bumped?.count, 2, 'the conflicting upsert must come back with the new count');

  // `.meta.changes` is read in 25 places, and `all()` reports no count of its own. One row per
  // affected row is what D1 would report.
  const many = await db.prepare('UPDATE buckets SET count = count + 1 RETURNING bucket').all();
  assert.equal(many.results.length, 1);
  assert.equal(many.meta.changes, 1, 'a RETURNING write still reports its change count');

  // A value containing the letters is not a RETURNING clause.
  const plain = await db.prepare('INSERT INTO buckets (bucket, count) VALUES (?, 0)').bind('returning-soon').run();
  assert.equal(plain.meta.changes, 1);
  assert.deepEqual(plain.results, []);
});

test('the adapter opens in WAL mode with foreign keys on', async () => {
  openSqliteDatabase(join(dir, 'pragmas.sqlite'));
  const raw = new DatabaseSync(join(dir, 'pragmas.sqlite'));
  try {
    const journal = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(journal.journal_mode.toLowerCase(), 'wal');
    const keys = raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(keys.foreign_keys, 1);
  } finally {
    raw.close();
  }
});

test('ensureSchema builds the full schema on SQLite and is a no-op on rerun', async () => {
  process.env.SQLITE_PATH = dbPath;
  const { bindings, ensureSchema } = await import('../db/runtime');
  await ensureSchema();
  const { db } = bindings();
  const expected = Math.max(...runtimeMigrations.map((migration) => migration.version));

  const versions = await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all<{ version: number }>();
  assert.deepEqual(versions.results.map((row) => row.version), runtimeMigrations.map((migration) => migration.version));
  assert.equal(versions.results.at(-1)?.version, expected);

  const before = versions.results.length;
  await ensureSchema();
  const after = await db.prepare('SELECT COUNT(*) AS total FROM schema_migrations').first<{ total: number }>();
  assert.equal(after?.total, before);

  for (const table of ['jobs', 'users', 'vacancies', 'vacancy_sources', 'user_vacancy_state', 'search_runs']) {
    const found = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(table)
      .first<{ name: string }>();
    assert.equal(found?.name, table, `missing table ${table}`);
  }
});

test('the catalogue split joins correctly for one account on SQLite', async () => {
  process.env.SQLITE_PATH = dbPath;
  const { bindings } = await import('../db/runtime');
  const { db } = bindings();
  const userId = `sqlite-adapter-${Date.now()}`;
  const vacancyId = `vac-${Date.now()}`;
  const jobId = `job-${Date.now()}`;

  await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, `sqlite-${Date.now()}@example.test`, 'x', 'user', new Date().toISOString()).run();
  await db.prepare(`INSERT INTO vacancies (id, canonical_url, title, company, description, content_hash,
      identity_fingerprint, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(vacancyId, 'https://example.com/j/1', 'Engineer', 'Example', 'English-only role', 'h',
      'fp-1', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();
  await db.prepare(`INSERT INTO vacancy_sources (vacancy_id, source_key, source_name, canonical_url,
      source_job_id, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(vacancyId, 'example.com', 'Example', 'https://example.com/j/1', '1', 'nl',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();
  await db.prepare(`INSERT INTO user_vacancy_state (user_id, job_id, vacancy_id, is_saved, application_status,
      visibility_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, jobId, vacancyId, 1, 'not_applied', 'active',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();

  const row = await db.prepare(`SELECT v.title, s.source_key, st.is_saved
      FROM vacancies v
      JOIN vacancy_sources s ON s.vacancy_id = v.id
      JOIN user_vacancy_state st ON st.vacancy_id = v.id
      WHERE st.user_id = ? AND v.id = ?`)
    .bind(userId, vacancyId)
    .first<{ title: string; source_key: string; is_saved: number }>();
  assert.equal(row?.title, 'Engineer');
  assert.equal(row?.source_key, 'example.com');
  assert.equal(row?.is_saved, 1);

  await db.batch([
    db.prepare('DELETE FROM user_vacancy_state WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vacancy_sources WHERE vacancy_id = ?').bind(vacancyId),
    db.prepare('DELETE FROM vacancies WHERE id = ?').bind(vacancyId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
});
