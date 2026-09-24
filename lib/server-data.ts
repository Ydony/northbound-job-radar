import { analyzeLanguage, type LanguageStatus } from './analysis';
import { mirrorCatalogueForJob, mirrorCatalogueForJobs } from './catalogue';
import { indeedSql, isIndeedRecord } from './indeed/access';
import { isIndeedUrl, languageForIndeed } from './indeed/normalize';
import { canonicalJobUrl, isGloballyStableSourceJobId, isNearDuplicate, jobClusterKey, jobIdentityFingerprint,
  sourceInfoForUrl, sourceJobIdFromUrl } from './job-identity';
import { keywordFilterClause, matchesSearchCriteria, pageFilterClause, searchTextForJob } from './criteria';
import { encodeJobsCursor, type JobsCursor } from './paging';
import { decodeEntities } from './jobsch';
import { jobExcerpt } from './excerpt';
import { extractRequirements } from './requirements';
import { readableLocation } from './nuts';
import { detectWorkplaceType } from './workplace';
import type { JobRecord, SearchCriteria, SearchRun, SearchRunSource } from './types';

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
  workplace_type: JobRecord['workplaceType'];
  identity_fingerprint: string;
  cluster_key: string;
  duplicate_of: string;
  is_saved: number;
  application_status: JobRecord['applicationStatus'];
  visibility_status: JobRecord['visibilityStatus'];
  posted_at: string;
  expires_at: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

interface CriteriaRow {
  location: string;
  workplace: SearchCriteria['workplace'];
  seniority: SearchCriteria['seniority'];
  contract_type: SearchCriteria['contractType'];
  required_keywords: string;
  excluded_keywords: string;
  search_netherlands: number;
  search_switzerland: number;
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
  matched_count: number | null;
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

/**
 * Maps a stored row to what a client is allowed to see.
 *
 * The advertisement text stops here. It is read from the row, used to derive the three fields
 * that replace it, and never copied onto the returned object — see docs/SOURCE_POLICY.md §1 and
 * the note on JobRecord. `criteria` is optional only so callers that have no criteria to hand
 * (a freshly imported job, say) still work; they get `matchesCriteria: true`, which is what an
 * empty criteria set would have produced anyway.
 */
export function jobFromRow(row: JobRow, criteria?: SearchCriteria): JobRecord {
  const requirements = extractRequirements(row.description);
  const languageFeedback = row.feedback_verdict === 'correct' || row.feedback_verdict === 'incorrect'
    ? row.feedback_verdict
    : '';
  const correctedLanguageStatus = row.feedback_corrected_status === 'pass'
    || row.feedback_corrected_status === 'unknown'
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
    descriptionLength: row.description.trim().length,
    requirements: requirements,
    excerpt: jobExcerpt(row.description, requirements),
    matchesCriteria: criteria
      ? matchesSearchCriteria(
        { title: row.title, location: row.location, description: row.description }, criteria,
      )
      : true,
    languageStatus: row.language_status,
    languageSummary: row.language_summary,
    languageSignals: stringArray(row.language_signals),
    languageFeedback,
    correctedLanguageStatus,
    languageFeedbackReason: row.feedback_reason ?? '',
    languageFeedbackUpdatedAt: row.feedback_updated_at ?? '',
    workplaceType: row.workplace_type || 'unknown',
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
    expiresAt: row.expires_at ?? '',
    firstSeenAt: row.first_seen_at || row.created_at,
    lastSeenAt: row.last_seen_at || row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function criteriaFromRow(row: CriteriaRow | null, roleRows: SearchRoleRow[] = []): SearchCriteria {
  return {
    roleKeywords: roleRows.sort((a, b) => a.position - b.position).map((entry) => entry.role),
    location: row?.location ?? '',
    workplace: row?.workplace ?? 'any',
    seniority: row?.seniority ?? 'any',
    contractType: row?.contract_type ?? 'any',
    requiredKeywords: stringArray(row?.required_keywords ?? '[]'),
    excludedKeywords: stringArray(row?.excluded_keywords ?? '[]'),
    // A row written before migration 18 has no value here, and absence is not a request to
    // search less, so undefined reads as on.
    searchNetherlands: (row?.search_netherlands ?? 1) !== 0,
    searchSwitzerland: (row?.search_switzerland ?? 1) !== 0,
    updatedAt: row?.updated_at ?? '',
  };
}

export function searchRunsFromRows(runRows: SearchRunRow[], sourceRows: SearchRunSourceRow[]) {
  const sourcesByRun = new Map<string, SearchRunSource[]>();
  for (const row of sourceRows) {
    const sources = sourcesByRun.get(row.run_id) ?? [];
    const matched = (row as { matched_count?: unknown }).matched_count;
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
      // Rows predating migration 25 carry NULL; so do sources that never
      // completed. Callers must render those as unknown, never as zero.
      matchedCount: typeof matched === 'number' && Number.isFinite(matched) ? matched : null,
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
  postedAt?: string;
  /**
   * Publication end date when the source publishes one (Job-Room does, #97). Stored with
   * the same never-clear rule as postedAt: an empty value keeps what the row holds.
   */
  expiresAt?: string;
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
  // Never merge a private Indeed copy into an independently supplied public record.
  const sameAudience = `${isIndeedUrl(canonicalUrl) ? '' : 'NOT '}${indeedSql()}`;
  const sourceJobId = sourceJobIdFromUrl(canonicalUrl);
  const globallyStableSourceJobId = isGloballyStableSourceJobId(sourceJobId);
  const postedAt = input.postedAt?.trim() ?? '';
  const expiresAt = input.expiresAt?.trim() ?? '';
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
      WHERE user_id = ? AND identity_fingerprint = ? AND ${sameAudience} ORDER BY updated_at DESC LIMIT 1`)
      .bind(userId, identityFingerprint).first<ExistingJobIdentity>()
    : null;
  const existing = exact ?? fingerprintMatch;
  const clusterKey = jobClusterKey(input);
  // Only a genuinely new row needs a near-duplicate search: anything matched above is already the
  // same row being refreshed. The candidate list is bounded by the cluster index, and the range
  // comparison that the fingerprint hash cannot express happens here in TypeScript.
  const nearMatch = !existing && clusterKey
    ? (await db.prepare(`SELECT id, location, posted_at, duplicate_of, first_seen_at FROM jobs
        WHERE user_id = ? AND cluster_key = ? AND ${sameAudience} ORDER BY first_seen_at LIMIT 25`)
        .bind(userId, clusterKey).all<NearDuplicateCandidate>())
      .results.find((candidate) => isNearDuplicate(
        // The row being written has not been stored yet, so its first-seen is now.
        { location: input.location, postedAt, firstSeenAt: now },
        {
          location: candidate.location,
          postedAt: candidate.posted_at,
          firstSeenAt: candidate.first_seen_at,
        },
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
  // Folded title + location + description for the SQL keyword filter (lib/criteria.ts). Written
  // on every insert and text-changing update so the filter never reads stale text.
  const searchText = searchTextForJob(input);
  if (wasDuplicate && existing) {
    await db.prepare('UPDATE jobs SET last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(now, now, id, userId).run();
  } else if (existing) {
    await db.prepare(`UPDATE jobs SET canonical_url = ?, source_key = ?, source_name = ?, source_job_id = ?,
      country = ?, title = ?, company = ?, location = ?, description = ?, search_text = ?, language_status = ?, language_summary = ?,
      language_signals = ?, workplace_type = ?,
      identity_fingerprint = ?, cluster_key = ?, visibility_status = ?, posted_at = CASE WHEN ? = '' THEN posted_at ELSE ? END,
      expires_at = CASE WHEN ? = '' THEN expires_at ELSE ? END,
      last_seen_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(canonicalUrl, source.key, source.name, sourceJobId, source.country, input.title, input.company, input.location,
        input.description, searchText, input.languageStatus, input.languageSummary, JSON.stringify(input.languageSignals), workplaceType,
        identityFingerprint, clusterKey, visibilityStatus, postedAt, postedAt, expiresAt, expiresAt, now, now, id, userId).run();
  } else {
    await db.prepare(`INSERT INTO jobs (id, user_id, source_url, canonical_url, source_key, source_name, source_job_id, country,
      title, company, location, description, search_text, language_status, language_summary, language_signals,
      workplace_type, identity_fingerprint, cluster_key, duplicate_of,
      is_saved, application_status,
      visibility_status, posted_at, expires_at, first_seen_at, last_seen_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, userId, canonicalUrl, canonicalUrl, source.key, source.name, sourceJobId, source.country, input.title, input.company,
        input.location, input.description, searchText, input.languageStatus, input.languageSummary, JSON.stringify(input.languageSignals),
        workplaceType, identityFingerprint, clusterKey, duplicateOf, 0, 'not_applied', visibilityStatus, postedAt, expiresAt, now, now,
        visibilityStatus === 'dismissed' ? 'ignored' : 'new', now, now).run();
  }
  const row = await db.prepare(`SELECT jobs.*, language_feedback.verdict AS feedback_verdict,
    language_feedback.corrected_status AS feedback_corrected_status,
    language_feedback.reason AS feedback_reason, language_feedback.updated_at AS feedback_updated_at
    FROM jobs LEFT JOIN language_feedback ON language_feedback.job_id = jobs.id
    WHERE jobs.id = ? AND jobs.user_id = ?`)
    .bind(id, userId).first<JobRow>();
  const job = jobFromRow(row!);
  // INT-04 (#163): keep the shared catalogue and this account's private state in step
  // with the row just written. The feedback JOIN above deliberately omits user_id so
  // this long-standing read is unchanged; the mirror re-reads with its own scoping.
  await mirrorCatalogueForJob(db, userId, id, NORMALIZATION_VERSION);
  return { job, wasKnown: Boolean(existing), wasDuplicate, wasDismissed: job.visibilityStatus === 'dismissed' };
}

/**
 * Bump this whenever the ingest rules change — entity decoding, or anything that decides a language
 * verdict. Stored rows carry the revision they were written under and are rewritten on next read.
 *
 * 1: titles entity-decoded; language gate reads the job title and the phrase rules.
 * 2: a pass requires enough text to justify it; short ads become 'unknown' instead.
 * 3: NUTS region codes resolved to place names, so EURES rows stored before the resolver existed
 *    stop reading as "NL32B NL" and can be grouped by somewhere a person recognises.
 * 4: country re-derived, because resolving those codes removed the prefix the country was being
 *    read from and left every EURES job filed under 'unknown'.
 * 5: an advertisement can be ruled out as not-English on far less text than it takes to confirm
 *    English, so short previews written in German or French stop being filed as "not enough of
 *    the ad". 172 stored jobs were carrying that verdict and are rewritten as blocked.
 * 6: a truncated advertisement can never confirm English — EURES Netherlands ads arrive cut at
 *    ~2,000 characters ending in "..." (666/740 stored rows, measured 2026-09-18), usually
 *    before the requirements — so stored passes on such text are rewritten as unknown.
 * 7: a language mention can now be exempt rather than only required or optional (#74), so an
 *    explicit denial, a language offered as lessons, and a nationality/market use stop costing
 *    a review, while "bilingual in X" starts blocking. Stored rows were screened under the
 *    older rules and are re-screened rather than keeping a verdict those rules produced.
 */
// 8: Indeed descriptions retain unknown completeness on normalization/rescoring.
// Also re-evaluates version-7 rows using the current nationality precedence (#78).
// 9: language cues now bind within a clause rather than within a character distance (#79). A
// denial in the previous sentence no longer clears this one, a market or law use must really
// qualify its noun, a cue no longer carries across ", but" onto the next language, and optional
// wording trailing a qualifier is seen. Two false passes and two false blocks were corrected, so
// stored verdicts move in both directions and every row is re-screened.
export const NORMALIZATION_VERSION = 10;

interface StoredJobForNormalization {
  id: string;
  source_url: string;
  title: string;
  company: string;
  location: string;
  description: string;
}

/**
 * Bring already-stored jobs up to the current ingest rules.
 *
 * Without this, every rule improvement only ever applies to jobs imported afterwards, which is
 * exactly what happened here: 32 titles kept showing "Head of Finance &amp; Energy Data", and the
 * verdicts on screen were still those of a gate that had never been shown the job title. Neither is
 * something a person should have to trigger, or even know about.
 *
 * Language is recomputed without touching application or feedback state.
 */
/**
 * How many advertisements one request may normalize. A search can add several thousand at
 * once, and normalizing all of them inside the GET that follows took 22 seconds and lost
 * the connection. The rest are picked up by the next read; a row that has not caught up
 * yet shows the verdict it was stored with, which is the previous answer rather than a
 * wrong one.
 */
export const NORMALIZE_BATCH = 400;

export async function normalizeStoredJobs(db: D1Database, userId: string) {
  const rows = await db.prepare(`SELECT id, source_url, title, company, location, description FROM jobs
    WHERE user_id = ? AND normalized_version < ? LIMIT ?`)
    .bind(userId, NORMALIZATION_VERSION, NORMALIZE_BATCH).all<StoredJobForNormalization>();
  if (!rows.results.length) return 0;

  const now = new Date().toISOString();
  const statements = rows.results.map((row) => {
    const title = decodeEntities(row.title);
    const location = readableLocation(decodeEntities(row.location));
    const language = isIndeedUrl(row.source_url) ? languageForIndeed(row.description, title) : analyzeLanguage(row.description, title);
    // Re-derived from the resolved location, not carried over: the country stored at ingest is
    // wrong for any EURES row written between the NUTS resolver landing and this fix.
    const { country } = sourceInfoForUrl(row.source_url, location);
    return db.prepare(`UPDATE jobs SET title = ?, company = ?, location = ?, country = ?,
        language_status = ?, language_summary = ?, language_signals = ?,
        search_text = ?,
        normalized_version = ?, cluster_version = 0, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(title, decodeEntities(row.company), location, country,
        language.status, language.summary, JSON.stringify(language.signals),
        searchTextForJob({ title, location, description: row.description }),
        NORMALIZATION_VERSION, now, row.id, userId);
  });
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  // INT-05 serves advert content from the shared catalogue, so rows rewritten
  // here are mirrored there too — otherwise the catalogue keeps the stale
  // verdicts this pass just replaced.
  await mirrorCatalogueForJobs(db, userId, rows.results.map((row) => row.id), NORMALIZATION_VERSION);
  return rows.results.length;
}

/**
 * Fill `search_text` for rows written before migration 21, without touching anything else.
 *
 * Unlike normalizeStoredJobs this never rescreens language, never invalidates clusters and
 * never bumps versions: the folded text is derived from the same fields matchesSearchCriteria
 * already reads, so backfilled rows filter exactly as freshly written ones do. Rows whose
 * title, location and description are all empty keep their empty text — the SQL filter and
 * the TypeScript check agree on those too — and are excluded from the scan so the loop
 * always terminates.
 */
/** Batches of 100, but no more than this many per request - see NORMALIZE_BATCH. */
const SEARCH_TEXT_BATCHES = 5;

export async function ensureSearchText(db: D1Database, userId: string) {
  let filled = 0;
  for (let pass = 0; pass < SEARCH_TEXT_BATCHES; pass += 1) {
    const rows = await db.prepare(`SELECT id, title, location, description FROM jobs
      WHERE user_id = ? AND search_text = '' AND (title || location || description) != ''
      LIMIT 100`)
      .bind(userId).all<{ id: string; title: string; location: string; description: string }>();
    if (!rows.results.length) return filled;
    const statements = rows.results.map((row) => db.prepare(
      'UPDATE jobs SET search_text = ? WHERE id = ? AND user_id = ?')
      .bind(searchTextForJob(row), row.id, userId));
    await db.batch(statements);
    // The folded text is what the catalogue keyword and role filters read, so
    // backfilled rows are mirrored there too (see normalizeStoredJobs above).
    await mirrorCatalogueForJobs(db, userId, rows.results.map((row) => row.id), NORMALIZATION_VERSION);
    filled += rows.results.length;
  }
  return filled;
}

// v1: re-evaluate links made before the first-seen fallback for missing posting dates (#5).
// Bump whenever jobClusterKey, isNearDuplicate or primary selection changes. Normalization
// separately invalidates a row's cluster version because it may change its title or place.
export const CLUSTER_VERSION = 2;

/** Recheck the entire owner group when any member was written under older rules. */
export async function ensureCurrentJobClusters(db: D1Database, userId: string) {
  const stale = await db.prepare('SELECT id FROM jobs WHERE user_id = ? AND cluster_version < ? LIMIT 1')
    .bind(userId, CLUSTER_VERSION).first<{ id: string }>();
  return stale ? reclusterJobs(db, userId) : { clusters: 0, duplicates: 0 };
}

interface ClusterableJob {
  id: string;
  source_url: string;
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
  const rows = await db.prepare(`SELECT id, source_url, title, company, location, posted_at, first_seen_at, source_key,
      is_saved, application_status, description FROM jobs WHERE user_id = ? ORDER BY first_seen_at, created_at`)
    .bind(userId).all<ClusterableJob>();
  if (!rows.results.length) return { clusters: 0, duplicates: 0 };

  const buckets = new Map<string, ClusterableJob[]>();
  const assignment = new Map<string, { clusterKey: string; duplicateOf: string }>();
  for (const row of rows.results) {
    const key = jobClusterKey(row);
    assignment.set(row.id, { clusterKey: key, duplicateOf: '' });
    if (!key) continue;
    const audienceKey = `${isIndeedRecord(row.source_key, row.source_url) ? 'indeed' : 'other'}:${key}`;
    const bucket = buckets.get(audienceKey) ?? [];
    bucket.push(row);
    buckets.set(audienceKey, bucket);
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
        { location: job.location, postedAt: job.posted_at, firstSeenAt: job.first_seen_at },
        { location: member.location, postedAt: member.posted_at, firstSeenAt: member.first_seen_at },
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
    db.prepare('UPDATE jobs SET cluster_key = ?, duplicate_of = ?, cluster_version = ? WHERE id = ? AND user_id = ?')
      .bind(value.clusterKey, value.duplicateOf, CLUSTER_VERSION, id, userId));
  // Mark only rows in this snapshot, in the same atomic batch as their links. If a later
  // batch fails, its rows remain stale and the next read recomputes the whole owner group.
  // A concurrently inserted row likewise remains stale; it cannot be marked without a link.
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  return { clusters, duplicates };
}

export interface JobsPageQuery {
  /** Source keys this account must never see. Empty for an administrator. */
  hiddenSourceKeys: string[];
  /** When true, Indeed rows are excluded too (ordinary accounts never learn they exist). */
  hideIndeedRecords: boolean;
  criteria: SearchCriteria;
  cursor: JobsCursor | null;
  limit: number;
}

export interface JobsPage {
  rows: JobRow[];
  /** Cursor for the following page, or null when this page is the end. */
  nextCursor: string | null;
  /** Every row owned (and visible to this role), regardless of keywords or paging. */
  total: number;
  /** Rows the saved keywords keep, regardless of paging. Saved, applied and dismissed rows
   *  ride along on the page but are not counted here: this is the number the dashboard
   *  converges to as pages load. */
  matching: number;
}

/**
 * One page of this account's jobs with the keyword filter applied in SQL, before the limit.
 *
 * The page carries saved, applied and dismissed rows even when the current keywords exclude
 * them (see pageFilterClause); the matching total counts keyword matches only. Hidden sources
 * are excluded in SQL before both the filter and the limit, so they never spend either.
 * Ordered by updated_at then id, newest first, with the cursor continuing exactly there.
 */
export async function queryJobsPage(
  db: D1Database,
  userId: string,
  query: JobsPageQuery,
): Promise<JobsPage> {
  const hiddenClause = query.hiddenSourceKeys.length
    ? ` AND jobs.source_key NOT IN (${query.hiddenSourceKeys.map(() => '?').join(',')})`
    : '';
  // Indeed rows are hidden from ordinary accounts by audience, not by key alone: legacy rows
  // may carry a missing or wrong source key, so the URL patterns count too. Same predicate as
  // /api/state has always used, now shared by the page and both counts.
  const indeedClause = query.hideIndeedRecords ? ` AND NOT ${indeedSql('jobs')}` : '';
  const unprefixedIndeedClause = query.hideIndeedRecords ? ` AND NOT ${indeedSql()}` : '';
  const page = pageFilterClause(query.criteria);
  const matching = keywordFilterClause(query.criteria, 'search_text');
  const cursorClause = query.cursor
    ? ' AND (jobs.updated_at < ? OR (jobs.updated_at = ? AND jobs.id < ?))'
    : '';
  const cursorParams = query.cursor
    ? [query.cursor.updatedAt, query.cursor.updatedAt, query.cursor.id]
    : [];
  const unprefixedHidden = hiddenClause.replace(/jobs\./g, '');
  const audienceClause = `${hiddenClause}${indeedClause}`;
  const unprefixedAudienceClause = `${unprefixedHidden}${unprefixedIndeedClause}`;
  // One row past the page: whether it exists is what decides nextCursor. Ending exactly on a
  // full page must not send the client after an empty one.
  const probe = query.limit + 1;
  const [jobs, total, matchingTotal] = await Promise.all([
    db.prepare(`SELECT jobs.*, language_feedback.verdict AS feedback_verdict,
      language_feedback.corrected_status AS feedback_corrected_status,
      language_feedback.reason AS feedback_reason, language_feedback.updated_at AS feedback_updated_at
      FROM jobs LEFT JOIN language_feedback ON language_feedback.job_id = jobs.id
      WHERE jobs.user_id = ?${audienceClause}${page.clause}${cursorClause}
      ORDER BY jobs.updated_at DESC, jobs.id DESC LIMIT ?`)
      .bind(userId, ...query.hiddenSourceKeys, ...page.params, ...cursorParams, probe)
      .all<JobRow>(),
    db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE user_id = ?${unprefixedAudienceClause}`)
      .bind(userId, ...query.hiddenSourceKeys).first<{ total: number }>(),
    db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE user_id = ?${unprefixedAudienceClause}${matching.clause}`)
      .bind(userId, ...query.hiddenSourceKeys, ...matching.params).first<{ total: number }>(),
  ]);
  const hasMore = jobs.results.length > query.limit;
  const rows = hasMore ? jobs.results.slice(0, query.limit) : jobs.results;
  const lastRow = rows[rows.length - 1];
  return {
    rows,
    nextCursor: hasMore && lastRow ? encodeJobsCursor(lastRow.updated_at, lastRow.id) : null,
    total: total?.total ?? rows.length,
    matching: matchingTotal?.total ?? rows.length,
  };
}

/**
 * Account-scoped retained collection for the #124 "Total collected" totals.
 *
 * The overall total counts unique retained jobs: rows with no duplicate_of,
 * plus orphan copies whose primary is gone or outside this role's audience
 * (the same rule the page uses to show a copy rather than lose it). Saved,
 * applied and dismissed rows are included — they are work, not absence — and
 * deliberately deleted or reset rows are gone. Hidden sources and Indeed rows
 * are excluded in SQL with the same audience predicates the page uses, so an
 * ordinary account never learns admin-source counts from these numbers.
 *
 * Per-source totals attribute each counted job to exactly one shown source
 * (primaries under their own source, orphans under the copy's source) using
 * the same unique predicate, so the per-source numbers add up to the overall.
 * Copies folded into a visible primary count only there, never again — that
 * is the dedupe the card discloses. Repeated finds across runs never inflate
 * either number: a re-seen job updates last_seen, it does not add a row.
 * First-seen decides newness; posting dates do not.
 */
export async function queryCollectionTotals(
  db: D1Database,
  userId: string,
  hiddenSourceKeys: string[],
  hideIndeedRecords: boolean,
): Promise<{ total: number; bySource: { sourceKey: string; sourceName: string; country: string; total: number }[] }> {
  const hiddenClause = hiddenSourceKeys.length
    ? ` AND source_key NOT IN (${hiddenSourceKeys.map(() => '?').join(',')})`
    : '';
  const indeedClause = hideIndeedRecords ? ` AND NOT ${indeedSql()}` : '';
  const audienceClause = `${hiddenClause}${indeedClause}`;
  // Audience-filtered primaries for the orphan check below. A copy whose
  // primary is hidden from this role (or deleted) is shown, so it counts
  // toward the unique total rather than vanishing with its primary.
  const primaryIdsSubquery = `SELECT id FROM jobs WHERE user_id = ?${audienceClause}`;
  const uniquePredicate = `(duplicate_of = '' OR duplicate_of NOT IN (${primaryIdsSubquery}))`;
  const [totalRow, bySourceRows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM jobs
      WHERE user_id = ?${audienceClause} AND ${uniquePredicate}`)
      .bind(userId, ...hiddenSourceKeys, userId, ...hiddenSourceKeys).first<{ total: number }>(),
    // Per-source unique retained jobs, attributed to the row that is shown:
    // primaries under their own source, orphans under the copy's source. Each
    // unique job counts once overall and once for its shown source, so the
    // per-source numbers add up to the overall. Copies folded into a visible
    // primary are not counted twice — that is the dedupe the card discloses.
    db.prepare(`SELECT source_key AS sourceKey, source_name AS sourceName, country, COUNT(*) AS total
      FROM jobs WHERE user_id = ?${audienceClause} AND ${uniquePredicate}
      GROUP BY source_key, source_name, country ORDER BY source_name`)
      .bind(userId, ...hiddenSourceKeys, userId, ...hiddenSourceKeys)
      .all<{ sourceKey: string; sourceName: string; country: string; total: number }>(),
  ]);
  return {
    total: totalRow?.total ?? 0,
    bySource: bySourceRows.results.map((row) => ({
      sourceKey: row.sourceKey || '',
      sourceName: row.sourceName || row.sourceKey || '',
      country: row.country === 'switzerland' || row.country === 'netherlands' ? row.country : 'unknown',
      total: row.total ?? 0,
    })),
  };
}

export type { CriteriaRow, JobRow, SearchRoleRow, SearchRunRow, SearchRunSourceRow };
