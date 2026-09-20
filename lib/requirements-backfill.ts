import { analyzeLanguage, scoreFitAcrossCvs, type CvInput, type LanguageStatus } from './analysis';
import { searchAtsBoards } from './ats-feeds';
import { canonicalJobUrl } from './job-identity';
import { stripHtml, type ParsedJob } from './jobsch';
import { extractRequirements } from './requirements';
import { detectWorkplaceType } from './workplace';
import { NORMALIZATION_VERSION } from './server-data';

/**
 * Re-read employer-board jobs that were stored before ingest kept list markup (#17).
 *
 * `stripHtml` turns `<li>` into a bulleted line and block tags into line breaks, and
 * `extractRequirements` reads those lines. An older ingest collapsed all of it to spaces, so
 * those rows are one long paragraph and the requirements list on their card is empty — not
 * because the advertisement had none, but because the structure was thrown away before it was
 * stored. Re-extraction cannot recover it; the markup is gone. Only re-reading the source can.
 *
 * **A flat description is not on its own a reason to re-read.** Measured against the stored test
 * corpus on 2026-09-20: of 1,677 rows with no line break at all, 1,312 are capped previews -
 * Careerjet at ~246 characters, Adzuna at ~500, short Job-Room previews at ~483 - which have no
 * structure to recover and would return the identical text. Re-reading those would spend requests
 * on other people's servers to learn nothing. The length floor below is what excludes them, and
 * it is the same 900 characters the language gate uses to decide an advertisement is long enough
 * to judge at all.
 *
 * Scope is deliberately employer boards only. Job-Room short previews are #29's backfill, which
 * already exists. jobs.ch and jobup.ch have 90 such rows between them, but they are page-fetched
 * behind the VPN gate and re-reading them is a source-conduct decision under
 * `docs/SOURCE_POLICY.md`, not a maintenance job.
 */
export const STRUCTURE_BACKFILL_VERSION = 1;

/** Below this, the stored text is a capped preview rather than a flattened advertisement. */
export const MIN_STRUCTURE_BACKFILL_CHARS = 900;

/** One board read serves every row, so this bounds work and write volume, not requests. */
export const MAX_STRUCTURE_BACKFILL_ROWS = 200;

/**
 * How much of the stored length the board's copy must still carry before it is written.
 *
 * Requiring it to be no shorter at all was the first rule here, and it was wrong: employers edit
 * their advertisements, and a trimmed one would have been refused permanently while the row
 * stayed eligible to be examined again on every future run. What actually needs guarding against
 * is a board serving a stub in place of the advertisement, and that is a different shape - a
 * collapse rather than an edit - which is what this catches.
 */
export const MIN_RETAINED_FRACTION = 0.5;

interface BackfillJobRow {
  id: string;
  canonical_url: string;
  title: string;
  location: string;
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

export interface RequirementsBackfillReport {
  eligibleCount: number;
  attemptedCount: number;
  /** Matched to a posting still on its employer's board. */
  matchedCount: number;
  updatedCount: number;
  /** Matched, but the board's own text has no structure either, so there was nothing to gain. */
  unchangedCount: number;
  /** No configured board still carries this posting; left for a later run rather than written off. */
  notFoundCount: number;
  gainedRequirementsCount: number;
  remainingCount: number;
  verdictChangeCount: number;
  verdictDirections: Record<string, number>;
}

export interface RequirementsBackfillOptions {
  maxRows?: number;
  loadBoardJobs?: () => Promise<ParsedJob[]>;
}

function boundedLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return MAX_STRUCTURE_BACKFILL_ROWS;
  return Math.max(1, Math.min(MAX_STRUCTURE_BACKFILL_ROWS, Math.floor(value!)));
}

function cvsWithEffectiveRoles(rows: BackfillCvRow[], criteria: BackfillCriteriaRow | null): CvInput[] {
  return rows.map((row) => ({
    slot: row.slot,
    cvText: row.cv_text,
    derivedRole: ((row.slot === 'a' ? criteria?.role_override_a : criteria?.role_override_b) ?? '').trim()
      || row.derived_role,
  }));
}

/**
 * Rows worth re-reading: one unbroken paragraph, long enough that the advertisement really was
 * flattened rather than truncated upstream, and not already done.
 */
const ELIGIBLE_WHERE = `user_id = ? AND instr(description, char(10)) = 0
  AND length(description) >= ? AND structure_version < ?`;

async function remainingCount(db: D1Database, userId: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE ${ELIGIBLE_WHERE}`)
    .bind(userId, MIN_STRUCTURE_BACKFILL_CHARS, STRUCTURE_BACKFILL_VERSION)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Restore list structure to flattened employer-board jobs for one account.
 *
 * Only content and derived analysis columns are written. Saved, applied, dismissed and
 * duplicate state and `language_feedback` are absent from the UPDATE on purpose: a maintenance
 * pass must never quietly undo something the person did.
 */
export async function backfillFlattenedDescriptions(
  db: D1Database,
  userId: string,
  options: RequirementsBackfillOptions = {},
): Promise<RequirementsBackfillReport> {
  const maxRows = boundedLimit(options.maxRows);
  const loadBoardJobs = options.loadBoardJobs ?? searchAtsBoards;
  const eligibleCount = await remainingCount(db, userId);

  const report: RequirementsBackfillReport = {
    eligibleCount,
    attemptedCount: 0,
    matchedCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    notFoundCount: 0,
    gainedRequirementsCount: 0,
    remainingCount: eligibleCount,
    verdictChangeCount: 0,
    verdictDirections: {},
  };
  // Reading every board costs the same whether one row needs it or none do, so do not read at all
  // when there is nothing to apply it to.
  if (eligibleCount === 0) return report;

  const [jobs, cvRows, criteria] = await Promise.all([
    db.prepare(`SELECT id, canonical_url, title, location, description, language_status FROM jobs
      WHERE ${ELIGIBLE_WHERE} ORDER BY updated_at, id LIMIT ?`)
      .bind(userId, MIN_STRUCTURE_BACKFILL_CHARS, STRUCTURE_BACKFILL_VERSION, maxRows)
      .all<BackfillJobRow>(),
    db.prepare('SELECT slot, cv_text, derived_role FROM cvs WHERE user_id = ? ORDER BY slot')
      .bind(userId).all<BackfillCvRow>(),
    db.prepare('SELECT role_override_a, role_override_b FROM search_settings WHERE user_id = ?')
      .bind(userId).first<BackfillCriteriaRow>(),
  ]);
  report.attemptedCount = jobs.results.length;
  const cvs = cvsWithEffectiveRoles(cvRows.results, criteria);

  // One read of the configured boards serves every row, rather than a request per job. It is the
  // same cached call an ordinary search makes, so this adds no new kind of traffic.
  const boardJobs = await loadBoardJobs();
  const byCanonicalUrl = new Map<string, ParsedJob>();
  for (const job of boardJobs) {
    const key = canonicalJobUrl(job.sourceUrl);
    if (key && !byCanonicalUrl.has(key)) byCanonicalUrl.set(key, job);
  }

  const now = new Date().toISOString();
  for (const job of jobs.results) {
    const match = byCanonicalUrl.get(job.canonical_url);
    if (!match) {
      // The posting has been taken down, or its employer is not configured. Deliberately not
      // version-stamped: adding that board later should let this row be picked up.
      report.notFoundCount += 1;
      continue;
    }
    report.matchedCount += 1;
    const description = stripHtml(match.descriptionHtml);

    // The only thing this pass exists to restore. If the board's own copy is a single paragraph
    // too, there is nothing to gain and re-reading it again next time would be waste - so stamp
    // the row and move on without touching its text.
    const gainedStructure = description.includes('\n')
      && description.length >= MIN_STRUCTURE_BACKFILL_CHARS
      && description.length >= job.description.length * MIN_RETAINED_FRACTION;
    if (!gainedStructure) {
      await db.prepare(`UPDATE jobs SET structure_version = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND structure_version < ?`)
        .bind(STRUCTURE_BACKFILL_VERSION, now, job.id, userId, STRUCTURE_BACKFILL_VERSION).run();
      report.unchangedCount += 1;
      continue;
    }

    const language = analyzeLanguage(description, job.title);
    const fit = scoreFitAcrossCvs(description, job.title, cvs);
    const workplaceType = detectWorkplaceType(`${job.title} ${job.location} ${description}`);
    const result = await db.prepare(`UPDATE jobs SET description = ?, language_status = ?,
      language_summary = ?, language_signals = ?, fit_score_a = ?, fit_score_b = ?,
      best_cv_slot = ?, workplace_type = ?, matched_keywords = ?, missing_keywords = ?,
      normalized_version = ?, structure_version = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND structure_version < ?`)
      .bind(description, language.status, language.summary, JSON.stringify(language.signals),
        fit.fitScoreA, fit.fitScoreB, fit.bestCvSlot, workplaceType,
        JSON.stringify(fit.matchedKeywords), JSON.stringify(fit.missingKeywords),
        NORMALIZATION_VERSION, STRUCTURE_BACKFILL_VERSION, now,
        job.id, userId, STRUCTURE_BACKFILL_VERSION).run();
    if ((result.meta.changes ?? 0) < 1) continue;
    report.updatedCount += 1;
    // Measured rather than assumed. Restoring line breaks is the means; a requirements list
    // appearing on the card is the point, and the two are not the same count - an advertisement
    // can regain its structure and still have no section the extractor recognises.
    if (!extractRequirements(job.description) && extractRequirements(description)) {
      report.gainedRequirementsCount += 1;
    }
    if (job.language_status !== language.status) {
      const direction = `${job.language_status} → ${language.status}`;
      report.verdictDirections[direction] = (report.verdictDirections[direction] ?? 0) + 1;
      report.verdictChangeCount += 1;
    }
  }

  report.remainingCount = await remainingCount(db, userId);
  return report;
}
