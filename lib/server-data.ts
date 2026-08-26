import { scoreFitAcrossCvs, type CvInput, type LanguageStatus } from './analysis';
import type { CvProfile, CvSlot, JobRecord } from './types';

interface CvRow {
  slot: CvSlot;
  file_name: string;
  cv_text: string;
  derived_role: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  source_url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  language_status: JobRecord['languageStatus'];
  language_summary: string;
  language_signals: string;
  fit_score_a: number;
  fit_score_b: number;
  best_cv_slot: JobRecord['bestCvSlot'];
  matched_keywords: string;
  missing_keywords: string;
  status: JobRecord['status'];
  created_at: string;
  updated_at: string;
}

function stringArray(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function cvFromRow(row: CvRow): CvProfile {
  return {
    slot: row.slot,
    cvFileName: row.file_name,
    hasCvText: Boolean(row.cv_text.trim()),
    derivedRole: row.derived_role,
    updatedAt: row.updated_at,
  };
}

export function jobFromRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description,
    languageStatus: row.language_status,
    languageSummary: row.language_summary,
    languageSignals: stringArray(row.language_signals),
    fitScoreA: row.fit_score_a,
    fitScoreB: row.fit_score_b,
    bestCvSlot: row.best_cv_slot,
    matchedKeywords: stringArray(row.matched_keywords),
    missingKeywords: stringArray(row.missing_keywords),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertJobInput {
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  description: string;
  languageStatus: LanguageStatus;
  languageSummary: string;
  languageSignals: string[];
  fitScoreA: number;
  fitScoreB: number;
  bestCvSlot: CvSlot | '';
  matchedKeywords: string[];
  missingKeywords: string[];
}

export async function upsertJob(db: D1Database, input: UpsertJobInput): Promise<JobRecord> {
  const now = new Date().toISOString();
  const existing = await db.prepare('SELECT id, status, created_at FROM jobs WHERE source_url = ?')
    .bind(input.sourceUrl).first<{ id: string; status: string; created_at: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  await db.prepare(`INSERT INTO jobs (id, source_url, title, company, location, description, language_status,
      language_summary, language_signals, fit_score_a, fit_score_b, best_cv_slot, matched_keywords, missing_keywords,
      status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET title = excluded.title, company = excluded.company, location = excluded.location,
      description = excluded.description, language_status = excluded.language_status, language_summary = excluded.language_summary,
      language_signals = excluded.language_signals, fit_score_a = excluded.fit_score_a, fit_score_b = excluded.fit_score_b,
      best_cv_slot = excluded.best_cv_slot, matched_keywords = excluded.matched_keywords,
      missing_keywords = excluded.missing_keywords, updated_at = excluded.updated_at`)
    .bind(id, input.sourceUrl, input.title, input.company, input.location, input.description, input.languageStatus,
      input.languageSummary, JSON.stringify(input.languageSignals), input.fitScoreA, input.fitScoreB, input.bestCvSlot,
      JSON.stringify(input.matchedKeywords), JSON.stringify(input.missingKeywords), existing?.status ?? 'new',
      existing?.created_at ?? now, now).run();
  const row = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  return jobFromRow(row!);
}

export async function rescoreAllJobs(db: D1Database, cvs: CvInput[]) {
  const jobs = await db.prepare('SELECT id, title, description FROM jobs')
    .all<{ id: string; title: string; description: string }>();
  if (!jobs.results.length) return 0;

  const updates = jobs.results.map((job) => {
    const fit = scoreFitAcrossCvs(job.description, job.title, cvs);
    return db.prepare(`UPDATE jobs SET fit_score_a = ?, fit_score_b = ?, best_cv_slot = ?,
      matched_keywords = ?, missing_keywords = ?, updated_at = ? WHERE id = ?`)
      .bind(fit.fitScoreA, fit.fitScoreB, fit.bestCvSlot, JSON.stringify(fit.matchedKeywords),
        JSON.stringify(fit.missingKeywords), new Date().toISOString(), job.id);
  });
  for (let start = 0; start < updates.length; start += 50) {
    await db.batch(updates.slice(start, start + 50));
  }
  return updates.length;
}

export type { CvRow, JobRow };
