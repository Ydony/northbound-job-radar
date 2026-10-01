/**
 * Copy one verified administrator's login identity between already-migrated
 * SQLite databases. This intentionally has no CLI: real use is an owner-only
 * checkpoint, while verify-admin-transfer.mjs exercises it on synthetic data.
 *
 * The only source columns transferred are the explicit INSERT columns below.
 * A new session epoch invalidates old cookies even if a secret were reused;
 * last_seen_at and all tokens, sessions, jobs and workspace rows stay behind.
 */
export function transferAdminIdentity(source, destination) {
  destination.exec('BEGIN IMMEDIATE');
  try {
    const versions = (db) => db.prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all().map((row) => row.version);
    if (JSON.stringify(versions(source)) !== JSON.stringify(versions(destination))) {
      throw new Error('Source and destination schema mismatch; transfer refused.');
    }
    const tables = destination.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`).all();
    for (const { name } of tables) {
      if (name === 'indeed_control') {
        // Migration 19 seeds one installation-wide row even in a fresh database.
        // It is not transferred, but only its untouched default may be present.
        const rows = destination.prepare('SELECT * FROM indeed_control LIMIT 2').all();
        const row = rows[0];
        if (rows.length === 1 && Object.keys(row).length === 6
          && row.id === 'indeed' && row.paused === 0 && row.cooldown_until === 0
          && row.lease_token === '' && row.lease_until === 0 && row.last_success === '') continue;
        throw new Error('Destination is nonempty; transfer refused.');
      }
      const quoted = `"${name.replaceAll('"', '""')}"`;
      if (destination.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get()) {
        throw new Error('Destination is nonempty; transfer refused.');
      }
    }

    const accounts = source.prepare(`SELECT id, email, password_hash, role, status,
      email_verified_at, created_at, session_epoch FROM users LIMIT 2`).all();
    if (accounts.length !== 1 || accounts[0].role !== 'admin' || accounts[0].status !== 'active') {
      throw new Error('Source must contain exactly one active admin account.');
    }
    const account = accounts[0];
    if (!account.email_verified_at) throw new Error('Source administrator must be verified.');
    if (!account.id || !account.email || !account.password_hash || !account.created_at
      || !Number.isSafeInteger(account.session_epoch) || account.session_epoch < 1
      || account.session_epoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Source administrator identity is incomplete.');
    }

    destination.prepare(`INSERT INTO users
      (id, email, password_hash, role, status, email_verified_at, created_at, last_seen_at, session_epoch)
      VALUES (?, ?, ?, 'admin', 'active', ?, ?, '', ?)`).run(
      account.id, account.email, account.password_hash, account.email_verified_at,
      account.created_at, account.session_epoch + 1);
    destination.exec('COMMIT');
    return { transferred: 1 };
  } catch (error) {
    destination.exec('ROLLBACK');
    throw error;
  }
}
