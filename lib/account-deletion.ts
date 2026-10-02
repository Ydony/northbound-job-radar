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
 * - `deleted_accounts` holds deletion tombstones (hashes only, no `user_id`
 *   column by design). Reconciliation reads it; deletion never removes it.
 */

/**
 * Deletion tombstones (T40b, F13). A backup taken BEFORE an account deletion and
 * restored AFTER it silently resurrects the deleted account — users,
 * search_roles and auth_events rows reappear — and backup expiry alone only
 * bounds that window (30-day Litestream retention). So every account deletion
 * records a tombstone in the same batch, and the restore procedure re-applies
 * tombstoned deletions to the restored copy before it serves traffic
 * (`scripts/reconcile-deletions.mjs`, `docs/DEPLOY.md`).
 *
 * A tombstone holds one-way SHA-256 hashes only — never the id or the address —
 * plus the deletion and expiry timestamps. Reconciliation hashes each candidate
 * id/address in the restored copy and deletes the matches, so the plaintext is
 * never needed after deletion. The `deleted-account:v1:` prefix keeps these
 * hashes from matching any other hash of the same value stored elsewhere.
 */
export const DELETION_TOMBSTONE_RETENTION_HOURS = 720;

const TOMBSTONE_HASH_PREFIX = 'deleted-account:v1:';

export async function hashDeletionIdentity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${TOMBSTONE_HASH_PREFIX}${value}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function deletionTombstoneExpiry(deletedAt: string): string {
  return new Date(new Date(deletedAt).getTime() + DELETION_TOMBSTONE_RETENTION_HOURS * 3_600_000).toISOString();
}

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
    // Outstanding single-use verification links die with the workspace: the emailed link would
    // otherwise outlive the reset that was meant to start over. The account's verified state
    // itself is untouched, and a fresh link is one resend away. Unlike password_resets, which
    // reset deliberately keeps as recovery state, a verification token is provisioning flow
    // state with no meaning after everything it could confirm is gone.
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').bind(userId),
    // INT-04 (#163): this account's private catalogue records. The shared catalogue rows
    // themselves are ownerless and survive here; lib/catalogue.ts removes them only once
    // no account holds them, which the routes trigger after this batch.
    db.prepare('DELETE FROM user_vacancy_state WHERE user_id = ?').bind(userId),
  ];
}

/**
 * The account's own rows plus its owned workspace, without the tombstone insert.
 * Reconciliation reuses this so a re-applied deletion deletes exactly what the
 * original deletion deleted — and never refreshes the tombstone's timestamps.
 */
function fullAccountDeletionStatements(db: D1Database, userId: string, email: string): D1PreparedStatement[] {
  return [
    ...ownedDataDeletionStatements(db, userId),
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM auth_events WHERE email = ?').bind(email),
    // Administrator attribution is personal data too: rows this account caused
    // as an actor are removed with the account. The `delete-account` row the
    // administrator writes afterwards is a new row, not a survivor of this batch.
    db.prepare('DELETE FROM auth_events WHERE actor = ?').bind(email),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ];
}

/**
 * Full account removal: the owned workspace plus the account's own rows, plus a
 * deletion tombstone in the same batch. Sign-in history is matched on the
 * current account email; rows logged under a superseded address from before an
 * email change age out with the 30-day `auth_events` purge in `ensureSchema()`
 * rather than here, because the old address is no longer reachable from the
 * account row.
 *
 * Async because the tombstone hashes go through `crypto.subtle`, the same
 * Workers-compatible hashing the email-token code uses — never a plaintext id
 * or address in the tombstone row.
 */
export async function accountDeletionStatements(
  db: D1Database,
  userId: string,
  email: string,
): Promise<D1PreparedStatement[]> {
  const deletedAt = new Date().toISOString();
  const [userIdHash, emailHash] = await Promise.all([hashDeletionIdentity(userId), hashDeletionIdentity(email)]);
  return [
    ...fullAccountDeletionStatements(db, userId, email),
    db.prepare('INSERT OR IGNORE INTO deleted_accounts (user_id_hash, email_hash, deleted_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(userIdHash, emailHash, deletedAt, deletionTombstoneExpiry(deletedAt)),
  ];
}

/** Tombstones whose retention has passed. `ensureSchema()` runs this on every boot. */
export function purgeExpiredDeletionTombstones(db: D1Database): D1PreparedStatement {
  return db.prepare("DELETE FROM deleted_accounts WHERE expires_at < datetime('now')");
}

export interface DeletionTombstoneRow {
  user_id_hash: string;
  email_hash: string;
  deleted_at: string;
  expires_at: string;
}

async function readDeletionTombstones(db: D1Database): Promise<DeletionTombstoneRow[]> {
  const rows = await db.prepare('SELECT user_id_hash, email_hash, deleted_at, expires_at FROM deleted_accounts')
    .all<DeletionTombstoneRow>();
  return rows.results;
}

/**
 * Copy tombstones from the live database into a restored copy. The restored
 * copy is a backup taken before some deletions, so its tombstone set is older;
 * copying first is what lets reconciliation below see deletions the backup
 * predates. Runs before the restored copy serves traffic, never after.
 */
export async function copyDeletionTombstones(fromDb: D1Database, toDb: D1Database): Promise<number> {
  const rows = await readDeletionTombstones(fromDb);
  if (!rows.length) return 0;
  await toDb.batch(rows.map((row) => toDb.prepare('INSERT OR IGNORE INTO deleted_accounts (user_id_hash, email_hash, deleted_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(row.user_id_hash, row.email_hash, row.deleted_at, row.expires_at)));
  return rows.length;
}

/** Tables that carry a `user_id` owner column and are deleted with the account. */
const OWNED_TABLES_FOR_RECONCILIATION = [
  'language_feedback',
  'jobs',
  'search_settings',
  'search_roles',
  'indeed_settings',
  'indeed_coverage',
  'dismissed_jobs',
  'rejected_listings',
  'search_runs',
  'email_verifications',
  'user_vacancy_state',
  'password_resets',
] as const;

export interface DeletionReconciliation {
  tombstones: number;
  usersReconciled: number;
  authEventsReconciled: number;
  tombstonesPurged: number;
}

/**
 * Re-apply tombstoned deletions to a restored copy, before it serves traffic.
 * For every stored user-id hash, every owner id found anywhere in the restored
 * copy is hashed and compared; matches are deleted with the same statement list
 * the original deletion used (minus the tombstone insert, so timestamps never
 * refresh). Sign-in history is keyed by address rather than id, so its rows are
 * additionally swept by address hash — which also catches resurrected rows
 * whose account row is somehow already gone. Expired tombstones are purged
 * after reconciling, so a lingering backup can never outlive its protection.
 */
export async function reconcileDeletedAccounts(db: D1Database): Promise<DeletionReconciliation> {
  // A scratch copy restored from a pre-control backup has no tombstone table
  // yet; create it here so the copy step lands somewhere and this stays a no-op.
  await db.prepare(`CREATE TABLE IF NOT EXISTS deleted_accounts (
    user_id_hash TEXT PRIMARY KEY NOT NULL,
    email_hash TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`).run();
  const tombstones = await readDeletionTombstones(db);
  const userIdHashes = new Set(tombstones.map((row) => row.user_id_hash));
  const emailHashes = new Set(tombstones.map((row) => row.email_hash).filter((hash) => hash !== ''));

  let usersReconciled = 0;
  let authEventsReconciled = 0;
  if (userIdHashes.size > 0 || emailHashes.size > 0) {
    const candidates = new Set<string>();
    const emailsById = new Map<string, string>();
    const userRows = await db.prepare('SELECT id, email FROM users').all<{ id: string; email: string }>();
    for (const row of userRows.results) {
      candidates.add(row.id);
      emailsById.set(row.id, row.email);
    }
    for (const table of OWNED_TABLES_FOR_RECONCILIATION) {
      const rows = await db.prepare(`SELECT DISTINCT user_id AS user_id FROM ${table}`).all<{ user_id: string }>();
      for (const row of rows.results) {
        if (row.user_id) candidates.add(row.user_id);
      }
    }
    for (const candidate of candidates) {
      if (!userIdHashes.has(await hashDeletionIdentity(candidate))) continue;
      const email = emailsById.get(candidate) ?? '';
      await db.batch(fullAccountDeletionStatements(db, candidate, email));
      usersReconciled += 1;
    }
    // Address-keyed sweep: rows the per-account deletes above cannot reach —
    // resurrected history whose account row is already gone, and rows logged
    // under the deleted address as actor.
    const tableInfo = await db.prepare('PRAGMA table_info(auth_events)').all<{ name: string }>();
    const hasActor = tableInfo.results.some((column) => column.name === 'actor');
    const eventRows = await db.prepare('SELECT id, email FROM auth_events').all<{ id: string; email: string }>();
    const doomed: string[] = [];
    for (const row of eventRows.results) {
      if (emailHashes.has(await hashDeletionIdentity(row.email))) doomed.push(row.id);
    }
    if (hasActor) {
      const actorRows = await db.prepare("SELECT id, actor FROM auth_events WHERE actor != ''")
        .all<{ id: string; actor: string }>();
      for (const row of actorRows.results) {
        if (emailHashes.has(await hashDeletionIdentity(row.actor)) && !doomed.includes(row.id)) doomed.push(row.id);
      }
    }
    for (let index = 0; index < doomed.length; index += 100) {
      const chunk = doomed.slice(index, index + 100);
      await db.batch(chunk.map((id) => db.prepare('DELETE FROM auth_events WHERE id = ?').bind(id)));
      authEventsReconciled += chunk.length;
    }
  }

  const purged = await purgeExpiredDeletionTombstones(db).run();
  return {
    tombstones: tombstones.length,
    usersReconciled,
    authEventsReconciled,
    tombstonesPurged: purged.meta.changes,
  };
}
