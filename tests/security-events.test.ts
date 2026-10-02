import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import {
  evaluateSecurityAlerts,
  isSecurityEventKind,
  normalizeSecurityEvent,
  recordSecurityEvent,
  SECURITY_EVENT_KINDS,
  SECURITY_EVENT_RETENTION_DAYS,
} from '../lib/security-events';

/**
 * T44 (F12): minimal security-event log without job content or secrets.
 * All rows here are synthetic; no real addresses, passwords, or tokens appear.
 */

async function eventDb(withActor = true) {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = (await runtime.getD1Database('DB')) as unknown as D1Database;
  await db
    .prepare(
      `CREATE TABLE auth_events (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        ${withActor ? 'actor TEXT NOT NULL DEFAULT \'\',' : ''}
        created_at TEXT NOT NULL
      )`,
    )
    .run();
  return { db, dispose: () => runtime.dispose() };
}

test('the allow-list covers the required families and nothing else', () => {
  for (const kind of [
    'login',
    'failed',
    'throttled',
    'password-change',
    'email-change',
    'reset-request',
    'reset-confirm',
    'verify',
    'admin-disable',
    'admin-promote',
    'admin-set-password',
    'admin-delete-account',
  ]) {
    assert.equal(isSecurityEventKind(kind), true, `${kind} must be loggable`);
  }
  assert.equal(isSecurityEventKind('job-imported'), false, 'job content must never be a security kind');
  assert.equal(isSecurityEventKind('password-hash'), false, 'secrets must never be a security kind');
  assert.equal(isSecurityEventKind('admin:disable by someone'), false, 'legacy encoding is read, never written');
  assert.ok(SECURITY_EVENT_KINDS.length >= 15);
});

test('unknown kinds are refused rather than stored', async () => {
  const { db, dispose } = await eventDb();
  try {
    await assert.rejects(() => recordSecurityEvent(db, { kind: 'job-imported' }));
    const row = await db.prepare('SELECT COUNT(*) AS total FROM auth_events').first<{ total: number }>();
    assert.equal(row?.total, 0, 'a refused kind must store nothing');
  } finally {
    await dispose();
  }
});

test('a recorded event holds only the minimal columns — no job content or secrets', async () => {
  const { db, dispose } = await eventDb();
  try {
    await recordSecurityEvent(db, { email: 'subject@example.test', ip: '10.0.0.1', kind: 'failed' });
    await recordSecurityEvent(db, {
      email: 'target@example.test',
      ip: '10.0.0.2',
      kind: 'admin-disable',
      actor: 'owner@example.test',
    });
    const rows = await db
      .prepare('SELECT id, email, ip, kind, actor, created_at FROM auth_events ORDER BY created_at')
      .all<{ id: string; email: string; ip: string; kind: string; actor: string; created_at: string }>();
    assert.equal(rows.results.length, 2);
    for (const row of rows.results) {
      const columns = Object.keys(row).sort();
      assert.deepEqual(columns, ['actor', 'created_at', 'email', 'id', 'ip', 'kind']);
      const serialized = JSON.stringify(row);
      assert.doesNotMatch(serialized, /password|token|description|job/i, 'no secret or job content may be stored');
    }
    assert.equal(rows.results[1].kind, 'admin-disable');
    assert.equal(rows.results[1].actor, 'owner@example.test');
  } finally {
    await dispose();
  }
});

test('legacy admin rows embedded in kind still attribute to the right administrator', () => {
  const normalized = normalizeSecurityEvent({
    id: 'x',
    email: 'target@example.test',
    ip: '',
    kind: 'admin:disable by owner@example.test',
    created_at: '2026-09-24T00:00:00.000Z',
  });
  assert.equal(normalized.kind, 'admin-disable');
  assert.equal(normalized.actor, 'owner@example.test');
});

test('recording works on databases that predate the actor column', async () => {
  const { db, dispose } = await eventDb(false);
  try {
    await recordSecurityEvent(db, { email: 'target@example.test', ip: 'local', kind: 'admin-disable', actor: 'o@example.test' });
    const row = await db.prepare('SELECT kind FROM auth_events').first<{ kind: string }>();
    assert.match(row?.kind ?? '', /^admin:/, 'must fall back to the legacy encoding, not lose the event');
  } finally {
    await dispose();
  }
});

test('bursts of failures or throttles raise an alert; ordinary use does not', async () => {
  const { db, dispose } = await eventDb();
  try {
    await recordSecurityEvent(db, { kind: 'failed' });
    assert.deepEqual(await evaluateSecurityAlerts(db), [], 'one failure is not a burst');
    for (let i = 0; i < 10; i++) {
      await recordSecurityEvent(db, { email: `s${i}@example.test`, ip: '10.9.9.9', kind: 'failed' });
    }
    const firing = await evaluateSecurityAlerts(db);
    assert.ok(firing.some((alert) => alert.key === 'failed-signin-burst'), 'ten failures must alert');
    assert.ok((firing.find((a) => a.key === 'failed-signin-burst')?.count ?? 0) >= 10);
  } finally {
    await dispose();
  }
});

test('five throttles in a window alert; token probing is counted across both kinds', async () => {
  const { db, dispose } = await eventDb();
  try {
    for (let i = 0; i < 5; i++) await recordSecurityEvent(db, { kind: 'throttled' });
    assert.ok(
      (await evaluateSecurityAlerts(db)).some((a) => a.key === 'throttle-burst'),
      'five throttles must alert',
    );
  } finally {
    await dispose();
  }
  const second = await eventDb();
  try {
    for (let i = 0; i < 3; i++) await second.db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(`r${i}`, '', 'local', 'reset-invalid', new Date().toISOString()).run();
    for (let i = 0; i < 2; i++) await second.db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(`v${i}`, '', 'local', 'verify-invalid', new Date().toISOString()).run();
    assert.ok(
      (await evaluateSecurityAlerts(second.db)).some((a) => a.key === 'token-probing'),
      'reset-invalid + verify-invalid together must alert',
    );
  } finally {
    await second.dispose();
  }
});

test('migration 32 adds the actor column and the kind index; retention stays 30 days', async () => {
  const migration = runtimeMigrations.find((entry) => entry.version === 32);
  assert.ok(migration, 'migration 32 must exist');
  assert.equal(migration.name, 'security_event_actor_and_kind_index');
  const sql = migration.statements.join('\n');
  assert.match(sql, /ADD COLUMN actor TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /auth_events_kind_idx ON auth_events\(kind, created_at\)/);
  assert.equal(SECURITY_EVENT_RETENTION_DAYS, 30);

  const runtime = await readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /DELETE FROM auth_events WHERE created_at < datetime\('now', '-30 days'\)/);
  const expire = runtimeMigrations.find((entry) => entry.name === 'expire_auth_events');
  assert.match(expire?.statements.join('\n') ?? '', /-30 days/);
});

test('credential changes and every abuse-limit hit are recorded through the shared helper', async () => {
  const account = await readFile(new URL('../app/api/account/route.ts', import.meta.url), 'utf8');
  assert.match(account, /recordSecurityEvent/, 'account changes must use the shared helper');
  assert.match(account, /'password-change'/, 'a password change must be logged');
  assert.match(account, /'email-change'/, 'an email change must be logged');
  assert.doesNotMatch(account, /newPassword[^]*recordSecurityEvent\([^)]*newPassword/, 'the secret itself must never be logged');
  assert.match(account, /kind: 'throttled'/, 'the account throttle must be logged');

  for (const [name, path] of [
    ['auth', '../app/api/auth/route.ts'],
    ['reset', '../app/api/auth/password-reset/route.ts'],
    ['verify', '../app/api/auth/verify/route.ts'],
    ['confirm', '../app/api/auth/password-reset/confirm/route.ts'],
    ['email-test', '../app/api/admin/email/route.ts'],
  ] as const) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /recordSecurityEvent/, `${name} must log through the shared helper`);
    assert.match(source, /'throttled'/, `${name} must record its abuse-limit hits`);
    assert.doesNotMatch(source, /INSERT INTO auth_events/, `${name} must not hand-roll its own insert`);
  }
  // The verify-confirm GET used to return its throttle silently; it must log now.
  const verify = await readFile(new URL('../app/api/auth/verify/route.ts', import.meta.url), 'utf8');
  assert.match(verify, /verify-confirm:ip:[\s\S]*?recordAttempt\(db, '', clientIp\(request\), 'throttled'\)/);
});

test('administrator actions use the actor column with the request IP, not the kind string', async () => {
  const admin = await readFile(new URL('../app/api/admin/route.ts', import.meta.url), 'utf8');
  assert.match(admin, /recordSecurityEvent/, 'admin actions must use the shared helper');
  assert.match(admin, /kind: `admin-\$\{action\}`/, 'admin kinds must be admin-<action> with the actor separate');
  for (const action of ['disable', 'enable', 'promote', 'demote', 'set-password', 'delete-account']) {
    assert.match(admin, new RegExp(`recordAdminAction\\(db, actor\\.email, target\\.email, '${action}'`),
      `admin ${action} must be logged through recordAdminAction`);
  }
  assert.match(admin, /actor: actorEmail/, 'the administrator must be stored in actor');
  assert.match(admin, /clientIp\(request\)/, 'administrator actions must record the request IP');
  assert.doesNotMatch(admin, /admin:\$\{action\} by/, 'must not embed the actor in the kind string anymore');
});

test('the security viewer is administrator-only, minimal, and carries the alert path', async () => {
  const viewer = await readFile(new URL('../app/api/admin/security-events/route.ts', import.meta.url), 'utf8');
  assert.match(viewer, /requireSession\(request, \{ adminOnly: true \}\)/);
  assert.match(viewer, /evaluateSecurityAlerts/);
  assert.match(viewer, /normalizeSecurityEvent/);
  assert.match(viewer, /retention/);
  assert.match(viewer, /alerts/);
  assert.match(viewer, /cache-control.*no-store/i);
  // Minimal columns only: no job, password, token, or refusal-text field may be selected.
  assert.doesNotMatch(viewer, /SELECT[^;]*(description|password|token|reason)/i);
  assert.doesNotMatch(viewer, /jobs|vacancies/i, 'the viewer must never touch job tables');
  // A kind filter must be allow-listed, never interpolated.
  assert.match(viewer, /isSecurityEventKind\(kindFilter\)/);
});

test('deleting an account removes both its event subjects and its actor attributions', async () => {
  const helper = await readFile(new URL('../lib/account-deletion.ts', import.meta.url), 'utf8');
  assert.match(helper, /DELETE FROM auth_events WHERE email = \?/);
  assert.match(helper, /DELETE FROM auth_events WHERE actor = \?/);
});

test('the privacy copy describes the expanded log, its retention, and its admin-only access', async () => {
  const privacy = await readFile(new URL('../lib/privacy-policy.ts', import.meta.url), 'utf8');
  assert.match(privacy, /password and email changes/);
  assert.match(privacy, /administrator actions/);
  assert.match(privacy, /30 days/);
  assert.match(privacy, /Only an administrator can read the security log/);
  assert.match(privacy, /never.*job content|without job content/i);
});
