import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
    matchedKeywords: text('matched_keywords').notNull().default('[]'),
    missingKeywords: text('missing_keywords').notNull().default('[]'),
    status: text('status').notNull().default('new'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('jobs_language_status_idx').on(table.languageStatus),
    index('jobs_status_updated_idx').on(table.status, table.updatedAt),
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
