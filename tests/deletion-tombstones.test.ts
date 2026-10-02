import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import {
  DELETION_TOMBSTONE_RETENTION_HOURS,
  accountDeletionStatements,
  copyDeletionTombstones,
  deletionTombstoneExpiry,
  hashDeletionIdentity,
  reconcileDeletedAccounts,
} from '../lib/account-deletion';

/**
 * T40b (F13): restoring a backup taken before an account deletion silently
 * resurrects the deleted account. Deletion records a hash-only tombstone in
 * the same batch, and the restore procedure re-applies tombstoned deletions
 * before the copy serves traffic. Synthetic fixtures only.
 */

const NOW = '2026-09-29T00:00:00.000Z';

interface SyntheticOwner {
  id: string;
  email: string;
}

async function migratedDb() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("fixture"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB', 'SCRATCH'],
  });
  const db = (await runtime.getD1Database('DB')) as unknown as D1Database;
  const scratch = (await runtime.getD1Database('SCRATCH')) as unknown as D1Database;
  // Replay the schema the way ensureSchema() does: base tables, then every migration.
  const runtimeSource = await readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8');
  const baseStatements: string[] = [];
  for (const match of runtimeSource.matchAll(/(`|')((?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX)[\s\S]*?)\1/g)) {
    baseStatements.push(match[2]);
  }
  for (const target of [db, scratch]) {
    for (const statement of baseStatements) {
      await target.prepare(statement).run();
    }
    for (const migration of runtimeMigrations) {
      await target.batch(migration.statements.map((sql) => target.prepare(sql)));
    }
  }
  return { db, scratch, dispose: () => runtime.dispose() };
}

async function seedOwner(db: D1Database, owner: SyntheticOwner) {
  await db.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, last_seen_at)
    VALUES (?, ?, ?, 'user', 'active', ?, ?)`)
    .bind(owner.id, owner.email, 'synthetic-hash', NOW, NOW).run();
  await db.prepare('INSERT INTO search_roles (id, position, role, updated_at, user_id) VALUES (?, ?, ?, ?, ?)')
    .bind(`${owner.id}-role`, 0, 'engineer', NOW, owner.id).run();
  await db.prepare("INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, 'signin_success', ?)")
    .bind(`${owner.id}-event`, owner.email, '198.51.100.7', NOW).run();
}

async function countRows(db: D1Database, table: string, column: string, value: string) {
  return (await db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`)
    .bind(value).first<{ total: number }>())?.total ?? -1;
}

test('deletion records a hash-only tombstone expiring with the backup retention', async () => {
  const { db, dispose } = await migratedDb();
  try {
    const victim: SyntheticOwner = { id: 'tomb-victim', email: 'tomb-victim@example.test' };
    await seedOwner(db, victim);

    await db.batch(await accountDeletionStatements(db, victim.id, victim.email));

    const userHash = await hashDeletionIdentity(victim.id);
    const emailHash = await hashDeletionIdentity(victim.email);
    const tombstone = await db.prepare('SELECT user_id_hash, email_hash, deleted_at, expires_at FROM deleted_accounts WHERE user_id_hash = ?')
      .bind(userHash).first<{ user_id_hash: string; email_hash: string; deleted_at: string; expires_at: string }>();
    assert.ok(tombstone, 'no tombstone recorded for the deleted account');
    assert.equal(tombstone.email_hash, emailHash);
    // The tombstone holds hashes only: neither the id nor the address appears in it.
    const blob = JSON.stringify(tombstone);
    assert.ok(!blob.includes(victim.id) && !blob.includes(victim.email), 'tombstone leaks plaintext identity');
    // Expiry is exactly the backup retention after deletion: 720h / 30 days.
    assert.equal(tombstone.expires_at, deletionTombstoneExpiry(tombstone.deleted_at));
    assert.equal(
      new Date(tombstone.expires_at).getTime() - new Date(tombstone.deleted_at).getTime(),
      DELETION_TOMBSTONE_RETENTION_HOURS * 3_600_000,
    );
  } finally {
    await dispose();
  }
});

test('reconciliation re-deletes resurrected rows, keeps the tombstone, spares the bystander', async () => {
  const { db, scratch, dispose } = await migratedDb();
  try {
    const victim: SyntheticOwner = { id: 'recon-victim', email: 'recon-victim@example.test' };
    const bystander: SyntheticOwner = { id: 'recon-bystander', email: 'recon-bystander@example.test' };
    // Live: both accounts, then the victim is deleted (tombstone recorded).
    await seedOwner(db, victim);
    await seedOwner(db, bystander);
    await db.batch(await accountDeletionStatements(db, victim.id, victim.email));
    // Scratch: the pre-deletion backup — both accounts still present, no tombstones.
    await seedOwner(scratch, victim);
    await seedOwner(scratch, bystander);

    // The restore step: copy live tombstones into the scratch copy, then reconcile.
    assert.equal(await copyDeletionTombstones(db, scratch), 1);
    const outcome = await reconcileDeletedAccounts(scratch);

    assert.equal(outcome.usersReconciled, 1);
    assert.equal(await countRows(scratch, 'users', 'id', victim.id), 0);
    assert.equal(await countRows(scratch, 'search_roles', 'user_id', victim.id), 0);
    assert.equal(await countRows(scratch, 'auth_events', 'email', victim.email), 0);
    assert.equal(await countRows(scratch, 'users', 'id', bystander.id), 1);
    assert.equal(await countRows(scratch, 'search_roles', 'user_id', bystander.id), 1);
    assert.equal(await countRows(scratch, 'auth_events', 'email', bystander.email), 1);
    // The tombstone survives reconciliation: a second restore reconciles again.
    assert.equal(await countRows(scratch, 'deleted_accounts', 'user_id_hash', await hashDeletionIdentity(victim.id)), 1);
  } finally {
    await dispose();
  }
});

test('expired tombstones still protect, then are purged', async () => {
  const { db, dispose } = await migratedDb();
  try {
    const stale: SyntheticOwner = { id: 'stale-id', email: 'stale@example.test' };
    const fresh: SyntheticOwner = { id: 'fresh-id', email: 'fresh@example.test' };
    await seedOwner(db, stale);
    await db.batch(await accountDeletionStatements(db, fresh.id, fresh.email));
    // Age the stale tombstone past the 30-day retention; its rows resurface like a restore.
    await db.prepare('INSERT INTO deleted_accounts (user_id_hash, email_hash, deleted_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hashDeletionIdentity(stale.id), await hashDeletionIdentity(stale.email),
        '2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z').run();

    const outcome = await reconcileDeletedAccounts(db);

    assert.equal(await countRows(db, 'users', 'id', stale.id), 0, 'expired tombstone stopped protecting');
    assert.equal(outcome.tombstonesPurged, 1);
    assert.equal(await countRows(db, 'deleted_accounts', 'user_id_hash', await hashDeletionIdentity(stale.id)), 0);
    assert.equal(await countRows(db, 'deleted_accounts', 'user_id_hash', await hashDeletionIdentity(fresh.id)), 1,
      'the live tombstone must survive while its retention holds');
  } finally {
    await dispose();
  }
});

test('tombstone retention matches the backup retention it protects', async () => {
  // The tombstone must live no longer than the backups that could resurrect the
  // account — otherwise hashes outlive their purpose — and no shorter, or a
  // restore inside the backup window resurrects silently.
  assert.equal(DELETION_TOMBSTONE_RETENTION_HOURS, 720);
  const litestream = await readFile(new URL('../deploy/litestream.yml', import.meta.url), 'utf8');
  assert.match(litestream, /retention: 720h/);
});
