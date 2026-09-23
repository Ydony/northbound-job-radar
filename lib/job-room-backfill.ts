import { analyzeJobLanguage, type LanguageStatus } from './analysis';
import { detectWorkplaceType } from './workplace';
import {
  advertisementToParsedJob,
  fetchJobRoomAdvertisement,
  isPublicationOpen,
  jobRoomIdFromUrl,
  JOB_ROOM_DETAIL_DELAY_MS,
  JOB_ROOM_FULL_TEXT_THRESHOLD,
  MAX_JOB_ROOM_DETAIL_FETCHES,
  type JobRoomAdvertisement,
  type JobRoomParsedJob,
} from './job-room';
import { jobIdentityFingerprint } from './job-identity';
import { delay, stripHtml } from './jobsch';
import { searchTextForJob } from './criteria';
import { NORMALIZATION_VERSION } from './server-data';

export const JOB_ROOM_DETAIL_BACKFILL_VERSION = 1;
export const JOB_ROOM_POSTED_AT_BACKFILL_VERSION = 1;

interface BackfillJobRow {
  id: string;
  source_url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  posted_at: string;
  expires_at: string;
  language_status: LanguageStatus;
}


export interface JobRoomBackfillReport {
  eligibleCount: number;
  attemptedCount: number;
  fetchedCount: number;
  updatedCount: number;
  unchangedCount: number;
  failedCount: number;
  /** Rows whose advertisement answered closed: marked expired in this pass, not retried. */
  expiredCount: number;
  remainingCount: number;
  verdictChangeCount: number;
  verdictDirections: Record<string, number>;
}

export interface JobRoomBackfillOptions {
  maxDetails?: number;
  delayMs?: number;
  fetchDetail?: (id: string) => Promise<JobRoomParsedJob | null>;
  /**
   * Raw advertisement fetch, preferred over fetchDetail because it sees a closed
   * advertisement in the same single request (#97). The parser refuses those by design,
   * so through fetchDetail a closed row is indistinguishable from a network failure and
   * would stay eligible forever, spending the capped budget run after run. Defaults to
   * the live endpoint; pass fetchDetail instead only to keep a legacy stub.
   */
  fetchAdvertisement?: (id: string) => Promise<JobRoomAdvertisement | null>;
  pause?: (ms: number) => Promise<void>;
}

function boundedLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return MAX_JOB_ROOM_DETAIL_FETCHES;
  return Math.max(1, Math.min(MAX_JOB_ROOM_DETAIL_FETCHES, Math.floor(value!)));
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
 * The posting date a fetched detail carries, when it answers the row's date question.
 *
 * Empty when the row already has a date (nothing to fill) or the detail carries none (the
 * source truly publishes none). Only a non-empty value may change stored state: like upsertJob,
 * a backfill never overwrites or clears a date already held.
 */
function postingDateFill(row: BackfillJobRow, detail: JobRoomParsedJob) {
  const published = detail.postedAt?.trim() ?? '';
  return row.posted_at ? '' : published;
}

/**
 * The expiry a fetched detail carries, under the same never-clear rule as the posting date:
 * empty when the row already holds one or the source published none.
 */
function expiryFill(row: Pick<BackfillJobRow, 'expires_at'>, expiresAt: string | undefined) {
  const published = expiresAt?.trim() ?? '';
  return row.expires_at ? '' : published;
}

/**
 * The closure date to store when a re-fetched advertisement answers closed (#97).
 *
 * The earliest non-empty evidence wins: a past end date, the cancellation date, or - when
 * the advertisement carries neither - the day the closure was observed, which the card
 * reads as "closes today" until it becomes strictly past. Unconditional by design, unlike
 * the fills above: this is an observed fact correcting the row, so a stored future end
 * date on an advertisement the source has since withdrawn must move, not stay.
 */
function closedExpiryDate(advertisement: JobRoomAdvertisement, today = new Date()): string {
  const candidates = [
    advertisement.publication?.endDate?.trim() ?? '',
    (advertisement.cancellationDate ?? '').slice(0, 10),
    today.toISOString().slice(0, 10),
  ].filter(Boolean);
  return candidates.sort()[0] ?? '';
}

type ResolvedJobRoomDetail =
  | { kind: 'open'; detail: JobRoomParsedJob }
  | { kind: 'closed'; advertisement: JobRoomAdvertisement }
  | { kind: 'failed' };

/**
 * One capped request answering both the content question and the closure question.
 *
 * Through the raw advertisement a closed row is seen as closed in that same request; through
 * the legacy parsed-detail fetch it looks exactly like a failure and stays eligible. The raw
 * path is the default - production callers pass no fetch option - while tests keep injecting
 * fetchDetail stubs for the content behaviour they pin.
 */
async function resolveJobRoomDetail(
  sourceId: string,
  options: JobRoomBackfillOptions,
): Promise<ResolvedJobRoomDetail> {
  const fetchAdvertisement = options.fetchAdvertisement
    ?? (options.fetchDetail ? undefined : fetchJobRoomAdvertisement);
  if (fetchAdvertisement) {
    if (!sourceId) return { kind: 'failed' };
    const advertisement = await fetchAdvertisement(sourceId);
    if (!advertisement) return { kind: 'failed' };
    if (!isPublicationOpen(advertisement)) return { kind: 'closed', advertisement };
    const detail = advertisementToParsedJob(advertisement);
    return detail ? { kind: 'open', detail } : { kind: 'failed' };
  }
  const detail = sourceId ? await options.fetchDetail!(sourceId) : null;
  return detail ? { kind: 'open', detail } : { kind: 'failed' };
}

function emptyReport(eligibleCount: number): JobRoomBackfillReport {
  return {
    eligibleCount,
    attemptedCount: 0,
    fetchedCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    failedCount: 0,
    expiredCount: 0,
    remainingCount: eligibleCount,
    verdictChangeCount: 0,
    verdictDirections: {},
  };
}

/**
 * Upgrade short Job-Room previews already stored for one account.
 *
 * Only content and derived analysis columns are updated. Saved/application/dismissed state,
 * duplicate identity and language_feedback are deliberately absent from both UPDATE statements.
 *
 * A successful detail fetch also answers the row's posting-date question (#88): the same
 * response carries publication.startDate, so the fetched date is stored rather than spending a
 * second capped request on it, and the posted-at version is marked even when the source
 * publishes no date.
 */
export async function backfillJobRoomDescriptions(
  db: D1Database,
  userId: string,
  options: JobRoomBackfillOptions = {},
): Promise<JobRoomBackfillReport> {
  const maxDetails = boundedLimit(options.maxDetails);
  const delayMs = options.delayMs ?? JOB_ROOM_DETAIL_DELAY_MS;
  const pause = options.pause ?? delay;
  const eligibleCount = await remainingCount(db, userId);
  const jobs = await db.prepare(`SELECT id, source_url, title, company, location, description, posted_at, expires_at, language_status FROM jobs
      WHERE user_id = ? AND source_key = 'job-room.ch' AND length(description) < ?
        AND job_room_detail_version < ?
      ORDER BY updated_at, id LIMIT ?`)
      .bind(userId, JOB_ROOM_FULL_TEXT_THRESHOLD, JOB_ROOM_DETAIL_BACKFILL_VERSION, maxDetails)
      .all<BackfillJobRow>();
  const report = emptyReport(eligibleCount);
  report.attemptedCount = jobs.results.length;

  for (const [index, job] of jobs.results.entries()) {
    if (index > 0 && delayMs > 0) await pause(delayMs);
    const sourceId = jobRoomIdFromUrl(job.source_url);
    const resolved = await resolveJobRoomDetail(sourceId, options);
    if (resolved.kind === 'failed') {
      report.failedCount += 1;
      continue;
    }
    if (resolved.kind === 'closed') {
      // The advertisement died after it was stored - the owner's hit case. Marked expired
      // here in the same request that proved it, never deleted: the person may have applied,
      // and the row leaves eligibility so reruns terminate instead of spending the cap on it.
      report.fetchedCount += 1;
      report.expiredCount += 1;
      const observed = closedExpiryDate(resolved.advertisement);
      const dateFill = job.posted_at ? '' : (resolved.advertisement.publication?.startDate ?? '');
      const fingerprint = dateFill
        ? jobIdentityFingerprint({
          sourceUrl: job.source_url,
          title: job.title,
          company: job.company,
          location: job.location,
          postedAt: dateFill,
        })
        : '';
      await db.prepare(`UPDATE jobs SET job_room_detail_version = ?,
        posted_at = CASE WHEN ? = '' THEN posted_at ELSE ? END,
        expires_at = ?, identity_fingerprint = CASE WHEN ? = '' THEN identity_fingerprint ELSE ? END,
        cluster_version = CASE WHEN ? = '' THEN cluster_version ELSE 0 END,
        job_room_posted_at_version = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND job_room_detail_version < ?`)
        .bind(JOB_ROOM_DETAIL_BACKFILL_VERSION, dateFill, dateFill, observed, dateFill, fingerprint,
          dateFill, JOB_ROOM_POSTED_AT_BACKFILL_VERSION, new Date().toISOString(), job.id, userId,
          JOB_ROOM_DETAIL_BACKFILL_VERSION).run();
      continue;
    }
    const detail = resolved.detail;
    report.fetchedCount += 1;
    const dateFill = postingDateFill(job, detail);
    const expiresFill = expiryFill(job, detail.expiresAt);
    const fingerprint = dateFill
      ? jobIdentityFingerprint({
        sourceUrl: job.source_url,
        title: job.title,
        company: job.company,
        location: job.location,
        postedAt: dateFill,
      })
      : '';
    const description = stripHtml(detail.descriptionHtml);
    if (description.length <= job.description.length) {
      await db.prepare(`UPDATE jobs SET job_room_detail_version = ?,
        posted_at = CASE WHEN ? = '' THEN posted_at ELSE ? END,
        expires_at = CASE WHEN ? = '' THEN expires_at ELSE ? END,
        identity_fingerprint = CASE WHEN ? = '' THEN identity_fingerprint ELSE ? END,
        cluster_version = CASE WHEN ? = '' THEN cluster_version ELSE 0 END,
        job_room_posted_at_version = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND job_room_detail_version < ?`)
        .bind(JOB_ROOM_DETAIL_BACKFILL_VERSION, dateFill, dateFill, expiresFill, expiresFill,
          dateFill, fingerprint, dateFill,
          JOB_ROOM_POSTED_AT_BACKFILL_VERSION, new Date().toISOString(), job.id, userId,
          JOB_ROOM_DETAIL_BACKFILL_VERSION).run();
      report.unchangedCount += 1;
      continue;
    }

    const language = analyzeJobLanguage(description, job.title, detail.languageSkills);
    const workplaceType = detectWorkplaceType(`${job.title} ${detail.location} ${description}`);
    const result = await db.prepare(`UPDATE jobs SET description = ?, language_status = ?,
      language_summary = ?, language_signals = ?, workplace_type = ?,
      search_text = ?,
      posted_at = CASE WHEN ? = '' THEN posted_at ELSE ? END,
      expires_at = CASE WHEN ? = '' THEN expires_at ELSE ? END,
      identity_fingerprint = CASE WHEN ? = '' THEN identity_fingerprint ELSE ? END,
      cluster_version = CASE WHEN ? = '' THEN cluster_version ELSE 0 END,
      normalized_version = ?, job_room_detail_version = ?, job_room_posted_at_version = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND length(description) < ? AND job_room_detail_version < ?`)
      .bind(description, language.status, language.summary, JSON.stringify(language.signals),
        workplaceType,
        searchTextForJob({ title: job.title, location: job.location, description }),
        dateFill, dateFill, expiresFill, expiresFill, dateFill, fingerprint, dateFill,
        NORMALIZATION_VERSION, JOB_ROOM_DETAIL_BACKFILL_VERSION, JOB_ROOM_POSTED_AT_BACKFILL_VERSION,
        new Date().toISOString(),
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

interface PostedAtBackfillRow {
  id: string;
  source_url: string;
  title: string;
  company: string;
  location: string;
  expires_at: string;
}

async function remainingDatelessCount(db: D1Database, userId: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM jobs
    WHERE user_id = ? AND source_key = 'job-room.ch' AND posted_at = ''
      AND job_room_posted_at_version < ?`)
    .bind(userId, JOB_ROOM_POSTED_AT_BACKFILL_VERSION)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Fill the posting date on Job-Room rows stored without one.
 *
 * Every Job-Room row written before #88 carries posted_at = '' because the parser read
 * `publicationStartDate` at the top level while the API nests the date as
 * `publication.startDate`. A dateless row cannot be told apart from a fresh one, which is how
 * a weeks-old posting arrives looking like today's — so the date is re-fetched from the same
 * public detail endpoint the description backfill already uses, under the same cap and pace.
 *
 * Only the date and what derives from it are written. A filled date changes the identity
 * fingerprint (which hashes the posting day, and is empty on every dateless row by migration
 * 3) and can change duplicate grouping (which compares posting days), so the fingerprint is
 * recomputed and the cluster links invalidated for the next read to re-derive. Saved,
 * applied, dismissed, description, language, duplicate and language_feedback state are
 * deliberately untouched: a date never rescreens a verdict.
 *
 * A fetch that succeeds but carries no date still marks the row — the source truly publishes
 * none, and refetching would never answer it. A failed fetch stays eligible for a later retry.
 * An advertisement whose window has since closed is neither: the same request that proves it
 * records the expiry (#97) and marks the row, so it stops spending the capped budget.
 */
export async function backfillJobRoomPostingDates(
  db: D1Database,
  userId: string,
  options: JobRoomBackfillOptions = {},
): Promise<JobRoomBackfillReport> {
  const maxDetails = boundedLimit(options.maxDetails);
  const delayMs = options.delayMs ?? JOB_ROOM_DETAIL_DELAY_MS;
  const pause = options.pause ?? delay;
  const eligibleCount = await remainingDatelessCount(db, userId);
  const jobs = await db.prepare(`SELECT id, source_url, title, company, location, expires_at FROM jobs
      WHERE user_id = ? AND source_key = 'job-room.ch' AND posted_at = ''
        AND job_room_posted_at_version < ?
      ORDER BY updated_at, id LIMIT ?`)
    .bind(userId, JOB_ROOM_POSTED_AT_BACKFILL_VERSION, maxDetails)
    .all<PostedAtBackfillRow>();
  const report = emptyReport(eligibleCount);
  report.attemptedCount = jobs.results.length;

  for (const [index, job] of jobs.results.entries()) {
    if (index > 0 && delayMs > 0) await pause(delayMs);
    const sourceId = jobRoomIdFromUrl(job.source_url);
    const resolved = await resolveJobRoomDetail(sourceId, options);
    if (resolved.kind === 'failed') {
      report.failedCount += 1;
      continue;
    }
    if (resolved.kind === 'closed') {
      // Same proof, same pass: the re-read that was meant to fill the date found the
      // advertisement gone instead. The expiry is recorded and the row leaves eligibility,
      // so a closed advertisement stops spending the capped budget on retries.
      report.fetchedCount += 1;
      report.expiredCount += 1;
      const observed = closedExpiryDate(resolved.advertisement);
      const published = (resolved.advertisement.publication?.startDate ?? '').trim();
      const fingerprint = published
        ? jobIdentityFingerprint({
          sourceUrl: job.source_url,
          title: job.title,
          company: job.company,
          location: job.location,
          postedAt: published,
        })
        : '';
      const result = await db.prepare(`UPDATE jobs SET posted_at = CASE WHEN ? = '' THEN posted_at ELSE ? END,
        expires_at = ?,
        identity_fingerprint = CASE WHEN ? = '' THEN identity_fingerprint ELSE ? END,
        cluster_version = CASE WHEN ? = '' THEN cluster_version ELSE 0 END,
        job_room_posted_at_version = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND posted_at = '' AND job_room_posted_at_version < ?`)
        .bind(published, published, observed, fingerprint, fingerprint, published,
          JOB_ROOM_POSTED_AT_BACKFILL_VERSION, new Date().toISOString(),
          job.id, userId, JOB_ROOM_POSTED_AT_BACKFILL_VERSION).run();
      if ((result.meta.changes ?? 0) < 1) continue;
      if (published) report.updatedCount += 1;
      else report.unchangedCount += 1;
      continue;
    }
    const detail = resolved.detail;
    report.fetchedCount += 1;
    const published = detail.postedAt?.trim() ?? '';
    const expiresFill = expiryFill(job, detail.expiresAt);
    if (!published) {
      await db.prepare(`UPDATE jobs SET job_room_posted_at_version = ?,
        expires_at = CASE WHEN ? = '' THEN expires_at ELSE ? END, updated_at = ?
        WHERE id = ? AND user_id = ? AND posted_at = '' AND job_room_posted_at_version < ?`)
        .bind(JOB_ROOM_POSTED_AT_BACKFILL_VERSION, expiresFill, expiresFill, new Date().toISOString(),
          job.id, userId, JOB_ROOM_POSTED_AT_BACKFILL_VERSION).run();
      report.unchangedCount += 1;
      continue;
    }
    const fingerprint = jobIdentityFingerprint({
      sourceUrl: job.source_url,
      title: job.title,
      company: job.company,
      location: job.location,
      postedAt: published,
    });
    const result = await db.prepare(`UPDATE jobs SET posted_at = ?,
      expires_at = CASE WHEN ? = '' THEN expires_at ELSE ? END,
      identity_fingerprint = ?, cluster_version = 0,
      job_room_posted_at_version = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND posted_at = '' AND job_room_posted_at_version < ?`)
      .bind(published, expiresFill, expiresFill, fingerprint, JOB_ROOM_POSTED_AT_BACKFILL_VERSION,
        new Date().toISOString(), job.id, userId, JOB_ROOM_POSTED_AT_BACKFILL_VERSION).run();
    if ((result.meta.changes ?? 0) < 1) continue;
    report.updatedCount += 1;
  }

  report.remainingCount = await remainingDatelessCount(db, userId);
  return report;
}
