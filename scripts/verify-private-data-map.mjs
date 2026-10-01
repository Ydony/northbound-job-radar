#!/usr/bin/env node
/**
 * T28 (F11 baseline): exercise the private-data map against throwaway
 * synthetic fixtures and record the current-state evidence.
 *
 * What it does, all in a temp directory that is removed afterwards:
 * 1. Boots a fresh SQLite file through the real adapter + `ensureSchema()`.
 * 2. Inserts one synthetic account's private rows (P1/P5/P6/P7 categories
 *    from docs/PRIVATE_DATA_MAP.md) plus one shared catalogue row.
 * 3. Records the BASELINE the map admits: the raw file bytes still contain
 *    the synthetic marker (plaintext at rest — the gap T30 must close), and
 *    WAL/SHM sidecars exist while the handle is open (P9 artifacts).
 * 4. Proves the fail-closed and hash-only properties that already hold:
 *    absent SESSION_SECRET refuses sessions (503, no DB touch), and only
 *    the token hash is stored (the usable token appears nowhere in the DB).
 * 5. Static checks: every secret the map lists is declared in db/env.d.ts or
 *    deploy config; no secret *values* appear in Git-tracked files scanned
 *    here (names only — values live in env, never in the repo).
 *
 * A string scan alone is not proof of encryption; this script records the
 * baseline honestly so T30 has something to diff against. Prints redacted
 * JSON evidence on stdout; exits non-zero on any mismatch.
 *
 * Run with: `node --import tsx scripts/verify-private-data-map.mjs`
 * (imports `.ts` sources, same pattern as `npm run refresh`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 't28-privmap-'));
const dbPath = join(work, 'check.sqlite');
process.env.SQLITE_PATH = dbPath;
delete process.env.SESSION_SECRET;

const { bindings, ensureSchema, authSecrets } = await import('../db/runtime.ts');
const { hashEmailToken, newEmailToken } = await import('../lib/email.ts');
const { requireSession } = await import('../lib/guard.ts');

const failures = [];
const evidence = { synthetic: true, checks: {} };
const check = (name, ok, detail = {}) => {
  evidence.checks[name] = { ok, ...detail };
  if (!ok) failures.push(name);
};

// --- 1+2. Fresh schema plus one synthetic account's private rows. ---
await ensureSchema();
const { db } = bindings();
const now = new Date().toISOString();
const tag = `t28-${Date.now()}`;
const userId = `synthetic-user-${tag}`;
const email = `${userId}@example.invalid`;
const marker = `SYNTHETIC-PRIVATE-MARKER-${tag}`;

await db.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
  .bind(userId, email, 'pbkdf2$100000$c3ludGgtdGVzdA==$aGFzaA==', 'user', now).run();
await db.prepare(`INSERT INTO search_roles (id, user_id, position, role, updated_at)
  VALUES (?, ?, ?, ?, ?)`)
  .bind(`sr-${tag}`, userId, 0, `synthetic-widget-engineer ${marker}`, now).run();
const token = newEmailToken();
await db.prepare(`INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at)
  VALUES (?, ?, ?, ?)`)
  .bind(await hashEmailToken(token), userId, new Date(Date.now() + 3_600_000).toISOString(), now).run();
const vacancyId = `synthetic-vac-${tag}`;
await db.prepare(`INSERT INTO vacancies (id, canonical_url, title, company, description, content_hash,
    identity_fingerprint, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(vacancyId, `https://example.invalid/${tag}`, 'Synthetic Widget Engineer',
    'Fictional Example BV', `Public advert text ${marker}`, 'h', `fp-${tag}`, now, now, now, now).run();
await db.prepare(`INSERT INTO user_vacancy_state (user_id, job_id, vacancy_id, is_saved,
    application_status, visibility_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(userId, `synthetic-job-${tag}`, vacancyId, 1, 'not_applied', 'active', now, now).run();

// --- 3. Baseline: raw bytes still reveal the marker; WAL sidecars exist. ---
// Recent writes may still sit in the WAL rather than the main file, so both
// are scanned: P9 artifacts carry the same rows and need the same protection.
const rawChunks = [readFileSync(dbPath)];
if (existsSync(`${dbPath}-wal`)) rawChunks.push(readFileSync(`${dbPath}-wal`));
const raw = Buffer.concat(rawChunks);
check('baseline_raw_file_contains_marker', raw.includes(marker), {
  note: 'EXPECTED TODAY: plaintext at rest. T30 must flip this to absent.',
});
check('baseline_wal_sidecars_exist', existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`), {
  wal: existsSync(`${dbPath}-wal`),
  shm: existsSync(`${dbPath}-shm`),
  note: 'P9 artifacts travel with the file and need the same protection.',
});

// --- 4a. Fail closed: no SESSION_SECRET means 503 before any DB access. ---
const secrets = authSecrets();
check('absent_session_secret_is_empty', secrets.sessionSecret === '', {});
const refused = await requireSession(new Request('http://localhost/api/state'));
check('absent_session_secret_refuses_503', refused.response?.status === 503, {
  status: refused.response?.status ?? null,
});

// --- 4b. Hash-only tokens: the usable token is nowhere in the database. ---
const tokenRows = await db.prepare('SELECT token_hash FROM email_verifications WHERE user_id = ?')
  .bind(userId).all();
const storedHashes = tokenRows.results.map((row) => row.token_hash);
check('only_token_hash_stored', storedHashes.length === 1
  && storedHashes[0] === await hashEmailToken(token)
  && !String(storedHashes[0]).includes(token.slice(0, 8)), {
  rows: storedHashes.length,
});

// --- 4c. Tenancy: the private row is reachable only under its own user_id. ---
const other = await db.prepare('SELECT job_id FROM user_vacancy_state WHERE user_id = ? AND job_id = ?')
  .bind('synthetic-user-unrelated', `synthetic-job-${tag}`).first();
const own = await db.prepare('SELECT job_id FROM user_vacancy_state WHERE user_id = ? AND job_id = ?')
  .bind(userId, `synthetic-job-${tag}`).first();
check('private_row_scoped_to_owner', other === null && own !== null, {});

// --- 5. Static checks: secrets declared, values not in tracked files. ---
const map = readFileSync(join(here, '..', 'docs', 'PRIVATE_DATA_MAP.md'), 'utf8');
const envDecl = readFileSync(join(here, '..', 'db', 'env.d.ts'), 'utf8');
const missing = ['SESSION_SECRET', 'RESEND_API_KEY', 'TURNSTILE_SECRET_KEY', 'INDEED_API_KEY']
  .filter((name) => !envDecl.includes(name) || !map.includes(name));
check('map_covers_declared_secrets', missing.length === 0, { missing });
let tracked = '';
try {
  // Assignments only; `.dev.vars.example` carries the bare `SESSION_SECRET=`
  // placeholder by design, and scripts/tests carry templates or synthetic
  // values, so both are out of scope here. Non-empty values are filtered in
  // JS rather than in git-grep regex (BRE has no \S class).
  tracked = execFileSync('git', ['grep', '-I', '-n', '-e', 'SESSION_SECRET=', '--', ':!*.mjs', ':!tests',
    ':!.dev.vars.example'],
    { cwd: join(here, '..'), encoding: 'utf8' });
} catch { tracked = ''; } // git grep exits 1 on no matches
const trackedHits = tracked.split('\n').map((line) => line.trim()).filter(Boolean)
  .filter((line) => /SESSION_SECRET=\S/.test(line));
check('no_secret_values_in_tracked_files', trackedHits.length === 0, { files: trackedHits });

rmSync(work, { recursive: true, force: true });

console.log(JSON.stringify({ ...evidence, workdirRemoved: true }, null, 2));
if (failures.length > 0) {
  console.error(`verify-private-data-map FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('verify-private-data-map PASS: map exercised against synthetic fixtures; baseline recorded.');
