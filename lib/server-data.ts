import { analyzeLanguage, scoreFitAcrossCvs, type CvInput, type LanguageStatus } from './analysis';
import { canonicalJobUrl, isGloballyStableSourceJobId, jobIdentityFingerprint, sourceInfoForUrl,
  sourceJobIdFromUrl } from './job-identity';
import { detectWorkplaceType } from './workplace';
import type { CvProfile, CvSlot, JobRecord, SearchCriteria, SearchRun, SearchRunSource } from './types';

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
  canonical_url: string;
  source_key: string;
  source_name: string;
  source_job_id: string;
  country: JobRecord['country'];
  title: string;
  company: string;
  location: string;
  description: string;
  language_status: JobRecord['languageStatus'];
  language_summary: string;
  language_signals: string;
  feedback_verdict?: string | null;
  feedback_corrected_status?: string | null;
  feedback_reason?: string | null;
  feedback_updated_at?: string | null;
  fit_score_a: number;
  fit_score_b: number;
  best_cv_slot: JobRecord['bestCvSlot'];
  workplace_type: JobRecord['workplaceType'];
  matched_keywords: string;
  missing_keywords: string;
  identity_fingerprint: string;
  is_saved: number;
  application_status: JobRecord['applicationStatus'];
  visibility_status: JobRecord['visibilityStatus'];
  posted_at: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

interface CriteriaRow {
  role_override_a: string;
  role_override_b: string;
  location: string;
  workplace: SearchCriteria['workplace'];
  seniority: SearchCriteria['seniority'];
  contract_type: SearchCriteria['contractType'];
  required_keywords: string;
  excluded_keywords: string;
  updated_at: string;
}

interface SearchRoleRow {
  position: number;
  role: string;
}

interface SearchRunRow {
  id: string;
  status: SearchRun['status'];
  started_at: string;
  completed_at: string;
}

interface SearchRunSourceRow {
  run_id: string;
  source_key: string;
  source_name: string;
  country: SearchRunSource['country'];
  status: SearchRunSource['status'];
  roles_searched: string;
  found_count: number;
  known_count: number;
  new_count: number;
  imported_count: number;
  duplicate_count: number;
  skipped_count: number;
  message: string;
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
  const languageFeedback = row.feedback_verdict === 'correct' || row.feedback_verdict === 'incorrect'
    ? row.feedback_verdict
    : '';
  const correctedLanguageStatus = row.feedback_corrected_status === 'pass'
    || row.feedback_corrected_status === 'review'
    || row.feedback_corrected_status === 'blocked'
    ? row.feedback_corrected_status
    : '';
  return {
    id: row.id,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url || canonicalJobUrl(row.source_url),
    sourceKey: row.source_key || sourceInfoForUrl(row.source_url, row.location).key,
    sourceName: row.source_name || sourceInfoForUrl(row.source_url, row.location).name,
    sourceJobId: row.source_job_id || sourceJobIdFromUrl(row.source_url),
    country: row.country === 'switzerland' || row.country === 'netherlands' ? row.country : 'unknown',
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description,
    languageStatus: row.language_status,
    languageSummary: row.language_summary,
    languageSignals: stringArray(row.language_signals),
    languageFeedback,
    correctedLanguageStatus,
    languageFeedbackReason: row.feedback_reason ?? '',
    languageFeedbackUpdatedAt: row.feedback_updated_at ?? '',
    fitScoreA: row.fit_score_a,
    fitScoreB: row.fit_score_b,
    bestCvSlot: row.best_cv_slot,
    workplaceType: row.workplace_type || 'unknown',
    matchedKeywords: stringArray(row.matched_keywords),
    missingKeywords: stringArray(row.missing_keywords),
    identityFingerprint: row.identity_fingerprint || jobIdentityFingerprint({
      sourceUrl: row.source_url,
      title: row.title,
      company: row.company,
      location: row.location,
      postedAt: row.posted_at,
    }),
    isSaved: Boolean(row.is_saved),
    applicationStatus: row.application_status === 'applied' ? 'applied' : 'not_applied',
    visibilityStatus: row.visibility_status === 'dismissed' ? 'dismissed' : 'active',
    postedAt: row.posted_at,
    firstSeenAt: row.first_seen_at || row.created_at,
    lastSeenAt: row.last_seen_at || row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function criteriaFromRow(row: CriteriaRow | null, roleRows: SearchRoleRow[] = []): SearchCriteria {
  return {
    roleOverrideA: row?.role_override_a ?? '',
    roleOverrideB: row?.role_override_b ?? '',
    roleKeywords: roleRows.sort((a, b) => a.position - b.position).map((entry) => entry.role),
    location: row?.location ?? '',
    workplace: row?.workplace ?? 'any',
    seniority: row?.seniority ?? 'any',
    contractType: row?.contract_type ?? 'any',
    requiredKeywords: stringArray(row?.required_keywords ?? '[]'),
    excludedKeywords: stringArray(row?.excluded_keywords ?? '[]'),
    updatedAt: row?.updated_at ?? '',
  };
}

export function searchRunsFromRows(runRows: SearchRunRow[], sourceRows: SearchRunSourceRow[]) {
  const sourcesByRun = new Map<string, SearchRunSource[]>();
  for (const row of sourceRows) {
    const sources = sourcesByRun.get(row.run_id) ?? [];
    sources.push({
      sourceKey: row.source_key,
      sourceName: row.source_name,
      country: row.country === 'switzerland' || row.country === 'netherlands' ? row.country : 'unknown',
      status: row.status,
      rolesSearched: stringArray(row.roles_searched),
      foundCount: row.found_count,
      knownCount: row.known_count,
      newCount: row.new_count,
      importedCount: row.imported_count,
      duplicateCount: row.duplicate_count,
      skippedCount: row.skipped_count,
      message: row.message,
    });
    sourcesByRun.set(row.run_id, sources);
  }
  return runRows.map((row): SearchRun => ({
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    sources: sourcesByRun.get(row.id) ?? [],
  }));
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
  postedAt?: string;
}

export interface UpsertJobResult {
  job: JobRecord;
  wasKnown: boolean;
  wasDuplicate: boolean;
  wasDismissed: boolean;
}

interface ExistingJobIdentity {
  id: string;
  source_url: string;
  source_key: string;
  status: string;
  is_saved: number;
  application_status: JobRecord['applicationStatus'];
  visibility_status: JobRecord['visibilityStatus'];
  created_at: string;
  first_seen_at: string;
}

export async function upsertJob(db: D1Database, input: UpsertJobInput): Promise<UpsertJobResult> {
  const now = new Date().toISOString();
  const canonicalUrl = canonicalJobUrl(input.sourceUrl);
  const source = sourceInfoForUrl(canonicalUrl, input.location);
  const sourceJobId = sourceJobIdFromUrl(canonicalUrl);
  const globallyStableSourceJobId = isGloballyStableSourceJobId(sourceJobId);
  const postedAt = input.postedAt?.trim() ?? '';
  const workplaceType = detectWorkplaceType(`${input.title} ${input.location} ${input.description}`);
  const identityFingerprint = jobIdentityFingerprint({ ...input, sourceUrl: canonicalUrl, postedAt });
  const exact = await db.prepare(`SELECT id, source_url, source_key, status, is_saved, application_status,
      visibility_status, created_at, first_seen_at FROM jobs
    WHERE rtrim(source_url, '/') = rtrim(?, '/') OR rtrim(canonical_url, '/') = rtrim(?, '/')
      OR (? != '' AND source_job_id = ? AND (source_key = ? OR ? = 1))
    ORDER BY updated_at DESC LIMIT 1`)
    .bind(canonicalUrl, canonicalUrl, sourceJobId, sourceJobId, source.key, globallyStableSourceJobId ? 1 : 0)
    .first<ExistingJobIdentity>();
  const fingerprintMatch = !exact && identityFingerprint
    ? await db.prepare(`SELECT id, source_url, source_key, status, is_saved, application_status,
        visibility_status, created_at, first_seen_at FROM jobs
      WHERE identity_fingerprint = ? ORDER BY updated_at DESC LIMIT 1`)
      .bind(identityFingerprint).first<ExistingJobIdentity>()
    : null;
  const existing = exact ?? fingerprintMatch;
  const wasDuplicate = Boolean(fingerprintMatch && fingerprintMatch.source_key !== source.key);

  const tombstone = await db.prepare(`SELECT id FROM dismissed_jobs
    WHERE (? != '' AND source_job_id = ? AND (source_key = ? OR ? = 1))
      OR (? != '' AND canonical_url = ?)
      OR (? != '' AND identity_fingerprint = ?)
    LIMIT 1`)
    .bind(sourceJobId, sourceJobId, source.key, globallyStableSourceJobId ? 1 : 0,
      canonicalUrl, canonicalUrl, identityFingerprint, identityFingerprint)
    .first<{ id: string }>();
  const visibilityStatus = existing?.visibility_status === 'dismissed' || tombstone ? 'dismissed' : 'active';
  const id = existing?.id ?? crypto.randomUUID();
  if (wasDuplicate && existing) {
    await db.prepare('UPDATE jobs SET last_seen_at = ?, updated_at = ? WHERE id = ?').bind(now, now, id).run();
  } else if (existing) {
    await db.prepare(`UPDATE jobs SET canonical_url = ?, source_key = ?, source_name = ?, source_job_id = ?,
      country = ?, title = ?, company = ?, location = ?, description = ?, language_status = ?, language_summary = ?,
      language_signals = ?, fit_score_a = ?, fit_score_b = ?, best_cv_slot = ?, workplace_type = ?, matched_keywords = ?, missing_keywords = ?,
      identity_fingerprint = ?, visibility_status = ?, posted_at = CASE WHEN ? = '' THEN posted_at ELSE ? END,
      last_seen_at = ?, updated_at = ? WHERE id = ?`)
      .bind(canonicalUrl, source.key, source.name, sourceJobId, source.country, input.title, input.company, input.location,
        input.description, input.languageStatus, input.languageSummary, JSON.stringify(input.languageSignals), input.fitScoreA,
        input.fitScoreB, input.bestCvSlot, workplaceType, JSON.stringify(input.matchedKeywords), JSON.stringify(input.missingKeywords),
        identityFingerprint, visibilityStatus, postedAt, postedAt, now, now, id).run();
  } else {
    await db.prepare(`INSERT INTO jobs (id, source_url, canonical_url, source_key, source_name, source_job_id, country,
      title, company, location, description, language_status, language_summary, language_signals, fit_score_a, fit_score_b,
      best_cv_slot, workplace_type, matched_keywords, missing_keywords, identity_fingerprint, is_saved, application_status,
      visibility_status, posted_at, first_seen_at, last_seen_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, canonicalUrl, canonicalUrl, source.key, source.name, sourceJobId, source.country, input.title, input.company,
        input.location, input.description, input.languageStatus, input.languageSummary, JSON.stringify(input.languageSignals),
        input.fitScoreA, input.fitScoreB, input.bestCvSlot, workplaceType, JSON.stringify(input.matchedKeywords),
        JSON.stringify(input.missingKeywords), identityFingerprint, 0, 'not_applied', visibilityStatus, postedAt, now, now,
        visibilityStatus === 'dismissed' ? 'ignored' : 'new', now, now).run();
  }
  const row = await db.prepare(`SELECT jobs.*, language_feedback.verdict AS feedback_verdict,
    language_feedback.corrected_status AS feedback_corrected_status,
    language_feedback.reason AS feedback_reason, language_feedback.updated_at AS feedback_updated_at
    FROM jobs LEFT JOIN language_feedback ON language_feedback.job_id = jobs.id WHERE jobs.id = ?`)
    .bind(id).first<JobRow>();
  const job = jobFromRow(row!);
  return { job, wasKnown: Boolean(existing), wasDuplicate, wasDismissed: job.visibilityStatus === 'dismissed' };
}

export async function rescoreAllJobs(db: D1Database, cvs: CvInput[]) {
  const jobs = await db.prepare('SELECT id, title, description FROM jobs')
    .all<{ id: string; title: string; description: string }>();
  if (!jobs.results.length) return 0;

  const updates = jobs.results.map((job) => {
    const language = analyzeLanguage(job.description);
    const fit = scoreFitAcrossCvs(job.description, job.title, cvs);
    return db.prepare(`UPDATE jobs SET language_status = ?, language_summary = ?, language_signals = ?,
      fit_score_a = ?, fit_score_b = ?, best_cv_slot = ?, matched_keywords = ?, missing_keywords = ?,
      updated_at = ? WHERE id = ?`)
      .bind(language.status, language.summary, JSON.stringify(language.signals), fit.fitScoreA, fit.fitScoreB,
        fit.bestCvSlot, JSON.stringify(fit.matchedKeywords), JSON.stringify(fit.missingKeywords),
        new Date().toISOString(), job.id);
  });
  for (let start = 0; start < updates.length; start += 50) {
    await db.batch(updates.slice(start, start + 50));
  }
  return updates.length;
}

export type { CriteriaRow, CvRow, JobRow, SearchRoleRow, SearchRunRow, SearchRunSourceRow };
