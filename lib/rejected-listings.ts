import { canonicalJobUrl, isGloballyStableSourceJobId, sourceInfoForUrl, sourceJobIdFromUrl } from './job-identity';

/**
 * Why a page-fetching source's detail read was rejected (#93).
 *
 * Every reason here is a property of the listing, not of the attempt, which is what makes it
 * safe to remember: re-reading the same page next run would reach the same verdict while
 * spending one of the four per-run slots the cap allows. A transient fetch failure — the
 * request never completed — is deliberately not a reason: nothing is known about the listing,
 * so it stays retryable and is never stored.
 *
 * - `unparseable`: the page answered but holds no parseable posting.
 * - `unsafe-url`: the apply link uses an unsafe scheme.
 * - `wrong-country`: the listing's country is not the adapter's country.
 * - `too-short`: the full advertisement was fetched and is still under the length threshold.
 * - `role-mismatch`: the advertisement does not match the searched roles. This one is a
 *   verdict about (listing × roles) rather than the listing alone, so the roles it was
 *   judged against travel with the row and it only counts while the roles are unchanged.
 */
export type RejectionReason = 'unparseable' | 'unsafe-url' | 'wrong-country' | 'too-short' | 'role-mismatch';

export interface RejectedIdentity {
  source_key: string;
  source_job_id: string;
  canonical_url: string;
  reason: string;
  roles: string;
}

/** Stable key for the roles a run searched, so a role mismatch holds only while they do. */
export function rejectionRolesKey(roles: string[]) {
  return JSON.stringify([...roles].sort());
}

export function isRejectedUrl(url: string, rejected: RejectedIdentity[], rolesKey: string) {
  const canonicalUrl = canonicalJobUrl(url);
  const source = sourceInfoForUrl(canonicalUrl);
  const sourceJobId = sourceJobIdFromUrl(canonicalUrl);
  return rejected.some((entry) => {
    const matches = entry.canonical_url === canonicalUrl
      || (Boolean(sourceJobId) && entry.source_job_id === sourceJobId
        && (entry.source_key === source.key || isGloballyStableSourceJobId(sourceJobId)));
    if (!matches) return false;
    // A role mismatch stops applying the moment the person searches for something else;
    // every other reason is listing-intrinsic and holds regardless of roles.
    if (entry.reason === 'role-mismatch') return entry.roles === rolesKey;
    return true;
  });
}

export async function loadRejectedListings(db: D1Database, userId: string): Promise<RejectedIdentity[]> {
  const rows = await db.prepare(`SELECT source_key, source_job_id, canonical_url, reason, roles
    FROM rejected_listings WHERE user_id = ?`).bind(userId).all<RejectedIdentity>();
  return rows.results;
}

/**
 * Remembers a permanent rejection, scoped to its owner like every other user-data row.
 *
 * Upserted rather than inserted: a listing first rejected as a role mismatch under one set
 * of roles and re-rejected under another must carry the latest roles, or the new direction
 * would never reconsider it. The in-memory row is returned so the caller can treat the URL
 * as known for the rest of the run.
 */
export async function rememberRejection(
  db: D1Database,
  userId: string,
  url: string,
  reason: RejectionReason,
  rolesKey: string,
): Promise<RejectedIdentity> {
  const canonicalUrl = canonicalJobUrl(url);
  const source = sourceInfoForUrl(canonicalUrl);
  const sourceJobId = sourceJobIdFromUrl(canonicalUrl);
  const roles = reason === 'role-mismatch' ? rolesKey : '[]';
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO rejected_listings
      (id, user_id, source_key, source_job_id, canonical_url, reason, roles, rejected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, canonical_url) DO UPDATE SET
        source_key = excluded.source_key, source_job_id = excluded.source_job_id,
        reason = excluded.reason, roles = excluded.roles, rejected_at = excluded.rejected_at`)
    .bind(crypto.randomUUID(), userId, source.key, sourceJobId, canonicalUrl, reason, roles, now).run();
  return { source_key: source.key, source_job_id: sourceJobId, canonical_url: canonicalUrl, reason, roles };
}
