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
  {
    version: 15,
    name: 'durable_rate_limits',
    statements: [
      // Rate limiting lived in a process-local map, so every counter reset whenever the worker
      // recycled - which on Cloudflare is often, and is not something an attacker has to arrange.
      // Against the single account this app has, on a URL that is about to be posted publicly,
      // a counter that forgets is close to no counter at all.
      `CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER NOT NULL
      )`,
      // Expired rows are cleared opportunistically rather than on a schedule; the index keeps that
      // sweep cheap enough to run inline.
      'CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits(reset_at)',
    ],
  },
  {
    version: 16,
    name: 'track_job_room_detail_backfill',
    statements: [
      // A successful detail request is recorded even when the source's full advertisement is
      // unusually short. Length alone cannot distinguish that from an unfetched preview, so
      // without a version marker a repeat run would request the same row forever.
      'ALTER TABLE jobs ADD COLUMN job_room_detail_version INTEGER NOT NULL DEFAULT 0',
      `CREATE INDEX IF NOT EXISTS jobs_job_room_backfill_idx
        ON jobs(user_id, source_key, job_room_detail_version)`,
    ],
  },
  {
    // Version 16 belongs to the independently reviewed Job-Room backfill (PR #52).
    version: 17,
    name: 'track_cluster_rule_version',
    statements: [
      // Existing non-empty cluster keys do not prove the links use today's date rules.
      // Zero also keeps newly imported jobs eligible for a full account-level regrouping.
      'ALTER TABLE jobs ADD COLUMN cluster_version INTEGER NOT NULL DEFAULT 0',
      'CREATE INDEX IF NOT EXISTS jobs_cluster_version_idx ON jobs(user_id, cluster_version)',
    ],
  },
  {
    version: 18,
    name: 'country_search_switches',
    statements: [
      // Default 1 on both, so an existing account keeps searching exactly what it searched
      // yesterday. A person who has never seen this setting has not asked for less.
      'ALTER TABLE search_settings ADD COLUMN search_netherlands INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE search_settings ADD COLUMN search_switzerland INTEGER NOT NULL DEFAULT 1',
    ],
  },
  {
    version: 19,
    name: 'indeed_collection_guard',
    statements: [
      // Installation-wide operational state, NOT user data. Shared by both countries/admins.
      `CREATE TABLE indeed_control (
        id TEXT PRIMARY KEY NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT NOT NULL DEFAULT '',
        lease_until INTEGER NOT NULL DEFAULT 0,
        last_success TEXT NOT NULL DEFAULT ''
      )`,
      "INSERT INTO indeed_control (id) VALUES ('indeed')",
    ],
  },
  {
    version: 20,
    name: 'track_structure_backfill',
    statements: [
      // Zero on every existing row: none of them has been re-read against its employer's board
      // yet, and a row that was ingested with its structure intact simply never becomes eligible,
      // because the eligibility test is "no line break at all".
      'ALTER TABLE jobs ADD COLUMN structure_version INTEGER NOT NULL DEFAULT 0',
      'CREATE INDEX IF NOT EXISTS jobs_structure_version_idx ON jobs(user_id, structure_version)',
    ],
  },
  {
    version: 21,
    name: 'keyword_search_text',
    statements: [
      // Accent-folded, lowercased title + location + description, written by the server on every
      // insert and text-changing update. SQLite LIKE cannot fold accents, so matching 'zurich'
      // against 'Zürich' in SQL needs the folded text stored, not derived per query. Existing
      // rows start empty and are backfilled on read; LIKE '%…%' cannot use an index, so none is
      // created for the text itself.
      "ALTER TABLE jobs ADD COLUMN search_text TEXT NOT NULL DEFAULT ''",
    ],
  },
  {
    // Version 16 belongs to the Job-Room description backfill; this is the posting-date half of
    // the same repair, tracked separately so a row already upgraded to full text is still
    // eligible for its missing date, and a full-length row stored dateless is eligible at all.
    version: 22,
    name: 'track_job_room_posted_at_backfill',
    statements: [
      // Every Job-Room row stored before #88 carries posted_at = '' because the parser read a
      // field the API never sends. A successful detail fetch is recorded even when the source
      // carries no date, so rerunning terminates instead of requesting the same row forever.
      'ALTER TABLE jobs ADD COLUMN job_room_posted_at_version INTEGER NOT NULL DEFAULT 0',
      `CREATE INDEX IF NOT EXISTS jobs_job_room_posted_at_idx
        ON jobs(user_id, source_key, job_room_posted_at_version)`,
    ],
  },
  {
    // #97: publication.endDate was read to refuse expired imports (#88) and then discarded, so
    // a stored advertisement kept looking current after its window closed. The date is now
    // kept at collection; the card derives expiry from it with no further request. Old rows
    // stay dateless until the Job-Room backfill re-reads them in its existing capped pass.
    version: 23,
    name: 'store_job_room_expiry',
    statements: [
      // Date-only YYYY-MM-DD like posted_at. Empty means the source published no expiry,
      // which is not the same as being expired.
      "ALTER TABLE jobs ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''",
    ],
  },
  {
    // #93: page-fetching sources re-attempted the same permanently-unimportable listings every
    // run, and four of them at the head of a source starved everything behind them for good.
    // Their URLs were written nowhere, so each run sliced the same first four off the top.
    // Rejections that are a property of the listing are now remembered per owner and skipped
    // like any other known URL; transient fetch failures stay retryable and are never stored.
    version: 24,
    name: 'remember_page_fetch_rejections',
    statements: [
      // `reason` is one of unparseable | unsafe-url | wrong-country | too-short |
      // role-mismatch. `roles` carries the sorted role keywords a role-mismatch was judged
      // against, so a later change of roles reconsiders the listing instead of hiding it
      // forever; every other reason is listing-intrinsic and holds regardless of roles.
      `CREATE TABLE IF NOT EXISTS rejected_listings (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        source_job_id TEXT NOT NULL DEFAULT '',
        canonical_url TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        roles TEXT NOT NULL DEFAULT '[]',
        rejected_at TEXT NOT NULL DEFAULT ''
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS rejected_user_canonical_idx ON rejected_listings(user_id, canonical_url)',
      'CREATE INDEX IF NOT EXISTS rejected_user_source_identity_idx ON rejected_listings(user_id, source_key, source_job_id)',
    ],
  },
  {
    // #124: the run report never persisted how many of a run's new jobs were actually
    // matches (English-confirmed and meeting the saved criteria at search time), so the
    // dashboard could only guess from importedCount. NULL means unknown: rows written
    // before this marker, and sources that never completed, carry no matched number and
    // must render as unknown rather than as a false zero.
    version: 25,
    name: 'run_matched_new_counts',
    statements: [
      'ALTER TABLE search_run_sources ADD COLUMN matched_count INTEGER',
    ],
  },
  {
    // #113: Indeed place and distance per country, account-scoped like every other
    // user-data table. A missing row reads as defaults (Amsterdam/Switzerland, 16 km
    // converting to the previous hardcoded 10 provider miles), so an account that
    // predates this table keeps searching exactly what it searched yesterday.
    // Kilometres are the stored and user-facing unit; collection converts to the
    // provider's integer miles. No backfill: absence already means defaults.
    version: 26,
    name: 'indeed_place_distance_settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS indeed_settings (
        user_id TEXT PRIMARY KEY NOT NULL,
        nl_location TEXT NOT NULL DEFAULT 'Amsterdam, Netherlands',
        nl_radius_km INTEGER NOT NULL DEFAULT 16,
        ch_location TEXT NOT NULL DEFAULT 'Switzerland',
        ch_radius_km INTEGER NOT NULL DEFAULT 16,
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
    ],
  },
  {
    // #115: durable per-query coverage checkpoints, keyed by the canonical
    // query identity (owner + role + country + place + provider radius +
    // query version, see lib/indeed/settings.ts). covered_through_ms advances
    // only on a fully exhausted query, to the run START time — never on
    // failure, cap or cancellation. A missing row means no coverage yet.
    version: 27,
    name: 'indeed_coverage_checkpoints',
    statements: [
      `CREATE TABLE IF NOT EXISTS indeed_coverage (
        query_key TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        country TEXT NOT NULL,
        role TEXT NOT NULL,
        location TEXT NOT NULL,
        radius_miles INTEGER NOT NULL,
        covered_through_ms INTEGER NOT NULL DEFAULT 0,
        window_start_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'incomplete',
        last_check TEXT NOT NULL DEFAULT '',
        last_success TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )`,
      'CREATE INDEX IF NOT EXISTS indeed_coverage_user_idx ON indeed_coverage(user_id)',
    ],
  },
];
