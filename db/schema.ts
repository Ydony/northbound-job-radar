import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const cvs = sqliteTable('cvs', {
  id: text('id').primaryKey(),
  slot: text('slot').notNull().unique(),
  fileName: text('file_name').notNull().default(''),
  objectKey: text('object_key').notNull().default(''),
  cvText: text('cv_text').notNull().default(''),
  derivedRole: text('derived_role').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    sourceUrl: text('source_url').notNull().unique(),
    canonicalUrl: text('canonical_url').notNull().default(''),
    sourceKey: text('source_key').notNull().default(''),
    sourceName: text('source_name').notNull().default(''),
    sourceJobId: text('source_job_id').notNull().default(''),
    country: text('country').notNull().default('unknown'),
    title: text('title').notNull(),
    company: text('company').notNull().default(''),
    location: text('location').notNull().default('Switzerland'),
    description: text('description').notNull(),
    languageStatus: text('language_status').notNull(),
    languageSummary: text('language_summary').notNull(),
    languageSignals: text('language_signals').notNull().default('[]'),
    fitScoreA: integer('fit_score_a').notNull().default(0),
    fitScoreB: integer('fit_score_b').notNull().default(0),
    bestCvSlot: text('best_cv_slot').notNull().default(''),
    workplaceType: text('workplace_type').notNull().default('unknown'),
    matchedKeywords: text('matched_keywords').notNull().default('[]'),
    missingKeywords: text('missing_keywords').notNull().default('[]'),
    identityFingerprint: text('identity_fingerprint').notNull().default(''),
    isSaved: integer('is_saved', { mode: 'boolean' }).notNull().default(false),
    applicationStatus: text('application_status').notNull().default('not_applied'),
    visibilityStatus: text('visibility_status').notNull().default('active'),
    postedAt: text('posted_at').notNull().default(''),
    firstSeenAt: text('first_seen_at').notNull().default(''),
    lastSeenAt: text('last_seen_at').notNull().default(''),
    status: text('status').notNull().default('new'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('jobs_language_status_idx').on(table.languageStatus),
    index('jobs_status_updated_idx').on(table.status, table.updatedAt),
    index('jobs_country_application_visibility_idx').on(table.country, table.applicationStatus, table.visibilityStatus),
    index('jobs_source_identity_idx').on(table.sourceKey, table.sourceJobId),
    index('jobs_canonical_url_idx').on(table.canonicalUrl),
    index('jobs_identity_fingerprint_idx').on(table.identityFingerprint),
  ],
);

export const searchSettings = sqliteTable('search_settings', {
  id: text('id').primaryKey(),
  roleOverrideA: text('role_override_a').notNull().default(''),
  roleOverrideB: text('role_override_b').notNull().default(''),
  location: text('location').notNull().default(''),
  workplace: text('workplace').notNull().default('any'),
  seniority: text('seniority').notNull().default('any'),
  contractType: text('contract_type').notNull().default('any'),
  requiredKeywords: text('required_keywords').notNull().default('[]'),
  excludedKeywords: text('excluded_keywords').notNull().default('[]'),
  updatedAt: text('updated_at').notNull(),
});

export const languageFeedback = sqliteTable('language_feedback', {
  jobId: text('job_id').primaryKey(),
  verdict: text('verdict').notNull(),
  correctedStatus: text('corrected_status').notNull().default(''),
  reason: text('reason').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

export const searchRoles = sqliteTable('search_roles', {
  id: text('id').primaryKey(),
  position: integer('position').notNull(),
  role: text('role').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('search_roles_position_idx').on(table.position)]);

export const dismissedJobs = sqliteTable('dismissed_jobs', {
  id: text('id').primaryKey(),
  sourceKey: text('source_key').notNull().default(''),
  sourceJobId: text('source_job_id').notNull().default(''),
  canonicalUrl: text('canonical_url').notNull().default(''),
  identityFingerprint: text('identity_fingerprint').notNull().default(''),
  dismissedAt: text('dismissed_at').notNull(),
}, (table) => [
  index('dismissed_jobs_source_identity_idx').on(table.sourceKey, table.sourceJobId),
  index('dismissed_jobs_canonical_url_idx').on(table.canonicalUrl),
  index('dismissed_jobs_fingerprint_idx').on(table.identityFingerprint),
]);

export const searchRuns = sqliteTable('search_runs', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull().default(''),
}, (table) => [index('search_runs_started_at_idx').on(table.startedAt)]);

export const searchRunSources = sqliteTable('search_run_sources', {
  runId: text('run_id').notNull(),
  sourceKey: text('source_key').notNull(),
  sourceName: text('source_name').notNull(),
  country: text('country').notNull(),
  status: text('status').notNull(),
  rolesSearched: text('roles_searched').notNull().default('[]'),
  foundCount: integer('found_count').notNull().default(0),
  knownCount: integer('known_count').notNull().default(0),
  newCount: integer('new_count').notNull().default(0),
  importedCount: integer('imported_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  message: text('message').notNull().default(''),
}, (table) => [
  primaryKey({ columns: [table.runId, table.sourceKey] }),
  index('search_run_sources_source_key_idx').on(table.sourceKey, table.runId),
]);
