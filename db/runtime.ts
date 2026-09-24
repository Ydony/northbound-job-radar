import { env } from 'cloudflare:workers';
import { isLoopbackRequest } from '../lib/indeed/access';
import { canonicalJobUrl, jobIdentityFingerprint, sourceInfoForUrl, sourceJobIdFromUrl } from '../lib/job-identity';
import type { NativeRateLimiter } from '../lib/rate-limit';
import { detectWorkplaceType } from '../lib/workplace';
import { CV_REMOVAL_VERSION, runtimeMigrations } from './migrations';

// This is the legacy base, not the final schema. Fresh databases also run every migration,
// including the cluster_version column; adding it here would duplicate migration 17's ALTER.
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

/** Detects the work type for jobs stored before the column existed. Empty means never analysed; 'unknown' means analysed with no signal found, so this runs once per row. */
async function backfillWorkplaceTypes(db: D1Database) {
  const rows = await db.prepare(`SELECT id, title, location, description FROM jobs
    WHERE workplace_type = '' LIMIT 2000`)
    .all<{ id: string; title: string; location: string; description: string }>();
  if (!rows.results.length) return;
  const statements = rows.results.map((row) => db.prepare('UPDATE jobs SET workplace_type = ? WHERE id = ?')
    .bind(detectWorkplaceType(`${row.title} ${row.location} ${row.description}`), row.id));
  for (let index = 0; index < statements.length; index += 80) {
    await db.batch(statements.slice(index, index + 80));
  }
}

export function bindings() {
  if (!env.DB) throw new Error('D1 binding DB is unavailable.');
  // The native edge rate limiter is optional: local development without the `ratelimits`
  // configuration simply skips that layer and relies on the database limiter. Never throw here —
  // a missing edge brake must not take the whole app down.
  const authRateLimiter = (env.AUTH_RATE_LIMIT ?? undefined) as NativeRateLimiter | undefined;
  return { db: env.DB, authRateLimiter };
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

/** Never serialize this backend configuration into a response or client component. */
export function indeedConfiguration(request: Request, administrator: boolean) {
  return {
    access: { enabled: env.INDEED_ENABLED === 'true', administrator,
      localExecution: env.INDEED_LOCAL_ONLY === 'true' && isLoopbackRequest(request),
      appIdentityExperimentApproved: env.INDEED_APP_IDENTITY_APPROVED === 'true' },
    credentials: { apiKey: env.INDEED_API_KEY ?? '', userAgent: env.INDEED_USER_AGENT ?? '', appInfo: env.INDEED_APP_INFO ?? '' },
  };
}

/** Transactional email sender. Missing values leave verification/reset emails unsent rather than failing signup. */
export function emailConfiguration() {
  return {
    apiKey: env.RESEND_API_KEY ?? '',
    from: env.RESEND_FROM ?? '',
  };
}

/** Auth secrets. Absent values keep the app closed rather than open. */
export function authSecrets() {
  return {
    passwordHash: env.APP_PASSWORD_HASH ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    allowSignups: env.ALLOW_SIGNUPS ?? '',
    vpnEnforced: env.VPN_ENFORCED === 'true',
  };
}

/**
 * Turnstile bot-protection credentials (#171). The sitekey is public and served to the
 * registration form; the secret key is owner-set (`wrangler secret put TURNSTILE_SECRET_KEY`)
 * and only ever read here, never serialized into a response. Empty values mean unconfigured.
 */
export function turnstileSecrets() {
  return {
    siteKey: env.TURNSTILE_SITE_KEY ?? '',
    secretKey: env.TURNSTILE_SECRET_KEY ?? '',
  };
}

export function ensureSchema() {
  if (!schemaReady) {
    const { db } = bindings();
    schemaReady = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`).run();
      const applied = await db.prepare('SELECT version FROM schema_migrations').all<{ version: number }>();
      const appliedVersions = new Set(applied.results.map((row) => row.version));
      // Fresh and pre-28 databases need the historical CV base while migrations 1–27 run.
      // Once migration 28 has removed it, never recreate that table on a later boot.
      for (const statement of schemaStatements.slice(appliedVersions.has(CV_REMOVAL_VERSION) ? 1 : 0)) {
        await db.prepare(statement).run();
      }
      for (const migration of runtimeMigrations) {
        if (appliedVersions.has(migration.version)) continue;
        const statements = migration.statements.map((statement) => db.prepare(statement));
        statements.push(db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .bind(migration.version, migration.name, new Date().toISOString()));
        await db.batch(statements);
      }
      await backfillIncompleteJobIdentities(db);
      await backfillWorkplaceTypes(db);
      // Retention: sign-in records hold IPs for abuse prevention only and expire after 30 days.
      await db.prepare("DELETE FROM auth_events WHERE created_at < datetime('now', '-30 days')").run();
      await db.prepare('PRAGMA optimize').run();
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}
