#!/usr/bin/env node
/**
 * T40 (F13) — Verify deletion, backup expiry and deletion reconciliation
 * after restore; scope any missing control.
 *
 * Synthetic fixtures only (throwaway temp files, `@example.test` addresses).
 * Run with: `node --import tsx scripts/verify-deletion-restore.mjs`
 * Prints JSON evidence on stdout.
 *
 * Part A — BACKUP EXPIRY (passes today):
 *   A1. `deploy/litestream.yml` sets a bounded replica retention (720h = 30d),
 *       so a deleted account ages out of off-box snapshots/WAL within 30 days.
 *   A2. `scripts/backup-local.mjs` prunes local recovery copies to KEEP newest
 *       and never prunes the backup just written (synthetic simulation below).
 *
 * Part B — DELETION RECONCILIATION AFTER RESTORE (fails today: the scoped gap):
 *   A backup taken BEFORE an account deletion, restored AFTER it, silently
 *   resurrects the deleted account and its owned rows. No `deleted_accounts`
 *   tombstone table exists, `ensureSchema()` performs no reconciliation, and
 *   the `docs/DEPLOY.md` restore procedure has no deletion-reconciliation step.
 *   F13 requires that "backup expiry and restore procedures prevent deleted
 *   accounts from silently reappearing" — backup expiry alone only bounds the
 *   window (30 days); inside that window a restore resurrects without warning.
 *
 *   Exit status: 0 when reconciliation holds (deleted rows stay deleted after
 *   restore), 1 when the gap is present. This script is the failing acceptance
 *   check for the follow-up control task; wire it into CI only once that
 *   control lands, otherwise it documents the gap.
 *
 * Scoped missing control (not implemented here — needs the T38 retention-table
 * owner decision first):
 *   - Record deletions durably: a `deleted_accounts` tombstone (user id and/or
 *     email hash + deleted_at) written in the same batch as
 *     `accountDeletionStatements`, so it exists in every backup taken after
 *     the deletion. Tombstones themselves expire on the retention schedule.
 *   - Reconcile on restore: a `reconcile-deletions` step in the restore
 *     procedure (and in this script) that re-applies tombstoned deletions to
 *     the restored copy before it ever serves traffic.
 *   - Procedural-only alternative (weaker): compare restored `users` against a
 *     separately kept deletion log. Scoped as weaker because the log itself
 *     needs backup/expiry handling, which re-creates the same problem.
 */
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = { partA: {}, partB: {} };
const failures = [];

// ---------- Part A: backup expiry ----------

// A1: Litestream replica retention is bounded (720h = 30 days).
const litestream = await readFile(join(projectRoot, 'deploy', 'litestream.yml'), 'utf8');
const retentionMatch = litestream.match(/retention:\s*(\d+)h/);
const retentionHours = retentionMatch ? Number(retentionMatch[1]) : 0;
evidence.partA.litestreamRetentionHours = retentionHours;
evidence.partA.litestreamRetentionBounded = retentionHours > 0;
if (!evidence.partA.litestreamRetentionBounded) {
  failures.push('deploy/litestream.yml sets no bounded replica retention — backups would keep deleted data indefinitely.');
}

// A2: local-backup pruning keeps KEEP newest and never prunes the backup just written.
const backupSource = await readFile(join(projectRoot, 'scripts', 'backup-local.mjs'), 'utf8');
const keepMatch = backupSource.match(/const KEEP = (\d+);/);
const KEEP = keepMatch ? Number(keepMatch[1]) : 0;
const guardsJustWritten = /if \(name === timestamp\) continue;/.test(backupSource);
evidence.partA.localBackupKeep = KEEP;
evidence.partA.localBackupGuardsJustWritten = guardsJustWritten;
if (!KEEP || !guardsJustWritten) {
  failures.push('scripts/backup-local.mjs pruning is missing or unguarded.');
}

// A2 synthetic simulation: 12 fake timestamped copies in a scratch dir,
// same newest-first slice(KEEP) algorithm as the script.
{
  const envRoot = mkdtempSync(join(tmpdir(), 't40-prune-'));
  try {
    const names = Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}T00-00-00-000Z`);
    for (const name of names) mkdirSync(join(envRoot, name));
    const justWritten = names.at(-1);
    const existing = readdirSync(envRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    const pruned = [];
    for (const name of existing.slice(KEEP)) {
      if (name === justWritten) continue;
      rmSync(join(envRoot, name), { recursive: true, force: true });
      pruned.push(name);
    }
    const remaining = readdirSync(envRoot).sort();
    evidence.partA.pruneSimulation = {
      startedWith: 12, kept: remaining.length, pruned: pruned.length,
      justWrittenSurvives: remaining.includes(justWritten),
    };
    if (remaining.length !== KEEP || !remaining.includes(justWritten)) {
      failures.push('pruning simulation did not keep exactly KEEP newest including the just-written backup.');
    }
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
}

// ---------- Part B: deletion reconciliation after restore ----------

// No reconciliation mechanism exists to find: tombstone table, schema-level
// purge of resurrected rows, or a restore-procedure step.
const runtimeSource = await readFile(join(projectRoot, 'db', 'runtime.ts'), 'utf8')
  + await readFile(join(projectRoot, 'db', 'migrations.ts'), 'utf8')
  + await readFile(join(projectRoot, 'lib', 'account-deletion.ts'), 'utf8');
const deployDoc = await readFile(join(projectRoot, 'docs', 'DEPLOY.md'), 'utf8');
const hasTombstoneTable = /deleted_accounts|deletion_tombstone|deleted_users/i.test(runtimeSource);
const restoreMentionsDeletion = /reconcil|tombstone|deleted account|reappear|resurrect/i.test(deployDoc);
evidence.partB.tombstoneTableExists = hasTombstoneTable;
evidence.partB.restoreProcedureReconcilesDeletions = restoreMentionsDeletion;

// Synthetic live database with two accounts.
const work = mkdtempSync(join(tmpdir(), 't40-restore-'));
const livePath = join(work, 'live.sqlite');
const preDeleteBackup = join(work, 'pre-delete-backup.sqlite');
const scratchPath = join(work, 'scratch.sqlite');
process.env.SQLITE_PATH = livePath;

const { bindings, ensureSchema } = await import('../db/runtime.ts');
const { accountDeletionStatements } = await import('../lib/account-deletion.ts');
await ensureSchema();
const { db } = bindings();

const now = '2026-09-29T00:00:00.000Z';
const victim = { id: 't40-victim', email: 't40-victim@example.test' };
const bystander = { id: 't40-bystander', email: 't40-bystander@example.test' };
for (const owner of [victim, bystander]) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, last_seen_at)
    VALUES (?, ?, ?, 'user', 'active', ?, ?)`)
    .bind(owner.id, owner.email, 'synthetic-hash', now, now).run();
  await db.prepare(`INSERT INTO search_roles (id, position, role, updated_at, user_id)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(`${owner.id}-role`, 0, 'engineer', now, owner.id).run();
  await db.prepare(`INSERT INTO auth_events (id, email, ip, kind, created_at)
    VALUES (?, ?, ?, 'signin_success', ?)`)
    .bind(`${owner.id}-event`, owner.email, '198.51.100.7', now).run();
}

// BACK UP before the deletion (checkpoint first: without it the copy may be truncated).
{
  const checkpoint = new DatabaseSync(livePath);
  try {
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
}
copyFileSync(livePath, preDeleteBackup);
for (const suffix of ['-wal', '-shm', '-journal']) {
  if (existsSync(livePath + suffix)) copyFileSync(livePath + suffix, preDeleteBackup + suffix);
}

// DELETE the victim on live; confirm live deletion holds.
await db.batch(accountDeletionStatements(db, victim.id, victim.email));
const liveVictimUsers = await db.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
  .bind(victim.id).first('total');
const liveVictimRoles = await db.prepare('SELECT COUNT(*) AS total FROM search_roles WHERE user_id = ?')
  .bind(victim.id).first('total');
const liveBystanderUsers = await db.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
  .bind(bystander.id).first('total');
evidence.partB.liveDeletionHolds = liveVictimUsers === 0 && liveVictimRoles === 0 && liveBystanderUsers === 1;
if (!evidence.partB.liveDeletionHolds) {
  failures.push('live account deletion left victim rows behind or lost the bystander — see lib/account-deletion.ts.');
}

// RESTORE the pre-deletion backup into scratch (stands in for `litestream restore -o <scratch>`).
copyFileSync(preDeleteBackup, scratchPath);
for (const suffix of ['-wal', '-shm', '-journal']) {
  if (existsSync(preDeleteBackup + suffix)) copyFileSync(preDeleteBackup + suffix, scratchPath + suffix);
}
const restored = new DatabaseSync(scratchPath);
restored.exec('PRAGMA foreign_keys = ON');
const restoredVictimUsers = restored.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
  .get(victim.id).total;
const restoredVictimRoles = restored.prepare('SELECT COUNT(*) AS total FROM search_roles WHERE user_id = ?')
  .get(victim.id).total;
const restoredVictimEvents = restored.prepare('SELECT COUNT(*) AS total FROM auth_events WHERE email = ?')
  .get(victim.email).total;
restored.close();
// Portability: the live handle is held by the cached SQLite adapter. On Linux
// removing the temp folder succeeds with it open; on Windows the same removal
// fails with EPERM while live.sqlite (or its WAL/SHM sidecars) is still held,
// as T28's script did. Close first, then remove.
try {
  const { closeSqliteDatabase } = await import('../db/sqlite-adapter.ts');
  closeSqliteDatabase();
} catch { /* already closed — temp cleanup must still run */ }
rmSync(work, { recursive: true, force: true });

evidence.partB.restoredVictimRows = {
  users: restoredVictimUsers, search_roles: restoredVictimRoles, auth_events: restoredVictimEvents,
};
evidence.partB.deletedAccountReappears = restoredVictimUsers > 0 || restoredVictimRoles > 0;
if (evidence.partB.deletedAccountReappears) {
  failures.push(
    'SCOPED GAP (T40): restoring a backup taken before an account deletion silently resurrects '
    + `the deleted account (users=${restoredVictimUsers}, search_roles=${restoredVictimRoles}, `
    + `auth_events=${restoredVictimEvents}). No tombstone table, no ensureSchema() reconciliation, `
    + 'and no restore-procedure step re-applies the deletion. Backup expiry (30d replicas, KEEP=10 '
    + 'local) only bounds how long a resurrecting backup exists — inside that window a restore '
    + 'brings deleted personal data back with no warning. See the header of this script for the '
    + 'scoped control (tombstones + reconcile-on-restore); it needs the T38 retention-table owner '
    + 'decision before implementation.',
  );
}

evidence.ok = failures.length === 0;
evidence.failures = failures;
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.ok) {
  console.error(`\nT40 verification FAILED with ${failures.length} finding(s) (see failures above).`);
  process.exit(1);
}
console.log('\nT40 verification PASS: backups expire on a bound and restores reconcile deletions.');
