export interface RuntimeMigration {
  version: number;
  name: string;
  statements: string[];
}

export const runtimeMigrations: RuntimeMigration[] = [
  {
    version: 1,
    name: 'multi_source_foundation',
    statements: [
      "ALTER TABLE jobs ADD COLUMN source_key TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN source_name TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN source_job_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN canonical_url TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN country TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE jobs ADD COLUMN posted_at TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN first_seen_at TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN identity_fingerprint TEXT NOT NULL DEFAULT ''",
      'ALTER TABLE jobs ADD COLUMN is_saved INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE jobs ADD COLUMN application_status TEXT NOT NULL DEFAULT 'not_applied'",
      "ALTER TABLE jobs ADD COLUMN visibility_status TEXT NOT NULL DEFAULT 'active'",
      `UPDATE jobs SET
        source_key = CASE
          WHEN source_url LIKE '%jobup.ch/%' THEN 'jobup.ch'
          WHEN source_url LIKE '%jobscout24.ch/%' THEN 'jobscout24.ch'
          WHEN source_url LIKE '%iamexpat.nl/%' THEN 'iamexpat.nl'
          WHEN source_url LIKE '%undutchables.nl/%' THEN 'undutchables.nl'
          WHEN source_url LIKE '%indeed.%' THEN 'indeed'
          ELSE 'jobs.ch'
        END,
        source_name = CASE
          WHEN source_url LIKE '%jobup.ch/%' THEN 'jobup.ch'
          WHEN source_url LIKE '%jobscout24.ch/%' THEN 'JobScout24'
          WHEN source_url LIKE '%iamexpat.nl/%' THEN 'IamExpat'
          WHEN source_url LIKE '%undutchables.nl/%' THEN 'Undutchables'
          WHEN source_url LIKE '%indeed.%' THEN 'Indeed'
          ELSE 'jobs.ch'
        END,
        country = CASE
          WHEN source_url LIKE '%.nl/%' OR source_url LIKE '%nl.indeed.%' THEN 'netherlands'
          ELSE 'switzerland'
        END,
        canonical_url = source_url,
        first_seen_at = created_at,
        last_seen_at = updated_at,
        is_saved = CASE WHEN status = 'saved' THEN 1 ELSE 0 END,
        application_status = CASE WHEN status = 'applied' THEN 'applied' ELSE 'not_applied' END,
        visibility_status = CASE WHEN status = 'ignored' THEN 'dismissed' ELSE 'active' END`,
      `CREATE TABLE IF NOT EXISTS search_roles (
        id TEXT PRIMARY KEY NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS dismissed_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        source_key TEXT NOT NULL DEFAULT '',
        source_job_id TEXT NOT NULL DEFAULT '',
        canonical_url TEXT NOT NULL DEFAULT '',
        identity_fingerprint TEXT NOT NULL DEFAULT '',
        dismissed_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS search_runs (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS search_run_sources (
        run_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        source_name TEXT NOT NULL,
        country TEXT NOT NULL,
        status TEXT NOT NULL,
        roles_searched TEXT NOT NULL DEFAULT '[]',
        found_count INTEGER NOT NULL DEFAULT 0,
        known_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        imported_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, source_key)
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS search_roles_position_idx ON search_roles(position)',
      'CREATE INDEX IF NOT EXISTS jobs_country_application_visibility_idx ON jobs(country, application_status, visibility_status)',
      'CREATE INDEX IF NOT EXISTS jobs_source_identity_idx ON jobs(source_key, source_job_id)',
      'CREATE INDEX IF NOT EXISTS jobs_canonical_url_idx ON jobs(canonical_url)',
      'CREATE INDEX IF NOT EXISTS jobs_identity_fingerprint_idx ON jobs(identity_fingerprint)',
      'CREATE INDEX IF NOT EXISTS dismissed_jobs_source_identity_idx ON dismissed_jobs(source_key, source_job_id)',
      'CREATE INDEX IF NOT EXISTS dismissed_jobs_canonical_url_idx ON dismissed_jobs(canonical_url)',
      'CREATE INDEX IF NOT EXISTS dismissed_jobs_fingerprint_idx ON dismissed_jobs(identity_fingerprint)',
      'CREATE INDEX IF NOT EXISTS search_runs_started_at_idx ON search_runs(started_at)',
      'CREATE INDEX IF NOT EXISTS search_run_sources_source_key_idx ON search_run_sources(source_key, run_id)',
    ],
  },
  {
    version: 2,
    name: 'normalize_legacy_job_identity',
    statements: [
      "UPDATE jobs SET canonical_url = rtrim(canonical_url, '/') WHERE canonical_url != ''",
      `UPDATE jobs SET source_job_id = rtrim(substr(canonical_url, instr(canonical_url, '/detail/') + 8), '/')
        WHERE source_job_id = '' AND instr(canonical_url, '/detail/') > 0`,
      `INSERT OR IGNORE INTO dismissed_jobs
        (id, source_key, source_job_id, canonical_url, identity_fingerprint, dismissed_at)
        SELECT id, source_key, source_job_id, canonical_url, identity_fingerprint, updated_at
        FROM jobs WHERE visibility_status = 'dismissed'`,
    ],
  },
  {
    version: 3,
    name: 'require_posting_day_for_cross_source_fingerprint',
    statements: [
      "UPDATE jobs SET identity_fingerprint = '' WHERE posted_at = ''",
      "UPDATE dismissed_jobs SET identity_fingerprint = '' WHERE id IN (SELECT id FROM jobs WHERE posted_at = '')",
    ],
  },
  {
    version: 4,
    name: 'store_detected_workplace_type',
    statements: [
      // Empty means "not yet detected"; 'unknown' is a real verdict meaning the ad gave no signal.
      // Keeping them distinct is what lets the backfill find rows that still need analysing.
      "ALTER TABLE jobs ADD COLUMN workplace_type TEXT NOT NULL DEFAULT ''",
      'CREATE INDEX IF NOT EXISTS jobs_workplace_type_idx ON jobs(workplace_type)',
    ],
  },
  {
    version: 5,
    name: 'reset_workplace_type_for_backfill',
    statements: [
      "UPDATE jobs SET workplace_type = '' WHERE workplace_type = 'unknown'",
    ],
  },
];
