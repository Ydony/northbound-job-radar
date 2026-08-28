import { env } from 'cloudflare:workers';
import { canonicalJobUrl, jobIdentityFingerprint, sourceInfoForUrl, sourceJobIdFromUrl } from '../lib/job-identity';
import { runtimeMigrations } from './migrations';

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS cvs (
    id TEXT PRIMARY KEY NOT NULL,
    slot TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL DEFAULT '',
    object_key TEXT NOT NULL DEFAULT '',
    cv_text TEXT NOT NULL DEFAULT '',
    derived_role TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY NOT NULL,
    source_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT 'Switzerland',
    description TEXT NOT NULL,
    language_status TEXT NOT NULL,
    language_summary TEXT NOT NULL,
    language_signals TEXT NOT NULL DEFAULT '[]',
    fit_score_a INTEGER NOT NULL DEFAULT 0,
    fit_score_b INTEGER NOT NULL DEFAULT 0,
    best_cv_slot TEXT NOT NULL DEFAULT '',
    matched_keywords TEXT NOT NULL DEFAULT '[]',
    missing_keywords TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS search_settings (
    id TEXT PRIMARY KEY NOT NULL,
    role_override_a TEXT NOT NULL DEFAULT '',
    role_override_b TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    workplace TEXT NOT NULL DEFAULT 'any',
    seniority TEXT NOT NULL DEFAULT 'any',
    contract_type TEXT NOT NULL DEFAULT 'any',
    required_keywords TEXT NOT NULL DEFAULT '[]',
    excluded_keywords TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS language_feedback (
    job_id TEXT PRIMARY KEY NOT NULL,
    verdict TEXT NOT NULL,
    corrected_status TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS jobs_language_status_idx ON jobs(language_status)',
  'CREATE INDEX IF NOT EXISTS jobs_status_updated_idx ON jobs(status, updated_at)',
];

let schemaReady: Promise<void> | undefined;

interface IdentityBackfillRow {
  id: string;
  source_url: string;
  canonical_url: string;
  source_key: string;
  source_name: string;
  source_job_id: string;
  title: string;
  company: string;
  location: string;
  posted_at: string;
}

async function backfillIncompleteJobIdentities(db: D1Database) {
  const rows = await db.prepare(`SELECT id, source_url, canonical_url, source_key, source_name, source_job_id,
      title, company, location, posted_at FROM jobs
    WHERE canonical_url = '' OR source_key = '' OR (identity_fingerprint = '' AND posted_at != '')`)
    .all<IdentityBackfillRow>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const canonicalUrl = canonicalJobUrl(row.canonical_url || row.source_url);
    const source = sourceInfoForUrl(canonicalUrl, row.location);
    const sourceJobId = row.source_job_id || sourceJobIdFromUrl(canonicalUrl);
    const fingerprint = jobIdentityFingerprint({
      sourceUrl: canonicalUrl,
      title: row.title,
      company: row.company,
      location: row.location,
      postedAt: row.posted_at,
    });
    statements.push(db.prepare(`UPDATE jobs SET canonical_url = ?, source_key = ?, source_name = ?,
      source_job_id = ?, country = ?, identity_fingerprint = ? WHERE id = ?`)
      .bind(canonicalUrl, row.source_key || source.key, row.source_name || source.name,
        sourceJobId, source.country, fingerprint, row.id));
    statements.push(db.prepare(`UPDATE dismissed_jobs SET source_key = ?, source_job_id = ?,
      canonical_url = ?, identity_fingerprint = ? WHERE id = ?`)
      .bind(row.source_key || source.key, sourceJobId, canonicalUrl, fingerprint, row.id));
  }
  for (let index = 0; index < statements.length; index += 80) {
    await db.batch(statements.slice(index, index + 80));
  }
}

export function bindings() {
  if (!env.DB) throw new Error('D1 binding DB is unavailable.');
  if (!env.CV_FILES) throw new Error('R2 binding CV_FILES is unavailable.');
  return { db: env.DB, files: env.CV_FILES };
}

/** Optional free aggregator keys. Missing values leave the matching sources reported as unavailable rather than failing a run. */
export function aggregatorCredentials() {
  return {
    adzunaAppId: env.ADZUNA_APP_ID ?? '',
    adzunaAppKey: env.ADZUNA_APP_KEY ?? '',
    careerjetApiKey: env.CAREERJET_API_KEY ?? '',
    careerjetReferer: env.CAREERJET_REFERER ?? '',
    careerjetUserIp: env.CAREERJET_USER_IP ?? '',
  };
}

export function ensureSchema() {
  if (!schemaReady) {
    const { db } = bindings();
    schemaReady = (async () => {
      for (const statement of schemaStatements) await db.prepare(statement).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`).run();
      const applied = await db.prepare('SELECT version FROM schema_migrations').all<{ version: number }>();
      const appliedVersions = new Set(applied.results.map((row) => row.version));
      for (const migration of runtimeMigrations) {
        if (appliedVersions.has(migration.version)) continue;
        const statements = migration.statements.map((statement) => db.prepare(statement));
        statements.push(db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .bind(migration.version, migration.name, new Date().toISOString()));
        await db.batch(statements);
      }
      await backfillIncompleteJobIdentities(db);
      await db.prepare('PRAGMA optimize').run();
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}
