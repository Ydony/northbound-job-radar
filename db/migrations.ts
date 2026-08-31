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
  {
    version: 6,
    name: 'multi_user_accounts_and_tenancy',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT ''
      )`,
      'CREATE INDEX IF NOT EXISTS users_role_idx ON users(role, status)',
      // Owner columns. Existing single-user rows keep 'legacy' and are claimed by the first
      // account created, so upgrading in place never orphans an existing workspace.
      "ALTER TABLE cvs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'",
      "ALTER TABLE jobs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'",
      "ALTER TABLE search_settings ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'",
      "ALTER TABLE search_roles ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'",
      "ALTER TABLE language_feedback ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'",
      "ALTER TABLE dismissed_jobs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'",
      "ALTER TABLE search_runs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'",
      'CREATE INDEX IF NOT EXISTS cvs_user_idx ON cvs(user_id, slot)',
      'CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, updated_at)',
      'CREATE INDEX IF NOT EXISTS jobs_user_canonical_idx ON jobs(user_id, canonical_url)',
      'CREATE INDEX IF NOT EXISTS dismissed_user_idx ON dismissed_jobs(user_id)',
      'CREATE INDEX IF NOT EXISTS search_runs_user_idx ON search_runs(user_id, started_at)',
      `CREATE TABLE IF NOT EXISTS auth_events (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS auth_events_ip_idx ON auth_events(ip, created_at)',
      'CREATE INDEX IF NOT EXISTS auth_events_email_idx ON auth_events(email, created_at)',
    ],
  },
  {
    version: 7,
    name: 'scope_uniqueness_per_user',
    statements: [
      // `source_url ... UNIQUE` and `slot ... UNIQUE` were global. With more than one account that
      // means the first user to import a vacancy blocks everyone else from ever importing it, and
      // only one person could ever hold CV slot 'a'. SQLite cannot drop the implicit index a UNIQUE
      // column constraint creates, so both tables are rebuilt with the constraint scoped per owner.
      `CREATE TABLE jobs_rebuilt (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'legacy',
        source_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        source_name TEXT NOT NULL DEFAULT '',
        source_job_id TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT 'unknown',
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
        workplace_type TEXT NOT NULL DEFAULT '',
        matched_keywords TEXT NOT NULL DEFAULT '[]',
        missing_keywords TEXT NOT NULL DEFAULT '[]',
        identity_fingerprint TEXT NOT NULL DEFAULT '',
        is_saved INTEGER NOT NULL DEFAULT 0,
        application_status TEXT NOT NULL DEFAULT 'not_applied',
        visibility_status TEXT NOT NULL DEFAULT 'active',
        posted_at TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `INSERT INTO jobs_rebuilt SELECT id, user_id, source_url, canonical_url, source_key, source_name,
        source_job_id, country, title, company, location, description, language_status, language_summary,
        language_signals, fit_score_a, fit_score_b, best_cv_slot, workplace_type, matched_keywords,
        missing_keywords, identity_fingerprint, is_saved, application_status, visibility_status,
        posted_at, first_seen_at, last_seen_at, status, created_at, updated_at FROM jobs`,
      'DROP TABLE jobs',
      'ALTER TABLE jobs_rebuilt RENAME TO jobs',
      'CREATE UNIQUE INDEX IF NOT EXISTS jobs_user_source_url_idx ON jobs(user_id, source_url)',
      'CREATE INDEX IF NOT EXISTS jobs_language_status_idx ON jobs(language_status)',
      'CREATE INDEX IF NOT EXISTS jobs_status_updated_idx ON jobs(status, updated_at)',
      'CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, updated_at)',
      'CREATE INDEX IF NOT EXISTS jobs_user_canonical_idx ON jobs(user_id, canonical_url)',
      'CREATE INDEX IF NOT EXISTS jobs_country_application_visibility_idx ON jobs(country, application_status, visibility_status)',
      'CREATE INDEX IF NOT EXISTS jobs_source_identity_idx ON jobs(source_key, source_job_id)',
      'CREATE INDEX IF NOT EXISTS jobs_identity_fingerprint_idx ON jobs(identity_fingerprint)',
      'CREATE INDEX IF NOT EXISTS jobs_workplace_type_idx ON jobs(workplace_type)',
      `CREATE TABLE cvs_rebuilt (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'legacy',
        slot TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '',
        object_key TEXT NOT NULL DEFAULT '',
        cv_text TEXT NOT NULL DEFAULT '',
        derived_role TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`,
      `INSERT INTO cvs_rebuilt SELECT id, user_id, slot, file_name, object_key, cv_text, derived_role,
        updated_at FROM cvs`,
      'DROP TABLE cvs',
      'ALTER TABLE cvs_rebuilt RENAME TO cvs',
      'CREATE UNIQUE INDEX IF NOT EXISTS cvs_user_slot_idx ON cvs(user_id, slot)',
      'CREATE UNIQUE INDEX IF NOT EXISTS search_settings_user_idx ON search_settings(user_id)',
    ],
  },
  {
    version: 8,
    name: 'privacy_preserving_visit_counts',
    statements: [
      // Aggregate counters only. Nothing here identifies a person or survives as a profile.
      `CREATE TABLE IF NOT EXISTS daily_visits (
        day TEXT PRIMARY KEY NOT NULL,
        total_visits INTEGER NOT NULL DEFAULT 0,
        unique_visitors INTEGER NOT NULL DEFAULT 0
      )`,
      // Same-day de-duplication only. The marker is a salted hash that changes every day and is
      // deleted once the day rolls over, so visits cannot be linked across days or back to anyone.
      `CREATE TABLE IF NOT EXISTS visit_markers (
        day TEXT NOT NULL,
        marker TEXT NOT NULL,
        PRIMARY KEY (day, marker)
      )`,
      'CREATE INDEX IF NOT EXISTS visit_markers_day_idx ON visit_markers(day)',
      `CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT NOT NULL DEFAULT ''
      )`,
      'CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id)',
    ],
  },
    {
    version: 9,
    name: 'expire_auth_events',
    statements: [
      // auth_events holds IP addresses for abuse prevention. That is personal data, so it is kept
      // to a short window rather than indefinitely; the runtime purge enforces it from here on.
      "DELETE FROM auth_events WHERE created_at < datetime('now', '-30 days')",
    ],
  },
  {
    version: 10,
    name: 'session_epoch_for_revocation',
    statements: [
      // Bumping a user's epoch invalidates every cookie already issued to them.
      'ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 1',
    ],
  },
  {
    version: 11,
    name: 'scope_search_role_positions_per_user',
    statements: [
      // The original index remained globally unique after user_id was introduced, so the first
      // account to save positions 0-4 prevented every other account from saving role keywords.
      'DROP INDEX IF EXISTS search_roles_position_idx',
      'CREATE UNIQUE INDEX IF NOT EXISTS search_roles_user_position_idx ON search_roles(user_id, position)',
    ],
  },
  {
    version: 12,
    name: 'record_what_the_detector_said_when_corrected',
    statements: [
      // A correction on its own cannot teach anything: to improve the gate you need the pair -
      // what it decided, and what the person decided instead - frozen at the moment of feedback.
      // Rescoring rewrites jobs.language_status, so reading it later tells you nothing about what
      // was actually being corrected.
      "ALTER TABLE language_feedback ADD COLUMN detected_status TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE language_feedback ADD COLUMN detected_summary TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE language_feedback ADD COLUMN detected_signals TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE language_feedback ADD COLUMN evidence TEXT NOT NULL DEFAULT ''",
      // Backfill what is still knowable for corrections already collected.
      `UPDATE language_feedback SET
         detected_status = COALESCE((SELECT language_status FROM jobs WHERE jobs.id = language_feedback.job_id), ''),
         detected_summary = COALESCE((SELECT language_summary FROM jobs WHERE jobs.id = language_feedback.job_id), ''),
         detected_signals = COALESCE((SELECT language_signals FROM jobs WHERE jobs.id = language_feedback.job_id), '[]')
       WHERE detected_status = ''`,
    ],
  },
  {
    version: 13,
    name: 'collapse_cross_board_duplicates',
    statements: [
      // identity_fingerprint hashes the location and the exact posting day, so the same
      // advertisement listed as "Pfaeffikon, Schweiz" on one board and plain "Schweiz" on another
      // hashed differently and appeared twice. A hash cannot express "within four days" or "one
      // location contains the other", so matching needs a coarse bucket plus a real comparison.
      "ALTER TABLE jobs ADD COLUMN cluster_key TEXT NOT NULL DEFAULT ''",
      // Points at the job kept on screen. Non-empty means this row is a copy and stays hidden.
      // Nothing is deleted: the copy still carries its own apply link, which is the whole reason
      // a person might want the version on a particular board.
      "ALTER TABLE jobs ADD COLUMN duplicate_of TEXT NOT NULL DEFAULT ''",
      'CREATE INDEX IF NOT EXISTS jobs_cluster_idx ON jobs(user_id, cluster_key)',
      'CREATE INDEX IF NOT EXISTS jobs_duplicate_of_idx ON jobs(user_id, duplicate_of)',
      // cluster_key is normalized in TypeScript, so rows are left blank here and backfilled by
      // reclusterJobs() the next time the workspace is read.
    ],
  },
  {
    version: 14,
    name: 'track_normalization_version',
    statements: [
      // Jobs are stored with the title cleaned and the language decided at the moment they were
      // imported, so a change to either rule leaves everything already saved on the old behaviour -
      // titles still showing "&amp;", verdicts still reflecting a gate that never read the title.
      // Recording which revision of those rules a row was written under makes the fix routine:
      // bump NORMALIZATION_VERSION in lib/server-data.ts and stale rows are rewritten on next read.
      'ALTER TABLE jobs ADD COLUMN normalized_version INTEGER NOT NULL DEFAULT 0',
      'CREATE INDEX IF NOT EXISTS jobs_normalized_version_idx ON jobs(user_id, normalized_version)',
    ],
  },
];
