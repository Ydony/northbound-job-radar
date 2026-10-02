#!/usr/bin/env node
/**
 * T40/T40b (F13) — Verify deletion, backup expiry and deletion reconciliation
 * after restore.
 *
 * Synthetic fixtures only (throwaway temp files, `@example.test` addresses).
 * Run with: `node --import tsx scripts/verify-deletion-restore.mjs`
 * Prints JSON evidence on stdout.
 *
 * Part A — BACKUP EXPIRY:
 *   A1. `deploy/litestream.yml` sets a bounded replica retention (720h = 30d),
 *       so a deleted account ages out of off-box snapshots/WAL within 30 days.
 *   A2. `scripts/backup-local.mjs` prunes local recovery copies to KEEP newest
 *       and never prunes the backup just written (synthetic simulation below).
 *
 * Part B — DELETION RECONCILIATION AFTER RESTORE (the T40b control):
 *   A backup taken BEFORE an account deletion, restored AFTER it, would
 *   silently resurrect the deleted account and its owned rows. The control:
 *   - `accountDeletionStatements` (lib/account-deletion.ts) records a
 *     `deleted_accounts` tombstone — SHA-256 hashes only, never the id or the
 *     address — in the same batch as the deletion, expiring after 720h (the
 *     same bound as the backups it protects).
 *   - `scripts/reconcile-deletions.mjs` copies the live tombstone set into the
 *     restored scratch copy and re-applies tombstoned deletions BEFORE the
 *     copy serves traffic (docs/DEPLOY.md restore procedure).
 *
 *   This part drives the real control on synthetic data: two accounts, a
 *   pre-deletion backup, a live deletion, a restore into scratch, then the
 *   documented reconcile step as a child process — and asserts the deleted
 *   account stays deleted while the bystander is untouched.
 *
 * Exit status: 0 when backup expiry and reconciliation both hold, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
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

// The control exists in code and in the restore procedure.
const runtimeSource = await readFile(join(projectRoot, 'db', 'runtime.ts'), 'utf8')
  + await readFile(join(projectRoot, 'db', 'migrations.ts'), 'utf8')
  + await readFile(join(projectRoot, 'lib', 'account-deletion.ts'), 'utf8');
const deployDoc = await readFile(join(projectRoot, 'docs', 'DEPLOY.md'), 'utf8');
const hasTombstoneTable = /deleted_accounts|deletion_tombstone|deleted_users/i.test(runtimeSource);
const restoreMentionsDeletion = /reconcil|tombstone|deleted account|reappear|resurrect/i.test(deployDoc);
evidence.partB.tombstoneTableExists = hasTombstoneTable;
evidence.partB.restoreProcedureReconcilesDeletions = restoreMentionsDeletion;
if (!hasTombstoneTable) {
  failures.push('no deletion-tombstone table exists — restoring a pre-deletion backup would resurrect the account.');
}
if (!restoreMentionsDeletion) {
  failures.push('docs/DEPLOY.md has no deletion-reconciliation restore step — a restored copy could serve tombstoned rows.');
}

// Synthetic live database with two accounts.
const work = mkdtempSync(join(tmpdir(), 't40b-restore-'));
const livePath = join(work, 'live.sqlite');
const preDeleteBackup = join(work, 'pre-delete-backup.sqlite');
const scratchPath = join(work, 'scratch.sqlite');
process.env.SQLITE_PATH = livePath;

const { bindings, ensureSchema } = await import('../db/runtime.ts');
const { accountDeletionStatements, hashDeletionIdentity } = await import('../lib/account-deletion.ts');
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

// DELETE the victim on live; confirm live deletion holds and a tombstone was recorded.
await db.batch(await accountDeletionStatements(db, victim.id, victim.email));
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

const expectedUserHash = await hashDeletionIdentity(victim.id);
const expectedEmailHash = await hashDeletionIdentity(victim.email);
const tombstone = await db.prepare('SELECT user_id_hash, email_hash, deleted_at, expires_at FROM deleted_accounts WHERE user_id_hash = ?')
  .bind(expectedUserHash).first();
evidence.partB.tombstoneRecorded = tombstone?.email_hash === expectedEmailHash
  && typeof tombstone?.deleted_at === 'string' && typeof tombstone?.expires_at === 'string';
if (!evidence.partB.tombstoneRecorded) {
  failures.push('account deletion recorded no tombstone — a later restore would resurrect the account.');
}
// The tombstone must hold hashes only: neither the id nor the address appears anywhere in it.
const tombstoneBlob = JSON.stringify(await db.prepare('SELECT * FROM deleted_accounts').all().then((r) => r.results));
evidence.partB.tombstoneHoldsNoPlaintext = !tombstoneBlob.includes(victim.id) && !tombstoneBlob.includes(victim.email);
if (!evidence.partB.tombstoneHoldsNoPlaintext) {
  failures.push('a tombstone holds plaintext identity — it must hold one-way hashes only.');
}

// RESTORE the pre-deletion backup into scratch (stands in for `litestream restore -o <scratch>`).
copyFileSync(preDeleteBackup, scratchPath);
for (const suffix of ['-wal', '-shm', '-journal']) {
  if (existsSync(preDeleteBackup + suffix)) copyFileSync(preDeleteBackup + suffix, scratchPath + suffix);
}

// RECONCILE with the documented restore step, in a child process so the check
// exercises the procedure the operator actually runs — not an in-process shortcut.
let reconcileExit = -1;
try {
  execFileSync(process.execPath, ['--import', 'tsx', join(projectRoot, 'scripts', 'reconcile-deletions.mjs'),
    '--live', livePath, '--restored', scratchPath], { cwd: projectRoot, stdio: 'pipe' });
  reconcileExit = 0;
} catch (error) {
  reconcileExit = error?.status ?? 1;
  failures.push(`the documented reconcile step failed on the restored copy: ${String(error?.stderr ?? error?.message ?? error).slice(0, 500)}`);
}
evidence.partB.reconcileScriptExit = reconcileExit;

const restored = new DatabaseSync(scratchPath);
restored.exec('PRAGMA foreign_keys = ON');
const restoredVictimUsers = restored.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
  .get(victim.id).total;
const restoredVictimRoles = restored.prepare('SELECT COUNT(*) AS total FROM search_roles WHERE user_id = ?')
  .get(victim.id).total;
const restoredVictimEvents = restored.prepare('SELECT COUNT(*) AS total FROM auth_events WHERE email = ?')
  .get(victim.email).total;
const restoredBystanderUsers = restored.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
  .get(bystander.id).total;
const restoredBystanderRoles = restored.prepare('SELECT COUNT(*) AS total FROM search_roles WHERE user_id = ?')
  .get(bystander.id).total;
const scratchTombstones = restored.prepare('SELECT COUNT(*) AS total FROM deleted_accounts').get().total;
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

evidence.partB.restoredVictimRowsAfterReconcile = {
  users: restoredVictimUsers, search_roles: restoredVictimRoles, auth_events: restoredVictimEvents,
};
evidence.partB.bystanderIntactAfterReconcile = restoredBystanderUsers === 1 && restoredBystanderRoles === 1;
evidence.partB.scratchHoldsTombstones = scratchTombstones >= 1;
evidence.partB.deletedAccountReappears = restoredVictimUsers > 0 || restoredVictimRoles > 0 || restoredVictimEvents > 0;
if (evidence.partB.deletedAccountReappears) {
  failures.push(
    'restoring a backup taken before an account deletion resurrected the deleted account '
    + `(users=${restoredVictimUsers}, search_roles=${restoredVictimRoles}, `
    + `auth_events=${restoredVictimEvents}) even after the documented reconcile step.`,
  );
}
if (!evidence.partB.bystanderIntactAfterReconcile) {
  failures.push('reconciliation removed the bystander account — it must delete only tombstoned rows.');
}
if (!evidence.partB.scratchHoldsTombstones) {
  failures.push('the reconciled copy holds no tombstones — a second restore would resurrect again.');
}

evidence.ok = failures.length === 0;
evidence.failures = failures;
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.ok) {
  console.error(`\nT40b verification FAILED with ${failures.length} finding(s) (see failures above).`);
  process.exit(1);
}
console.log('\nT40b verification PASS: backups expire on a bound and restores reconcile deletions.');
