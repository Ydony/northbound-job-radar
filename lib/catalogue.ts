/**
 * INT-04 (#163): the shared public catalogue (`vacancies`, `vacancy_sources`) split
 * from per-user private records (`user_vacancy_state`).
 *
 * - `vacancies` holds one row per distinct advert across ALL accounts. It deliberately
 *   has no `user_id`: it stores the employer's public text plus provenance, not
 *   personal data. Two accounts importing the same advert share one catalogue row.
 * - `vacancy_sources` records which source copies built each catalogue row.
 * - `user_vacancy_state` holds each account's private records 1:1 with its `jobs`
 *   rows (saved/applied/dismissed, language corrections). Every query here is scoped
 *   by `user_id`; the catalogue tables are the only ones without an owner, and the
 *   only cross-account statement on them deletes rows nobody holds anymore.
 *
 * The `jobs` table is still the served read model until INT-05 rewires queries, so
 * every write path mirrors into the catalogue: `upsertJob` and the job PATCH route
 * call `mirrorCatalogueForJob`, every delete path calls `removeUserVacancyState`.
 * Rows imported before migration 29 were backfilled by its SQL; rows touched after
 * it are mirrored here. Maintenance passes that rewrite advert content without going
 * through `upsertJob` (normalization, Job-Room/requirements backfills) leave the
 * catalogue copy stale until the next import touch — INT-05/INT-06 take over content
 * freshness; this module guarantees identity, provenance and state are never lost.
 */

export interface CatalogueJobMirrorRow {
  id: string;
  canonical_url: string;
  source_key: string;
  source_name: string;
  source_job_id: string;
  country: string;
  title: string;
  company: string;
  location: string;
  description: string;
  search_text: string;
  language_status: string;
  language_summary: string;
  language_signals: string;
  workplace_type: string;
  posted_at: string;
  expires_at: string;
  identity_fingerprint: string;
  is_saved: number;
  application_status: string;
  visibility_status: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  feedback_corrected_status: string | null;
  feedback_reason: string | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * TypeScript twin of the migration-29 grouping key. The SQL in db/migrations.ts
 * (`catalogueGroupKeySql`) must produce the same grouping — change both together.
 */
export function catalogueGroupKey(input: {
  canonical_url?: unknown;
  identity_fingerprint?: unknown;
  source_key?: unknown;
  source_job_id?: unknown;
  id?: unknown;
}): string {
  const canonicalUrl = text(input.canonical_url);
  if (canonicalUrl !== '') return `url:${canonicalUrl}`;
  const fingerprint = text(input.identity_fingerprint);
  if (fingerprint !== '') return `fp:${fingerprint}`;
  const sourceKey = text(input.source_key);
  const sourceJobId = text(input.source_job_id);
  if (sourceKey !== '' && sourceJobId !== '') return `sid:${sourceKey}|${sourceJobId}`;
  return `row:${text(input.id)}`;
}

/**
 * Internal change-detection hash for catalogue content: FNV-1a over the description
 * plus its trimmed length, so equal hashes on different lengths are still separable.
 * Not cryptographic — it only tells the collector whether the text moved.
 */
export function contentHashForDescription(description: string): string {
  let hash = 2166136261;
  for (let index = 0; index < description.length; index += 1) {
    hash ^= description.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${description.trim().length}`;
}

/** The catalogue tables exist only from migration 29 on. Unit fixtures with partial
 * schemas predate them; mirroring there is a no-op so those fixtures keep testing
 * what they were written for. Application databases always run all migrations. */
async function catalogueTablesPresent(db: D1Database): Promise<boolean> {
  const rows = await db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('vacancies', 'vacancy_sources', 'user_vacancy_state')`)
    .all<{ name: string }>();
  return rows.results.length === 3;
}

async function findVacancyId(
  db: D1Database,
  row: CatalogueJobMirrorRow,
): Promise<string> {
  if (row.canonical_url !== '') {
    const match = await db.prepare('SELECT id FROM vacancies WHERE canonical_url = ? LIMIT 1')
      .bind(row.canonical_url).first<{ id: string }>();
    if (match) return match.id;
  }
  if (row.identity_fingerprint !== '') {
    const match = await db.prepare('SELECT id FROM vacancies WHERE identity_fingerprint = ? LIMIT 1')
      .bind(row.identity_fingerprint).first<{ id: string }>();
    if (match) return match.id;
  }
  if (row.source_key !== '' && row.source_job_id !== '') {
    const match = await db.prepare('SELECT id FROM vacancies WHERE source_key = ? AND source_job_id = ? LIMIT 1')
      .bind(row.source_key, row.source_job_id).first<{ id: string }>();
    if (match) return match.id;
  }
  return '';
}

/**
 * Mirror one account's `jobs` row (plus its language correction) into the shared
 * catalogue and that account's private state. Returns the catalogue row id, or ''
 * when the row does not exist or the catalogue tables are absent.
 *
 * The vacancy id for a new advert is the creating job row's id: job ids are globally
 * unique, so no separate id scheme is needed and the link back is obvious.
 */
export async function mirrorCatalogueForJob(
  db: D1Database,
  userId: string,
  jobId: string,
  detectorVersion: number,
): Promise<string> {
  if (!await catalogueTablesPresent(db)) return '';
  const row = await db.prepare(`SELECT jobs.*, language_feedback.corrected_status AS feedback_corrected_status,
      language_feedback.reason AS feedback_reason
    FROM jobs LEFT JOIN language_feedback
      ON language_feedback.job_id = jobs.id AND language_feedback.user_id = jobs.user_id
    WHERE jobs.id = ? AND jobs.user_id = ?`)
    .bind(jobId, userId).first<CatalogueJobMirrorRow>();
  if (!row) return '';
  const now = new Date().toISOString();
  const existing = await findVacancyId(db, row);
  const vacancyId = existing || row.id;
  const contentHash = contentHashForDescription(row.description);
  if (!existing) {
    await db.prepare(`INSERT INTO vacancies (id, canonical_url, identity_fingerprint, source_key, source_name,
        source_job_id, country, title, company, location, description, search_text, language_status,
        language_summary, language_signals, workplace_type, posted_at, expires_at, content_hash,
        first_seen_at, last_seen_at, detector_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(vacancyId, row.canonical_url, row.identity_fingerprint, row.source_key, row.source_name,
        row.source_job_id, row.country, row.title, row.company, row.location, row.description,
        row.search_text, row.language_status, row.language_summary, row.language_signals,
        row.workplace_type, row.posted_at, row.expires_at, contentHash,
        row.first_seen_at || now, row.last_seen_at || now, detectorVersion, row.created_at || now, now)
      .run();
  } else {
    // Last write wins for advert content; the seen window only ever widens. ISO
    // datestamps compare lexicographically, so MIN/MAX reduce to string order.
    await db.prepare(`UPDATE vacancies SET source_key = ?, source_name = ?, source_job_id = ?,
        country = ?, title = ?, company = ?, location = ?, description = ?, search_text = ?,
        language_status = ?, language_summary = ?, language_signals = ?, workplace_type = ?,
        posted_at = ?, expires_at = ?, content_hash = ?, detector_version = ?,
        first_seen_at = CASE WHEN first_seen_at = '' OR ? < first_seen_at THEN ? ELSE first_seen_at END,
        last_seen_at = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END,
        updated_at = ? WHERE id = ?`)
      .bind(row.source_key, row.source_name, row.source_job_id,
        row.country, row.title, row.company, row.location, row.description, row.search_text,
        row.language_status, row.language_summary, row.language_signals, row.workplace_type,
        row.posted_at, row.expires_at, contentHash, detectorVersion,
        row.first_seen_at, row.first_seen_at, row.last_seen_at, row.last_seen_at, now, vacancyId)
      .run();
  }
  await db.prepare(`INSERT INTO vacancy_sources (vacancy_id, source_key, source_name, source_job_id,
      canonical_url, country, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vacancy_id, source_key, source_job_id, canonical_url) DO UPDATE SET
      source_name = excluded.source_name, country = excluded.country,
      first_seen_at = CASE WHEN vacancy_sources.first_seen_at = ''
        OR excluded.first_seen_at < vacancy_sources.first_seen_at
        THEN excluded.first_seen_at ELSE vacancy_sources.first_seen_at END,
      last_seen_at = CASE WHEN excluded.last_seen_at > vacancy_sources.last_seen_at
        THEN excluded.last_seen_at ELSE vacancy_sources.last_seen_at END`)
    .bind(vacancyId, row.source_key, row.source_name, row.source_job_id,
      row.canonical_url, row.country, row.first_seen_at || now, row.last_seen_at || now)
    .run();
  await db.prepare(`INSERT INTO user_vacancy_state (user_id, vacancy_id, job_id, is_saved, application_status,
      visibility_status, corrected_status, corrected_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, job_id) DO UPDATE SET vacancy_id = excluded.vacancy_id,
      is_saved = excluded.is_saved, application_status = excluded.application_status,
      visibility_status = excluded.visibility_status, corrected_status = excluded.corrected_status,
      corrected_reason = excluded.corrected_reason, updated_at = excluded.updated_at`)
    .bind(userId, vacancyId, row.id, row.is_saved, row.application_status, row.visibility_status,
      text(row.feedback_corrected_status), text(row.feedback_reason), row.created_at || now, now)
    .run();
  return vacancyId;
}

/**
 * Forget one account's private catalogue state after its `jobs` rows are deleted.
 * Pass explicit job ids for single/bulk deletes, or nothing to forget the whole
 * account (workspace reset, account deletion). An explicitly empty list is a no-op.
 * A catalogue row survives while ANY account still holds it; only rows nobody holds are removed, so one account's
 * delete can never take another account's adverts with it. `jobs` rows themselves
 * are deleted by the callers, as before — this only handles the catalogue side.
 */
export async function removeUserVacancyState(
  db: D1Database,
  userId: string,
  jobIds?: string[],
): Promise<void> {
  if (!await catalogueTablesPresent(db)) return;
  if (jobIds !== undefined) {
    if (jobIds.length === 0) return;
    // Keep state whose job row still exists: a guarded delete (e.g. a non-admin
    // Indeed row the audience filter spared) must not orphan live rows here.
    const placeholders = jobIds.map(() => '?').join(',');
    await db.prepare(`DELETE FROM user_vacancy_state WHERE user_id = ? AND job_id IN (${placeholders})
      AND job_id NOT IN (SELECT id FROM jobs WHERE user_id = ?)`)
      .bind(userId, ...jobIds, userId).run();
  } else {
    await db.prepare('DELETE FROM user_vacancy_state WHERE user_id = ?').bind(userId).run();
  }
  // Global by necessity — vacancies have no owner — and safe by construction: only
  // rows with zero holders go, and provenance without a catalogue row is meaningless.
  await db.prepare('DELETE FROM vacancies WHERE id NOT IN (SELECT vacancy_id FROM user_vacancy_state)').run();
  await db.prepare('DELETE FROM vacancy_sources WHERE vacancy_id NOT IN (SELECT id FROM vacancies)').run();
}
