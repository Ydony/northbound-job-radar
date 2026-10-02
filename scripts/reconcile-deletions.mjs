#!/usr/bin/env node
/**
 * T40b (F13) — Re-apply deletion tombstones to a restored copy, before it serves traffic.
 *
 * A backup taken BEFORE an account deletion still holds that account. Restoring
 * it AFTER the deletion silently resurrects the account (users, search_roles and
 * auth_events rows reappear). Backup expiry alone only bounds that window
 * (30-day Litestream retention in deploy/litestream.yml), so the restore
 * procedure (docs/DEPLOY.md) runs this step between `litestream restore -o
 * <scratch>` and serving anything from the scratch copy:
 *
 *   1. Tombstones recorded at deletion time (lib/account-deletion.ts,
 *      `deleted_accounts`: SHA-256 hashes only, never the id or the address)
 *      are copied from the LIVE database into the scratch copy. The scratch
 *      copy predates some deletions, so its own tombstone set is older.
 *   2. Every tombstoned account still present in the scratch copy is deleted
 *      with the same statement list the original deletion used
 *      (`reconcileDeletedAccounts`), before the copy ever serves traffic.
 *   3. Expired tombstones are purged after reconciling (720h / 30 days, the
 *      same bound as the backups they protect), so a lingering backup never
 *      outlives its protection.
 *
 * Usage:
 *   node --import tsx scripts/reconcile-deletions.mjs --live <live.sqlite> --restored <scratch.sqlite>
 *
 * Prints JSON evidence on stdout; exits non-zero on any failure. The live file
 * is only read, never written. Operates on whatever paths it is given — in the
 * real drill those hold real account data, so nothing printed here (hashes only,
 * no addresses) goes into the repo, an issue, or a transcript.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function usage() {
  console.error('Usage: node --import tsx scripts/reconcile-deletions.mjs --live <live.sqlite> --restored <scratch.sqlite>');
}

const args = process.argv.slice(2);
const liveIndex = args.indexOf('--live');
const restoredIndex = args.indexOf('--restored');
const livePath = liveIndex >= 0 ? args[liveIndex + 1] : undefined;
const scratchPath = restoredIndex >= 0 ? args[restoredIndex + 1] : undefined;
if (!livePath || !scratchPath || livePath === scratchPath || !existsSync(livePath) || !existsSync(scratchPath)) {
  usage();
  process.exit(2);
}

/** Quote a file path for ATTACH: single quotes double inside a string literal. */
function quoted(path) {
  return `'${path.replaceAll("'", "''")}'`;
}

// The live file may hold recent writes in its WAL; checkpoint first so the
// ATTACH below sees the tombstones the deletion just wrote. Then copy the live
// tombstone set into the scratch copy, which predates some deletions.
{
  const checkpoint = new DatabaseSync(livePath);
  try {
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
}

const mover = new DatabaseSync(scratchPath);
let liveTombstones = 0;
try {
  mover.exec('PRAGMA foreign_keys = ON');
  mover.exec(`ATTACH ${quoted(livePath)} AS live`);
  try {
    const liveHasTable = mover.prepare("SELECT COUNT(*) AS total FROM live.sqlite_master WHERE type = 'table' AND name = 'deleted_accounts'").get().total;
    if (liveHasTable === 0) {
      console.error('Refusing to reconcile: the live database has no deleted_accounts table — it predates the T40b control.');
      process.exit(1);
    }
    liveTombstones = mover.prepare('SELECT COUNT(*) AS total FROM live.deleted_accounts').get().total;
    mover.exec(`CREATE TABLE IF NOT EXISTS deleted_accounts (
      user_id_hash TEXT PRIMARY KEY NOT NULL,
      email_hash TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`);
    mover.exec('INSERT OR IGNORE INTO deleted_accounts SELECT * FROM live.deleted_accounts');
  } finally {
    mover.exec('DETACH live');
  }
} finally {
  mover.close();
}

// Bring the scratch copy to the current schema with the app's own migration
// runner (a pre-control backup may predate the tombstone table or the
// auth_events actor column reconciliation deletes through), then reconcile.
process.env.SQLITE_PATH = scratchPath;
const { bindings, ensureSchema } = await import('../db/runtime.ts');
const { reconcileDeletedAccounts } = await import('../lib/account-deletion.ts');
await ensureSchema();
const { db } = bindings();
const reconciliation = await reconcileDeletedAccounts(db);
const scratchTombstones = await db.prepare('SELECT COUNT(*) AS total FROM deleted_accounts').first('total');

const evidence = {
  liveTombstones,
  scratchTombstones,
  reconciliation,
  ok: true,
};
console.log(JSON.stringify(evidence, null, 2));

const { closeSqliteDatabase } = await import('../db/sqlite-adapter.ts');
closeSqliteDatabase();

try {
  const check = new DatabaseSync(scratchPath);
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') {
      console.error(`Reconciled copy failed integrity_check: ${integrity}`);
      process.exit(1);
    }
  } finally {
    check.close();
  }
} catch (error) {
  console.error(`Reconciled copy failed integrity_check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log('Reconciliation PASS: tombstoned deletions re-applied before the restored copy serves traffic.');
