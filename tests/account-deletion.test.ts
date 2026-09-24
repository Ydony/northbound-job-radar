import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations, type RuntimeMigration } from '../db/migrations';
import { accountDeletionStatements, ownedDataDeletionStatements } from '../lib/account-deletion';

// INT-14c (#172, pairs with #129): the Settings screen promises "Delete account -
// this cannot be undone", but no test exercised either delete path and the list of
// user-scoped tables was maintained by hand in three places. This test derives the
// list from the schema itself (db/runtime.ts base + db/migrations.ts), so a future
// migration that adds a user-scoped table fails the suite until lib/account-deletion.ts
// covers it — the `indeed_settings` near-miss for #113 is the precedent.
//
// Data export is explicitly OUT of scope: owner decision 2026-09-24 was NO export
// feature (GDPR Article 20 gap accepted), and lib/export.ts stays deleted.
// R2/CV-object deletion from the original #129 write-up is obsolete: CV upload, R2
// storage and the `cvs` table were removed (migration 28), and no R2 binding remains
// in code — there is nothing left to delete or assert.

interface ColumnDef {
  name: string;
  affinity: string;
  notNull: boolean;
  hasDefault: boolean;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseColumnDef(fragment: string): ColumnDef | null {
  const trimmed = fragment.trim();
  if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(trimmed)) return null;
  const match = trimmed.match(/^["'`[]?(\w+)["'`\]]?\s+(\w+)([\s\S]*)$/);
  if (!match) return null;
  const [, name, affinity, rest] = match;
  const upper = rest.toUpperCase();
  return {
    name,
    affinity: affinity.toUpperCase(),
    notNull: /\bNOT NULL\b/.test(upper) || /\bPRIMARY KEY\b/.test(upper),
    hasDefault: /\bDEFAULT\b/.test(upper),
  };
}

function extractBaseStatements(runtimeSource: string): string[] {
  // The whole file, not just the schemaStatements block: ensureSchema() also creates
  // schema_migrations inline, and it is a real table with a disposition below.
  const statements: string[] = [];
  // Backreference, not a character class: a backtick statement may contain '' defaults.
  for (const match of runtimeSource.matchAll(/(`|')((?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX)[\s\S]*?)\1/g)) {
    statements.push(match[2]);
  }
  assert.ok(statements.length > 0, 'expected base CREATE statements in db/runtime.ts');
  return statements;
}

/**
 * Replays the schema the way ensureSchema() does — base tables first, then every
 * migration in order — tracking which tables exist and their final columns. Handles
 * the table rebuilds (migration 7), renames and the CV removal (migration 28) so
 * transient and dropped tables never leak into the derived set.
 */
function deriveSchema(baseStatements: string[], migrations: RuntimeMigration[]) {
  const columns = new Map<string, Map<string, ColumnDef>>();
  const ensure = (table: string) => {
    let entry = columns.get(table);
    if (!entry) {
      entry = new Map();
      columns.set(table, entry);
    }
    return entry;
  };
  const apply = (sql: string) => {
    const create = sql.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*)\)\s*$/);
    if (create) {
      const entry = ensure(create[1]);
      for (const fragment of splitTopLevel(create[2])) {
        const column = parseColumnDef(fragment);
        if (column) entry.set(column.name, column);
      }
      return;
    }
    const addColumn = sql.match(/ALTER TABLE (\w+) ADD COLUMN ([\s\S]+)$/);
    if (addColumn) {
      const column = parseColumnDef(addColumn[2]);
      if (column) ensure(addColumn[1]).set(column.name, column);
      return;
    }
    const dropColumn = sql.match(/ALTER TABLE (\w+) DROP COLUMN (\w+)/);
    if (dropColumn) {
      columns.get(dropColumn[1])?.delete(dropColumn[2]);
      return;
    }
    const dropTable = sql.match(/DROP TABLE (?:IF EXISTS )?(\w+)/);
    if (dropTable) {
      columns.delete(dropTable[1]);
      return;
    }
    const rename = sql.match(/ALTER TABLE (\w+) RENAME TO (\w+)/);
    if (rename) {
      const entry = columns.get(rename[1]);
      columns.delete(rename[1]);
      if (entry) columns.set(rename[2], entry);
    }
  };
  for (const statement of baseStatements) apply(statement);
  for (const migration of migrations) {
    for (const statement of migration.statements) apply(statement);
  }
  return columns;
}

/** Tables that must disappear with the account, derived — never hand-listed. */
function userScopedTables(schema: Map<string, Map<string, ColumnDef>>): string[] {
  return [...schema.entries()]
    .filter(([, cols]) => cols.has('user_id'))
    .map(([table]) => table)
    .sort();
}

// Tables without a `user_id` column are NOT silently skipped: each one needs a
// recorded reason, so a future table that should have an owner but was created
// without one fails here instead of surviving deletion unnoticed.
const NON_USER_TABLE_DISPOSITION: Record<string, string> = {
  users: 'the account row itself, deleted by id',
  auth_events: 'keyed by email, not user_id; deleted by the current account email',
  search_run_sources: 'carries no user_id; deleted through its parent search_runs',
  // Aggregate visit counters by design: visitors per day, unique and total, nothing
  // that identifies a person or survives as a profile.
  daily_visits: 'aggregate counters only, no per-user data',
  visit_markers: 'same-day de-duplication hashes, deleted on day rollover',
  // Buckets embed an IP or email (`auth:ip:<ip>`, `auth:email:<email>` in
  // app/api/auth/route.ts) but live at most one 15-minute window and are swept on
  // rollover in lib/guard.ts. Short-lived abuse-prevention state, not account data;
  // deleting it with the account would weaken brute-force protection for the address.
  rate_limits: '15-minute abuse-prevention counters, self-expiring',
  indeed_control: 'installation-wide Indeed operational state, not user data',
  schema_migrations: 'migration bookkeeping, no user data',
};

async function fullSchemaFixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("fixture"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = (await runtime.getD1Database('DB')) as unknown as D1Database;
  const runtimeSource = await readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8');
  const baseStatements = extractBaseStatements(runtimeSource);
  for (const statement of baseStatements) {
    await db.prepare(statement).run();
  }
  for (const migration of runtimeMigrations) {
    await db.batch(migration.statements.map((sql) => db.prepare(sql)));
  }
  const schema = deriveSchema(baseStatements, runtimeMigrations);
  return { db, dispose: () => runtime.dispose(), schema };
}

interface SyntheticOwner {
  tag: string;
  id: string;
  email: string;
}

function cellValue(table: string, column: ColumnDef, owner: SyntheticOwner, runId: string): unknown {
  if (column.name === 'user_id') return owner.id;
  if (column.name === 'email') return owner.email;
  if (table === 'search_runs' && column.name === 'id') return runId;
  if (table === 'search_run_sources' && column.name === 'run_id') return runId;
  if (/INT|REAL|FLOA|DOUB|NUMERIC|BOOLEAN/.test(column.affinity)) return 1;
  if (column.name === 'source_url') return `https://example.test/${owner.tag}`;
  if (column.name === 'canonical_url') return `https://example.test/${owner.tag}/canonical`;
  return `${owner.tag}-${table}-${column.name}`;
}

/** One synthetic row per table for this owner, shaped by the real final columns. */
async function seedOwner(db: D1Database, schema: Map<string, Map<string, ColumnDef>>, owner: SyntheticOwner) {
  const runId = `${owner.tag}-run`;
  await db.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, last_seen_at)
    VALUES (?, ?, ?, 'user', 'active', ?, ?)`)
    .bind(owner.id, owner.email, 'synthetic-hash', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z').run();
  for (const [table, cols] of [...schema.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (table === 'users' || table === 'schema_migrations') continue;
    if (!cols.has('user_id') && table !== 'auth_events' && table !== 'search_run_sources') continue;
    const wanted = new Map<string, unknown>();
    for (const column of cols.values()) {
      if (column.notNull && !column.hasDefault) wanted.set(column.name, cellValue(table, column, owner, runId));
    }
    // Identity columns ride along even when they carry a DEFAULT ('legacy', ''), or
    // every seeded row would collapse onto the same pre-tenancy marker.
    if (cols.has('user_id')) wanted.set('user_id', owner.id);
    if (table === 'auth_events') wanted.set('email', owner.email);
    if (table === 'search_run_sources') wanted.set('run_id', runId);
    const names = [...wanted.keys()];
    await db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .bind(...wanted.values()).run();
  }
}

async function countFor(db: D1Database, table: string, column: string, value: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`)
    .bind(value).first<{ total: number }>();
  return row?.total ?? 0;
}

async function derivedSchema() {
  const runtimeSource = await readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8');
  return deriveSchema(extractBaseStatements(runtimeSource), runtimeMigrations);
}

test('derivation finds every owned table including the Indeed precedent', async () => {
  const scoped = userScopedTables(await derivedSchema());
  assert.ok(scoped.length >= 5, `expected several owned tables, found: ${scoped.join(', ')}`);
  // Regression anchors, not the list: jobs is the core workspace, indeed_settings is
  // the table that almost survived deletion for #113.
  assert.ok(scoped.includes('jobs'), `jobs must be owner-scoped, found: ${scoped.join(', ')}`);
  assert.ok(scoped.includes('indeed_settings'), `indeed_settings must be owner-scoped, found: ${scoped.join(', ')}`);
  // The CV removal must hold: no live table may reference removed CV storage.
  assert.ok(!(await derivedSchema()).has('cvs'), 'cvs must stay dropped after migration 28');
});

test('every table without an owner has a recorded reason, none is skipped silently', async () => {
  const schema = await derivedSchema();
  const scoped = new Set(userScopedTables(schema));
  for (const table of [...schema.keys()].sort()) {
    if (scoped.has(table)) continue;
    assert.ok(
      table in NON_USER_TABLE_DISPOSITION,
      `${table} has no user_id column and no recorded disposition — ` +
      'decide explicitly whether it holds per-user data and record it in NON_USER_TABLE_DISPOSITION',
    );
  }
  for (const table of Object.keys(NON_USER_TABLE_DISPOSITION)) {
    assert.ok(schema.has(table), `disposition recorded for unknown table ${table} — the schema moved on`);
  }
});

test('the shared deletion helper covers every derived table; routes delegate to it', async () => {
  const scoped = userScopedTables(await derivedSchema());
  const helper = await readFile(new URL('../lib/account-deletion.ts', import.meta.url), 'utf8');
  for (const table of scoped) {
    assert.match(
      helper,
      new RegExp(`DELETE FROM ${table} WHERE user_id = \\?`),
      `${table} is owner-scoped in the schema but lib/account-deletion.ts never deletes it`,
    );
  }
  // Owned rows with their own key shape travel with the helper, not around it.
  assert.match(helper, /DELETE FROM search_run_sources WHERE run_id IN \(SELECT id FROM search_runs WHERE user_id = \?\)/);
  assert.match(helper, /DELETE FROM password_resets WHERE user_id = \?/);
  assert.match(helper, /DELETE FROM auth_events WHERE email = \?/);
  assert.match(helper, /DELETE FROM users WHERE id = \?/);

  const accountRoute = await readFile(new URL('../app/api/account/route.ts', import.meta.url), 'utf8');
  const adminRoute = await readFile(new URL('../app/api/admin/route.ts', import.meta.url), 'utf8');
  const workspaceRoute = await readFile(new URL('../app/api/workspace/route.ts', import.meta.url), 'utf8');
  // Both delete paths call the same helper with their own identity: the user route
  // deletes the caller, the admin route deletes the named account by its own email.
  assert.match(accountRoute, /accountDeletionStatements\(db, user\.id, user\.email\)/);
  assert.match(adminRoute, /accountDeletionStatements\(db, userId, target\.email\)/);
  assert.match(workspaceRoute, /ownedDataDeletionStatements\(db, user\.id\)/);
  for (const [name, source] of [['account', accountRoute], ['admin', adminRoute], ['workspace', workspaceRoute]] as const) {
    assert.doesNotMatch(
      source,
      /DELETE FROM (jobs|language_feedback|search_settings|search_roles|indeed_settings|indeed_coverage|dismissed_jobs|rejected_listings|search_runs) WHERE/,
      `${name} route keeps a hand-maintained deletion list beside the shared helper`,
    );
  }
  // The refactor must not have dropped the safety guards around the helper call.
  assert.match(accountRoute, /only administrator/);
  assert.match(adminRoute, /Delete your own account from Settings/);
  assert.match(adminRoute, /only active administrator/);
});

test('deleting an account empties every derived table and leaves the other account intact', async () => {
  const { db, dispose, schema } = await fullSchemaFixture();
  try {
    const scoped = userScopedTables(schema);
    const victim: SyntheticOwner = { tag: 'victim', id: 'victim-id', email: 'victim@example.test' };
    const bystander: SyntheticOwner = { tag: 'bystander', id: 'bystander-id', email: 'bystander@example.test' };
    await seedOwner(db, schema, victim);
    await seedOwner(db, schema, bystander);

    await db.batch(accountDeletionStatements(db, victim.id, victim.email));

    for (const table of scoped) {
      assert.equal(await countFor(db, table, 'user_id', victim.id), 0, `${table} still holds victim rows`);
      assert.equal(await countFor(db, table, 'user_id', bystander.id), 1, `${table} lost the bystander row`);
    }
    assert.equal(await countFor(db, 'users', 'id', victim.id), 0, 'victim users row survives');
    assert.equal(await countFor(db, 'users', 'id', bystander.id), 1, 'bystander users row lost');
    assert.equal(await countFor(db, 'auth_events', 'email', victim.email), 0, 'victim sign-in history survives');
    assert.equal(await countFor(db, 'auth_events', 'email', bystander.email), 1, 'bystander sign-in history lost');
    const victimRuns = await db.prepare('SELECT COUNT(*) AS total FROM search_run_sources WHERE run_id IN (SELECT id FROM search_runs WHERE user_id = ?)')
      .bind(victim.id).first<{ total: number }>();
    assert.equal(victimRuns?.total ?? -1, 0, 'victim run-source rows survive');
    const bystanderRuns = await db.prepare('SELECT COUNT(*) AS total FROM search_run_sources WHERE run_id IN (SELECT id FROM search_runs WHERE user_id = ?)')
      .bind(bystander.id).first<{ total: number }>();
    assert.equal(bystanderRuns?.total ?? 0, 1, 'bystander run-source rows lost');
  } finally {
    await dispose();
  }
});

test('workspace reset empties the owned workspace but keeps the account', async () => {
  const { db, dispose, schema } = await fullSchemaFixture();
  try {
    const scoped = userScopedTables(schema);
    const owner: SyntheticOwner = { tag: 'owner', id: 'owner-id', email: 'owner@example.test' };
    await seedOwner(db, schema, owner);

    await db.batch(ownedDataDeletionStatements(db, owner.id));

    for (const table of scoped) {
      if (table === 'password_resets') continue; // Reset keeps credentials, unlike deletion.
      assert.equal(await countFor(db, table, 'user_id', owner.id), 0, `reset left ${table} rows behind`);
    }
    assert.equal(await countFor(db, 'users', 'id', owner.id), 1, 'reset must not delete the account');
    assert.equal(await countFor(db, 'password_resets', 'user_id', owner.id), 1, 'reset must not revoke recovery state');
    assert.equal(await countFor(db, 'auth_events', 'email', owner.email), 1, 'reset must not wipe sign-in history');
  } finally {
    await dispose();
  }
});

test('rate-limit buckets that embed identity are short-lived by construction, not by omission', async () => {
  // #129 known gap, decided here: auth buckets are `auth:ip:<ip>` / `auth:email:<email>`
  // (app/api/auth/route.ts), held at most one 15-minute window and swept on rollover
  // (lib/guard.ts). Account deletion deliberately leaves them: they are brute-force
  // protection for the address, not account data, and expire on their own.
  const authRoute = await readFile(new URL('../app/api/auth/route.ts', import.meta.url), 'utf8');
  assert.match(authRoute, /durableRateLimit\(db, `auth:ip:\$\{ip\}`.*15 \* 60_000/);
  assert.match(authRoute, /durableRateLimit\(db, `auth:email:\$\{email\}`.*15 \* 60_000/);
  const guard = await readFile(new URL('../lib/guard.ts', import.meta.url), 'utf8');
  assert.match(guard, /DELETE FROM rate_limits WHERE reset_at <= \?/);
});
