import { env } from 'cloudflare:workers';

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

export function bindings() {
  if (!env.DB) throw new Error('D1 binding DB is unavailable.');
  if (!env.CV_FILES) throw new Error('R2 binding CV_FILES is unavailable.');
  return { db: env.DB, files: env.CV_FILES };
}

export function ensureSchema() {
  if (!schemaReady) {
    const { db } = bindings();
    schemaReady = (async () => {
      for (const statement of schemaStatements) await db.prepare(statement).run();
      await db.prepare('PRAGMA optimize').run();
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}
