import { analyzeJobLanguage, scoreFitAcrossCvs, type CvInput, type LanguageStatus } from './analysis';
import { detectWorkplaceType } from './workplace';
import {
  fetchJobRoomDetail,
  jobRoomIdFromUrl,
  JOB_ROOM_DETAIL_DELAY_MS,
  JOB_ROOM_FULL_TEXT_THRESHOLD,
  MAX_JOB_ROOM_DETAIL_FETCHES,
  type JobRoomParsedJob,
} from './job-room';
import { delay, stripHtml } from './jobsch';
import { NORMALIZATION_VERSION } from './server-data';

export const JOB_ROOM_DETAIL_BACKFILL_VERSION = 1;

interface BackfillJobRow {
  id: string;
  source_url: string;
  title: string;
  description: string;
  language_status: LanguageStatus;
}

interface BackfillCvRow {
  slot: 'a' | 'b';
  cv_text: string;
  derived_role: string;
}

interface BackfillCriteriaRow {
  role_override_a: string;
  role_override_b: string;
}

export interface JobRoomBackfillReport {
  eligibleCount: number;
  attemptedCount: number;
  fetchedCount: number;
  updatedCount: number;
  unchangedCount: number;
  failedCount: number;
  remainingCount: number;
  verdictChangeCount: number;
  verdictDirections: Record<string, number>;
}

export interface JobRoomBackfillOptions {
  maxDetails?: number;
  delayMs?: number;
  fetchDetail?: (id: string) => Promise<JobRoomParsedJob | null>;
  pause?: (ms: number) => Promise<void>;
}

function boundedLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return MAX_JOB_ROOM_DETAIL_FETCHES;
  return Math.max(1, Math.min(MAX_JOB_ROOM_DETAIL_FETCHES, Math.floor(value!)));
}

function cvsWithEffectiveRoles(rows: BackfillCvRow[], criteria: BackfillCriteriaRow | null): CvInput[] {
  return rows.map((row) => ({
    slot: row.slot,
    cvText: row.cv_text,
    derivedRole: ((row.slot === 'a' ? criteria?.role_override_a : criteria?.role_override_b) ?? '').trim()
      || row.derived_role,
  }));
}

async function remainingCount(db: D1Database, userId: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM jobs
    WHERE user_id = ? AND source_key = 'job-room.ch' AND length(description) < ?
      AND job_room_detail_version < ?`)
    .bind(userId, JOB_ROOM_FULL_TEXT_THRESHOLD, JOB_ROOM_DETAIL_BACKFILL_VERSION)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Upgrade short Job-Room previews already stored for one account.
 *
 * Only content and derived analysis columns are updated. Saved/application/dismissed state,
 * duplicate identity and language_feedback are deliberately absent from both UPDATE statements.
 */
export async function backfillJobRoomDescriptions(
  db: D1Database,
  userId: string,
  options: JobRoomBackfillOptions = {},
): Promise<JobRoomBackfillReport> {
  const maxDetails = boundedLimit(options.maxDetails);
  const delayMs = options.delayMs ?? JOB_ROOM_DETAIL_DELAY_MS;
  const fetchDetail = options.fetchDetail ?? fetchJobRoomDetail;
  const pause = options.pause ?? delay;
  const eligibleCount = await remainingCount(db, userId);
  const [jobs, cvRows, criteria] = await Promise.all([
    db.prepare(`SELECT id, source_url, title, description, language_status FROM jobs
      WHERE user_id = ? AND source_key = 'job-room.ch' AND length(description) < ?
        AND job_room_detail_version < ?
      ORDER BY updated_at, id LIMIT ?`)
      .bind(userId, JOB_ROOM_FULL_TEXT_THRESHOLD, JOB_ROOM_DETAIL_BACKFILL_VERSION, maxDetails)
      .all<BackfillJobRow>(),
    db.prepare('SELECT slot, cv_text, derived_role FROM cvs WHERE user_id = ? ORDER BY slot')
      .bind(userId).all<BackfillCvRow>(),
    db.prepare('SELECT role_override_a, role_override_b FROM search_settings WHERE user_id = ?')
      .bind(userId).first<BackfillCriteriaRow>(),
  ]);
  const cvs = cvsWithEffectiveRoles(cvRows.results, criteria);
  const report: JobRoomBackfillReport = {
    eligibleCount,
    attemptedCount: jobs.results.length,
    fetchedCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    failedCount: 0,
    remainingCount: eligibleCount,
    verdictChangeCount: 0,
    verdictDirections: {},
  };

  for (const [index, job] of jobs.results.entries()) {
    if (index > 0 && delayMs > 0) await pause(delayMs);
    const sourceId = jobRoomIdFromUrl(job.source_url);
    const detail = sourceId ? await fetchDetail(sourceId) : null;
    if (!detail) {
      report.failedCount += 1;
      continue;
    }
    report.fetchedCount += 1;
    const description = stripHtml(detail.descriptionHtml);
    if (description.length <= job.description.length) {
      await db.prepare(`UPDATE jobs SET job_room_detail_version = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND job_room_detail_version < ?`)
        .bind(JOB_ROOM_DETAIL_BACKFILL_VERSION, new Date().toISOString(), job.id, userId,
          JOB_ROOM_DETAIL_BACKFILL_VERSION).run();
      report.unchangedCount += 1;
      continue;
    }

    const language = analyzeJobLanguage(description, job.title, detail.languageSkills);
    const fit = scoreFitAcrossCvs(description, job.title, cvs);
    const workplaceType = detectWorkplaceType(`${job.title} ${detail.location} ${description}`);
    const result = await db.prepare(`UPDATE jobs SET description = ?, language_status = ?,
      language_summary = ?, language_signals = ?, fit_score_a = ?, fit_score_b = ?,
      best_cv_slot = ?, workplace_type = ?, matched_keywords = ?, missing_keywords = ?,
      normalized_version = ?, job_room_detail_version = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND length(description) < ? AND job_room_detail_version < ?`)
      .bind(description, language.status, language.summary, JSON.stringify(language.signals),
        fit.fitScoreA, fit.fitScoreB, fit.bestCvSlot, workplaceType,
        JSON.stringify(fit.matchedKeywords), JSON.stringify(fit.missingKeywords),
        NORMALIZATION_VERSION, JOB_ROOM_DETAIL_BACKFILL_VERSION, new Date().toISOString(),
        job.id, userId, JOB_ROOM_FULL_TEXT_THRESHOLD, JOB_ROOM_DETAIL_BACKFILL_VERSION).run();
    if ((result.meta.changes ?? 0) < 1) continue;
    report.updatedCount += 1;
    if (job.language_status !== language.status) {
      const direction = `${job.language_status} → ${language.status}`;
      report.verdictDirections[direction] = (report.verdictDirections[direction] ?? 0) + 1;
      report.verdictChangeCount += 1;
    }
  }

  report.remainingCount = await remainingCount(db, userId);
  return report;
}
