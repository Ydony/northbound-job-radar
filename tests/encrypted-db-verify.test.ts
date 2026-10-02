import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteDatabase } from '../db/sqlite-adapter';
import { runtimeMigrations } from '../db/migrations';

/**
 * T31 (F11): encrypted-database migration, WAL/temp behavior and SQL
 * compatibility on fresh/existing synthetic databases.
 *
 * Synthetic fixtures only (TEST-NET addresses, `example.test` mail).
 *
 * T30 has landed as fail-closed key injection (`db/encryption.ts`: key
 * resolution from SQLITE_KEY_FILE/SQLITE_KEY, `decideDatabaseOpen` gate,
 * keyed opens refused on the cipherless `node:sqlite` driver), but the
 * owner-selected cipher driver from T29 has not: at-rest encryption is still
 * plaintext. So the leak-assertion tests below still document the PLAINTEXT
 * BASELINE — they assert the synthetic markers ARE readable in a copied DB,
 * its WAL, and its backup copy, which is exactly the F11 acceptance failure
 * the cipher must fix. When the cipher lands these tests must be
 * inverted/rewired to the provider (wrong/missing keys fail, correct keys
 * recover, artifacts scan clean); the mechanical tests (migration, SQL
 * compat, restore) must keep passing unchanged.
 */

const dir = mkdtempSync(join(tmpdir(), 't31-encdb-test-'));
const dbPath = join(dir, 'encdb.sqlite');
process.env.SQLITE_PATH = dbPath;

const stamp = Date.now();
const M = {
  email: `synth-t31-${stamp}@example.test`,
  hash: `T31-SYNTH-HASH-${stamp}`,
  role: `T31-SYNTH-ROLE-${stamp}`,
  company: `T31-SYNTH-COMPANY-${stamp}`,
  note: `T31-PLAINTEXT-MARKER-${stamp}`,
};
const markers = Object.values(M);
const userId = `t31-user-${stamp}`;
const vacancyId = `t31-vac-${stamp}`;
const jobId = `t31-job-${stamp}`;

function rawHits(path: string): string[] {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  return markers.filter((m) => bytes.includes(m));
}

test.after(() => {
  // Handles stay open for the process lifetime (adapter cache); temp files
  // are left for the OS to reap, same as sqlite-adapter.test.ts.
});

test('fresh database migrates to the latest version with all private tables', async () => {
  const { bindings, ensureSchema } = await import('../db/runtime');
  await ensureSchema();
  const { db } = bindings();
  const versions = await db.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all<{ version: number }>();
  assert.deepEqual(
    versions.results.map((r) => r.version),
    runtimeMigrations.map((m) => m.version),
  );
  for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state',
    'language_feedback', 'search_roles', 'auth_events', 'search_runs', 'dismissed_jobs']) {
    const found = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(table).first<{ name: string }>();
    assert.equal(found?.name, table, `missing table ${table}`);
  }
});

test('existing database keeps synthetic fixtures across a schema rerun', async () => {
  const { bindings, ensureSchema } = await import('../db/runtime');
  const { db } = bindings();
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, M.email, M.hash, 'user', now).run();
  await db.prepare('INSERT INTO search_roles (id, position, role, updated_at, user_id) VALUES (?, ?, ?, ?, ?)')
    .bind(`t31-sr-${stamp}`, 0, M.role, now, userId).run();
  await db.prepare(`INSERT INTO vacancies (id, canonical_url, title, company, description, content_hash,
      identity_fingerprint, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(vacancyId, `https://example.com/t31/${stamp}`, `Engineer ${M.note}`, M.company,
      `English-only role ${M.note}`, 'h', `fp-t31-${stamp}`, now, now, now, now).run();
  await db.prepare(`INSERT INTO vacancy_sources (vacancy_id, source_key, source_name, canonical_url,
      source_job_id, country, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(vacancyId, 'example.com', 'Example', `https://example.com/t31/${stamp}`, '1', 'nl', now, now).run();
  await db.prepare(`INSERT INTO user_vacancy_state (user_id, job_id, vacancy_id, is_saved, application_status,
      visibility_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, jobId, vacancyId, 1, 'applied', 'active', now, now).run();
  await db.prepare('INSERT INTO language_feedback (job_id, verdict, corrected_status, reason, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(jobId, 'incorrect', 'pass', M.note, now, userId).run();

  // The "existing database" path: schema rerun must change nothing.
  await ensureSchema();
  const versions = await db.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all<{ version: number }>();
  assert.deepEqual(versions.results.map((r) => r.version), runtimeMigrations.map((m) => m.version));

  const row = await db.prepare(`SELECT v.title, s.source_key, st.is_saved
      FROM vacancies v
      JOIN vacancy_sources s ON s.vacancy_id = v.id
      JOIN user_vacancy_state st ON st.vacancy_id = v.id
      WHERE st.user_id = ? AND v.id = ?`)
    .bind(userId, vacancyId)
    .first<{ title: string; source_key: string; is_saved: number }>();
  assert.equal(row?.source_key, 'example.com');
  assert.equal(row?.is_saved, 1);
  assert.ok(row?.title.includes(M.note));
});

test('plaintext baseline: a copied database file reveals the private fixtures', async () => {
  // F11 acceptance failure, asserted as documentation until T30 lands: a
  // copied ordinary SQLite file containing readable private records fails,
  // even with disk encryption. A string scan alone is not proof of
  // encryption — but hits here ARE proof of its absence.
  //
  // Recent writes live in the WAL sidecar until a checkpoint merges them
  // into the main file (which is also why a naive `cp` without the WAL is
  // not a backup), so the "copied database" is main + WAL together.
  const hits = new Set([...rawHits(dbPath), ...rawHits(dbPath + '-wal')]);
  assert.ok(hits.size > 0, 'expected synthetic markers readable in the copied DB/WAL files');
  assert.ok(hits.has(M.note), 'expected the vacancy/feedback marker in the raw bytes');
});

test('plaintext baseline: WAL/temp artifacts are inventoried and leak when present', async () => {
  // Leave uncheckpointed frames so the WAL actually holds content to scan.
  const raw = new DatabaseSync(dbPath);
  try {
    assert.equal(String((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toLowerCase(), 'wal');
    raw.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } finally {
    raw.close();
  }
  assert.ok(existsSync(dbPath + '-wal'), 'expected WAL sidecar alongside a WAL-mode database');
  const walHits = rawHits(dbPath + '-wal');
  assert.ok(walHits.length > 0, 'expected synthetic markers readable in the WAL sidecar');
  // No statement-level journal in WAL mode; a stray one would mean the mode
  // did not apply and the backup story below would be wrong.
  assert.equal(existsSync(dbPath + '-journal'), false);
});

test('SQL compatibility: the D1-dialect surface behaves identically', async () => {
  const { bindings } = await import('../db/runtime');
  const { db } = bindings();

  await db.prepare('CREATE TABLE t31_compat (bucket TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL DEFAULT 0)').run();
  const one = await db.prepare(`INSERT INTO t31_compat (bucket, n) VALUES (?, 1)
    ON CONFLICT(bucket) DO UPDATE SET n = t31_compat.n + 1 RETURNING n`).bind('b').first<{ n: number }>();
  const two = await db.prepare(`INSERT INTO t31_compat (bucket, n) VALUES (?, 1)
    ON CONFLICT(bucket) DO UPDATE SET n = t31_compat.n + 1 RETURNING n`).bind('b').first<{ n: number }>();
  assert.equal(one?.n, 1);
  assert.equal(two?.n, 2);

  await db.prepare('CREATE TABLE t31_compat_batch (id TEXT PRIMARY KEY NOT NULL)').run();
  await db.prepare("INSERT INTO t31_compat_batch (id) VALUES ('keep')").run();
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO t31_compat_batch (id) VALUES ('new')"),
    db.prepare("INSERT INTO t31_compat_batch (id) VALUES ('keep')"),
  ]));
  const rows = await db.prepare('SELECT id FROM t31_compat_batch').all<{ id: string }>();
  assert.deepEqual(rows.results.map((r) => r.id), ['keep']);

  await assert.rejects(
    db.prepare('INSERT INTO t31_compat_batch (id) VALUES (?)').bind(undefined).run(),
    TypeError,
  );

  const dialect = await db.prepare(`SELECT datetime('now') AS ts,
    json_extract(?, '$.a') AS j, (? LIKE ?) AS lk`)
    .bind('{"a":1}', 'jobs.ch/abc', '%jobs.ch%')
    .first<{ ts: string; j: number; lk: number }>();
  assert.equal(dialect?.j, 1);
  assert.equal(dialect?.lk, 1);
  assert.equal(typeof dialect?.ts, 'string');

  const raw = new DatabaseSync(dbPath);
  try {
    assert.equal((raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  } finally {
    raw.close();
  }
});

test('backup drill: checkpoint-then-copy restores the same state (and the same leak)', async () => {
  const { bindings } = await import('../db/runtime');
  const { db } = bindings();
  const before = await db.prepare('SELECT COUNT(*) AS total FROM user_vacancy_state WHERE user_id = ?')
    .bind(userId).first<{ total: number }>();

  {
    const checkpoint = new DatabaseSync(dbPath);
    try {
      checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      checkpoint.close();
    }
  }
  const backupPath = join(dir, 'backup.sqlite');
  const scratchPath = join(dir, 'scratch.sqlite');
  copyFileSync(dbPath, backupPath);
  assert.ok(rawHits(backupPath).includes(M.note), 'backup copy carries the same plaintext leak');
  assert.equal(
    readdirSync(dir).some((f) => /key|secret|\.env/i.test(f) && f !== 'backup.sqlite' && f !== 'scratch.sqlite'),
    false,
    'no key material travels with the backup',
  );

  // The copy must serve the same state: versions, counts, catalogue join.
  copyFileSync(backupPath, scratchPath);
  const scratch = new DatabaseSync(scratchPath);
  scratch.exec('PRAGMA foreign_keys = ON');
  try {
    const versions = scratch.prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all().map((r) => r.version);
    assert.deepEqual(versions, runtimeMigrations.map((m) => m.version));
    assert.equal(
      (scratch.prepare('SELECT COUNT(*) AS total FROM user_vacancy_state WHERE user_id = ?').get(userId) as { total: number }).total,
      before?.total,
    );
    const row = scratch.prepare(`SELECT s.source_key, st.is_saved FROM vacancy_sources s
      JOIN user_vacancy_state st ON st.vacancy_id = s.vacancy_id
      WHERE st.user_id = ? AND s.vacancy_id = ?`).get(userId, vacancyId) as
      { source_key: string; is_saved: number } | undefined;
    assert.equal(row?.source_key, 'example.com');
    assert.equal(row?.is_saved, 1);
    assert.equal((scratch.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  } finally {
    scratch.close();
  }
});

test('no cipher is wired up yet: T30 refuses keyed opens fail-closed, cipher still pending', async () => {
  // T30 landed: the adapter has a key-injection point (`options.key`) and
  // `db/encryption.ts` gates opens — but the `node:sqlite` driver ships no
  // cipher, so any keyed open is refused rather than silently downgraded to
  // plaintext. When the owner-selected cipher driver lands this test must be
  // replaced by wrong-key-fails / right-key-recovers checks, not deleted:
  // the mechanical tests above must keep passing unchanged behind the same
  // D1 interface.
  const { decideDatabaseOpen } = await import('../db/encryption');
  assert.equal(openSqliteDatabase.length, 2);
  assert.throws(
    () => openSqliteDatabase(join(dir, 'keyed-should-refuse.sqlite'), { key: 'T31-SYNTH-KEY' }),
    /no cipher|refusing to open/i,
    'keyed open must fail closed, never silently open plaintext',
  );
  assert.throws(
    () =>
      decideDatabaseOpen({
        path: join(dir, 'keyed-should-refuse.sqlite'),
        key: { source: 'SQLITE_KEY', key: 'T31-SYNTH-KEY' },
        encryptionRequired: false,
        driverSupportsEncryption: false,
      }),
    /no cipher|refusing to open/i,
  );
  // Unkeyed opens pass the gate: that is why the mechanical tests above run
  // unchanged on the plaintext baseline.
  decideDatabaseOpen({
    path: dbPath,
    key: undefined,
    encryptionRequired: false,
    driverSupportsEncryption: false,
  });
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = JSON.stringify({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).toLowerCase();
  for (const name of ['sqlcipher', 'sqlite3mc', 'multiple-ciphers', 'wa-sqlite']) {
    assert.equal(deps.includes(name), false, `unexpected encryption dependency ${name}`);
  }
  for (const name of ['SQLITE_KEY', 'ENCRYPTED_DB_KEY', 'DB_ENCRYPTION_KEY']) {
    assert.equal(typeof process.env[name] === 'string' && process.env[name] !== '', false);
  }
});
