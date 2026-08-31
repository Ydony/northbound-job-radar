import { analyzeLanguage, scoreFitAcrossCvs, type CvInput, type LanguageStatus } from './analysis';
import { canonicalJobUrl, isGloballyStableSourceJobId, isNearDuplicate, jobClusterKey, jobIdentityFingerprint,
  sourceInfoForUrl, sourceJobIdFromUrl } from './job-identity';
import { decodeEntities } from './jobsch';
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
  cluster_key: string;
  duplicate_of: string;
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
    duplicateOf: row.duplicate_of ?? '',
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

interface NearDuplicateCandidate {
  id: string;
  location: string;
  posted_at: string;
  duplicate_of: string;
  first_seen_at: string;
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

export async function upsertJob(db: D1Database, userId: string, rawInput: UpsertJobInput): Promise<UpsertJobResult> {
  // Feeds hand over titles and company names with the tags already stripped but the entities still
  // encoded. Decoding here rather than in each adapter means every source is covered by one rule,
  // and it matters for more than looks: "Senior Cost &amp; Inventory Analyst" never matched its own
  // duplicate spelled with a real ampersand.
  const input: UpsertJobInput = {
    ...rawInput,
    title: decodeEntities(rawInput.title),
    company: decodeEntities(rawInput.company),
    location: decodeEntities(rawInput.location),
  };
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
    WHERE user_id = ? AND (rtrim(source_url, '/') = rtrim(?, '/') OR rtrim(canonical_url, '/') = rtrim(?, '/')
      OR (? != '' AND source_job_id = ? AND (source_key = ? OR ? = 1)))
    ORDER BY updated_at DESC LIMIT 1`)
    .bind(userId, canonicalUrl, canonicalUrl, sourceJobId, sourceJobId, source.key, globallyStableSourceJobId ? 1 : 0)
    .first<ExistingJobIdentity>();
  const fingerprintMatch = !exact && identityFingerprint
    ? await db.prepare(`SELECT id, source_url, source_key, status, is_saved, application_status,
        visibility_status, created_at, first_seen_at FROM jobs
      WHERE user_id = ? AND identity_fingerprint = ? ORDER BY updated_at DESC LIMIT 1`)
      .bind(userId, identityFingerprint).first<ExistingJobIdentity>()
    : null;
  const existing = exact ?? fingerprintMatch;
  const clusterKey = jobClusterKey(input);
  // Only a genuinely new row needs a near-duplicate search: anything matched above is already the
  // same row being refreshed. The candidate list is bounded by the cluster index, and the range
  // comparison that the fingerprint hash cannot express happens here in TypeScript.
  const nearMatch = !existing && clusterKey
    ? (await db.prepare(`SELECT id, location, posted_at, duplicate_of, first_seen_at FROM jobs
        WHERE user_id = ? AND cluster_key = ? ORDER BY first_seen_at LIMIT 25`)
        .bind(userId, clusterKey).all<NearDuplicateCandidate>())
      .results.find((candidate) => isNearDuplicate(
        { location: input.location, postedAt },
        { location: candidate.location, postedAt: candidate.posted_at },
      ))
    : undefined;
  // Point at the row actually on screen, never at another copy, so the chain stays one level deep.
  const duplicateOf = nearMatch ? nearMatch.duplicate_of || nearMatch.id : '';
  const wasDuplicate = Boolean(nearMatch) || Boolean(fingerprintMatch && fingerprintMatch.source_key !== source.key);

  const tombstone = await db.prepare(`SELECT id FROM dismissed_jobs
    WHERE user_id = ? AND ((? != '' AND source_job_id = ? AND (source_key = ? OR ? = 1))
      OR (? != '' AND canonical_url = ?)
      OR (? != '' AND identity_fingerprint = ?))
    LIMIT 1`)
    .bind(userId, sourceJobId, sourceJobId, source.key, globallyStableSourceJobId ? 1 : 0,
      canonicalUrl, canonicalUrl, identityFingerprint, identityFingerprint)
    .first<{ id: string }>();
  const visibilityStatus = existing?.visibility_status === 'dismissed' || tombstone ? 'dismissed' : 'active';
  const id = existing?.id ?? crypto.randomUUID();
  if (wasDuplicate && existing) {
    await db.prepare('UPDATE jobs SET last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(now, now, id, userId).run();
  } else if (existing) {
    await db.prepare(`UPDATE jobs SET canonical_url = ?, source_key = ?, source_name = ?, source_job_id = ?,
      country = ?, title = ?, company = ?, location = ?, description = ?, language_status = ?, language_summary = ?,
      language_signals = ?, fit_score_a = ?, fit_score_b = ?, best_cv_slot = ?, workplace_type = ?, matched_keywords = ?, missing_keywords = ?,
      identity_fingerprint = ?, cluster_key = ?, visibility_status = ?, posted_at = CASE WHEN ? = '' THEN posted_at ELSE ? END,
      last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(canonicalUrl, source.key, source.name, sourceJobId, source.country, input.title, input.company, input.location,
        input.description, input.languageStatus, input.languageSummary, JSON.stringify(input.languageSignals), input.fitScoreA,
        input.fitScoreB, input.bestCvSlot, workplaceType, JSON.stringify(input.matchedKeywords), JSON.stringify(input.missingKeywords),
        identityFingerprint, clusterKey, visibilityStatus, postedAt, postedAt, now, now, id, userId).run();
  } else {
    await db.prepare(`INSERT INTO jobs (id, user_id, source_url, canonical_url, source_key, source_name, source_job_id, country,
      title, company, location, description, language_status, language_summary, language_signals, fit_score_a, fit_score_b,
      best_cv_slot, workplace_type, matched_keywords, missing_keywords, identity_fingerprint, cluster_key, duplicate_of,
      is_saved, application_status,
      visibility_status, posted_at, first_seen_at, last_seen_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, userId, canonicalUrl, canonicalUrl, source.key, source.name, sourceJobId, source.country, input.title, input.company,
        input.location, input.description, input.languageStatus, input.languageSummary, JSON.stringify(input.languageSignals),
        input.fitScoreA, input.fitScoreB, input.bestCvSlot, workplaceType, JSON.stringify(input.matchedKeywords),
        JSON.stringify(input.missingKeywords), identityFingerprint, clusterKey, duplicateOf, 0, 'not_applied', visibilityStatus, postedAt, now, now,
        visibilityStatus === 'dismissed' ? 'ignored' : 'new', now, now).run();
  }
  const row = await db.prepare(`SELECT jobs.*, language_feedback.verdict AS feedback_verdict,
    language_feedback.corrected_status AS feedback_corrected_status,
    language_feedback.reason AS feedback_reason, language_feedback.updated_at AS feedback_updated_at
    FROM jobs LEFT JOIN language_feedback ON language_feedback.job_id = jobs.id
    WHERE jobs.id = ? AND jobs.user_id = ?`)
    .bind(id, userId).first<JobRow>();
  const job = jobFromRow(row!);
  return { job, wasKnown: Boolean(existing), wasDuplicate, wasDismissed: job.visibilityStatus === 'dismissed' };
}

interface ClusterableJob {
  id: string;
  title: string;
  company: string;
  location: string;
  posted_at: string;
  first_seen_at: string;
  source_key: string;
  is_saved: number;
  application_status: string;
  description: string;
}

/**
 * Group every job this account holds and mark the copies.
 *
 * Needed because cluster keys are normalized in TypeScript, so the migration that added the column
 * could not fill it, and because the rules changed underneath jobs that were already stored. It is
 * a full re-derivation rather than an incremental pass so that a correction to the normalizer
 * takes effect everywhere instead of only on jobs seen afterwards.
 *
 * Which copy stays on screen is not arbitrary. A job the person has already saved or applied to
 * wins outright — hiding that would lose their work. Otherwise the longest description wins,
 * because the whole point of collapsing duplicates is to keep the copy worth reading: aggregator
 * teasers stop displacing the full advertisement.
 */
export async function reclusterJobs(db: D1Database, userId: string) {
  const rows = await db.prepare(`SELECT id, title, company, location, posted_at, first_seen_at, source_key,
      is_saved, application_status, description FROM jobs WHERE user_id = ? ORDER BY first_seen_at, created_at`)
    .bind(userId).all<ClusterableJob>();
  if (!rows.results.length) return { clusters: 0, duplicates: 0 };

  const buckets = new Map<string, ClusterableJob[]>();
  const assignment = new Map<string, { clusterKey: string; duplicateOf: string }>();
  for (const row of rows.results) {
    const key = jobClusterKey(row);
    assignment.set(row.id, { clusterKey: key, duplicateOf: '' });
    if (!key) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }

  const rank = (job: ClusterableJob) =>
    (job.is_saved ? 2 : 0) + (job.application_status === 'applied' ? 2 : 0);

  let clusters = 0;
  let duplicates = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // Within a bucket the employer and role already agree; these groups apply the place and date
    // rules, so one employer advertising the same title in two cities still yields two groups.
    const groups: ClusterableJob[][] = [];
    for (const job of bucket) {
      const group = groups.find((candidate) => candidate.some((member) => isNearDuplicate(
        { location: job.location, postedAt: job.posted_at },
        { location: member.location, postedAt: member.posted_at },
      )));
      if (group) group.push(job);
      else groups.push([job]);
    }
    for (const group of groups) {
      if (group.length < 2) continue;
      const primary = [...group].sort((a, b) =>
        rank(b) - rank(a)
        || b.description.length - a.description.length
        || a.first_seen_at.localeCompare(b.first_seen_at))[0];
      clusters += 1;
      for (const job of group) {
        if (job.id === primary.id) continue;
        assignment.get(job.id)!.duplicateOf = primary.id;
        duplicates += 1;
      }
    }
  }

  const statements = [...assignment.entries()].map(([id, value]) =>
    db.prepare('UPDATE jobs SET cluster_key = ?, duplicate_of = ? WHERE id = ? AND user_id = ?')
      .bind(value.clusterKey, value.duplicateOf, id, userId));
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  return { clusters, duplicates };
}

export async function rescoreAllJobs(db: D1Database, userId: string, cvs: CvInput[]) {
  const jobs = await db.prepare('SELECT id, title, description FROM jobs WHERE user_id = ?').bind(userId)
    .all<{ id: string; title: string; description: string }>();
  if (!jobs.results.length) return 0;

  const updates = jobs.results.map((job) => {
    const language = analyzeLanguage(job.description, job.title);
    const fit = scoreFitAcrossCvs(job.description, job.title, cvs);
    return db.prepare(`UPDATE jobs SET language_status = ?, language_summary = ?, language_signals = ?,
      fit_score_a = ?, fit_score_b = ?, best_cv_slot = ?, matched_keywords = ?, missing_keywords = ?,
      updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(language.status, language.summary, JSON.stringify(language.signals), fit.fitScoreA, fit.fitScoreB,
        fit.bestCvSlot, JSON.stringify(fit.matchedKeywords), JSON.stringify(fit.missingKeywords),
        new Date().toISOString(), job.id, userId);
  });
  for (let start = 0; start < updates.length; start += 50) {
    await db.batch(updates.slice(start, start + 50));
  }
  return updates.length;
}

export type { CriteriaRow, CvRow, JobRow, SearchRoleRow, SearchRunRow, SearchRunSourceRow };
