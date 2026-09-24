/**
 * Account deletion owns one list, not three.
 *
 * `DELETE /api/account` (self-deletion), `DELETE /api/admin` (administrator deleting
 * someone else) and `DELETE /api/workspace` (workspace reset) used to carry the same
 * literal `DELETE FROM <table> WHERE user_id = ?` list by hand. A migration adding a
 * user-scoped table had to be remembered in every copy, or that table's rows survived
 * deletion silently with a 200 and a cleared cookie — `indeed_settings` (#113) almost
 * demonstrated exactly that. `tests/account-deletion.test.ts` derives the expected list
 * from `db/runtime.ts` plus `db/migrations.ts`, so a new user-scoped table fails the
 * suite until it is added here; every route above shares this file, so one edit covers
 * all three paths.
 *
 * Deliberately NOT deleted here, with reasons:
 * - `daily_visits` / `visit_markers` hold aggregate counters only, no per-user data.
 * - `rate_limits` buckets (`auth:ip:<ip>`, `auth:email:<email>`) are 15-minute
 *   abuse-prevention counters swept on window rollover, not account data.
 * - `indeed_control` is installation-wide operational state, not user data.
 * - `auth_events` is keyed by email rather than `user_id` (see below).
 */

/**
 * Every row this account owns. Workspace reset stops here: it empties the workspace
 * while the account — its password, sessions and sign-in history — survives.
 */
export function ownedDataDeletionStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM language_feedback WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM jobs WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM search_settings WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM search_roles WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM indeed_settings WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM indeed_coverage WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM dismissed_jobs WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM rejected_listings WHERE user_id = ?').bind(userId),
    // `search_run_sources` carries no `user_id` of its own; its rows belong to runs.
    db.prepare('DELETE FROM search_run_sources WHERE run_id IN (SELECT id FROM search_runs WHERE user_id = ?)').bind(userId),
    db.prepare('DELETE FROM search_runs WHERE user_id = ?').bind(userId),
  ];
}

/**
 * Full account removal: the owned workspace plus the account's own rows. Sign-in
 * history is matched on the current account email; rows logged under a superseded
 * address from before an email change age out with the 30-day `auth_events` purge
 * in `ensureSchema()` rather than here, because the old address is no longer
 * reachable from the account row.
 */
export function accountDeletionStatements(
  db: D1Database,
  userId: string,
  email: string,
): D1PreparedStatement[] {
  return [
    ...ownedDataDeletionStatements(db, userId),
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM auth_events WHERE email = ?').bind(email),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ];
}
