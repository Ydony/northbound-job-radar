import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { detectSecurityBursts, isSecurityEventKind, recordSecurityEvent,
  SECURITY_EVENT_KINDS, SECURITY_EVENT_RETENTION_DAYS } from '../lib/security-events';

/**
 * T44: security event log and alerting, without job content or secrets.
 *
 * `auth_events` previously recorded sign-ins, verification/reset outcomes and
 * admin actions, but user-initiated password/email changes had no event, there
 * was no administrator reader, and no burst alert path. These tests pin the
 * allowlist boundary, the 30-day retention from T38, the admin-only reader and
 * the burst thresholds — all against synthetic fixtures, never real addresses.
 */

async function eventsDb() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("fixture"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  await db.prepare(`CREATE TABLE auth_events (
    id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();
  return { db, dispose: () => runtime.dispose() };
}

test('the allowlist covers every required family and nothing else', () => {
  for (const kind of ['login', 'failed', 'throttled', 'password-change', 'email-change',
    'reset-request', 'reset-confirm', 'verify', 'admin:disable', 'admin:set-password',
    'admin:delete-account', 'email-sent', 'email-failed']) {
    assert.equal(isSecurityEventKind(kind), true, `${kind} must be recordable`);
  }
  // The admin route's historical attribution suffix stays readable.
  assert.equal(isSecurityEventKind('admin:disable by owner@example.test'), true);
  // No job content, tokens, passwords or free-form detail may become a kind.
  for (const kind of ['job-description', 'job', 'password', 'token', 'reset-token-abc123',
    'admin:drop-table', 'admin:disable by ', '', 'LOGIN']) {
    assert.equal(isSecurityEventKind(kind), false, `${kind} must be refused`);
  }
  assert.ok(SECURITY_EVENT_KINDS.includes('password-change'));
  assert.ok(SECURITY_EVENT_KINDS.includes('email-change'));
  assert.ok(SECURITY_EVENT_KINDS.includes('throttled'));
});

test('recording writes only the four minimal columns and refuses unknown kinds', async () => {
  const { db, dispose } = await eventsDb();
  try {
    await recordSecurityEvent(db, { email: 'person@example.test', ip: '198.51.100.7', kind: 'failed' });
    const row = await db.prepare('SELECT id, email, ip, kind, created_at FROM auth_events')
      .first<{ id: string; email: string; ip: string; kind: string; created_at: string }>();
    assert.equal(row?.email, 'person@example.test');
    assert.equal(row?.ip, '198.51.100.7');
    assert.equal(row?.kind, 'failed');
    assert.ok(row?.id && row?.created_at);
    await assert.rejects(
      recordSecurityEvent(db, { email: 'x@example.test', ip: 'local', kind: 'job-description' }),
      /unknown security-event kind/,
    );
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM auth_events')
      .first<{ total: number }>())?.total, 1, 'a refused kind must store nothing');
  } finally {
    await dispose();
  }
});

test('recording never stores a secret: overlong values are truncated, not kept whole', async () => {
  const { db, dispose } = await eventsDb();
  try {
    const longEmail = `${'a'.repeat(300)}@example.test`;
    await recordSecurityEvent(db, { email: longEmail, ip: '1'.repeat(100), kind: 'login' });
    const row = await db.prepare('SELECT email, ip FROM auth_events')
      .first<{ email: string; ip: string }>();
    assert.ok((row?.email.length ?? 0) <= 254);
    assert.ok((row?.ip.length ?? 0) <= 45);
  } finally {
    await dispose();
  }
});

test('the helper cannot carry job content: its signature has no room for it', async () => {
  const source = await readFile(new URL('../lib/security-events.ts', import.meta.url), 'utf8');
  // No detail column and no parameter that could carry content: the only
  // writable fields are the address tried, the client address and the kind.
  assert.doesNotMatch(source, /detail\s*[:?]/i);
  assert.doesNotMatch(source, /recordSecurityEvent\([^)]*(token|passwordHash|description|jobContent)[^)]*\)/);
  assert.match(source, /INSERT INTO auth_events \(id, email, ip, kind, created_at\)/);
  assert.match(source, /event: \{ email: string; ip: string; kind: string \}/);
});

test('retention is 30 days and the purge that enforces it still exists', async () => {
  assert.equal(SECURITY_EVENT_RETENTION_DAYS, 30);
  const [runtime, migrations] = await Promise.all([
    readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(runtime, /DELETE FROM auth_events WHERE created_at < datetime\('now', '-30 days'\)/);
  assert.match(migrations, /DELETE FROM auth_events WHERE created_at < datetime\('now', '-30 days'\)/);

  const { db, dispose } = await eventsDb();
  try {
    const old = new Date(Date.now() - 31 * 24 * 60_60_000).toISOString();
    await db.prepare("INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES ('old', 'a@example.test', 'local', 'login', ?)")
      .bind(old).run();
    await db.prepare("INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES ('new', 'b@example.test', 'local', 'login', ?)")
      .bind(new Date().toISOString()).run();
    await db.prepare("DELETE FROM auth_events WHERE created_at < datetime('now', '-30 days')").run();
    const remaining = await db.prepare('SELECT id FROM auth_events ORDER BY id').all<{ id: string }>();
    assert.deepEqual(remaining.results.map((row) => row.id), ['new']);
  } finally {
    await dispose();
  }
});

test('bursts flag targeted guessing, spraying and token guessing — and nothing ordinary', () => {
  const now = Date.now();
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const failed = (email: string, ip: string, at: number) =>
    ({ email, ip, kind: 'failed', created_at: iso(at) });
  const throttled = (ip: string, at: number) =>
    ({ email: '', ip, kind: 'throttled', created_at: iso(at) });

  // Ten failures against one address inside 15 minutes: targeted guessing.
  const targeted = Array.from({ length: 10 }, (_, i) => failed('victim@example.test', `198.51.100.${i}`, 14 - i * 0.5));
  assert.equal(detectSecurityBursts(targeted, now).some((burst) => burst.key === 'failed-logins-for-address'), true);

  // Nine are not enough, and ten spread over two hours are stale, not a burst.
  assert.equal(detectSecurityBursts(targeted.slice(0, 9), now).some((burst) => burst.key === 'failed-logins-for-address'), false);
  const stale = Array.from({ length: 12 }, (_, i) => failed('victim@example.test', '198.51.100.9', 120 - i));
  assert.equal(detectSecurityBursts(stale, now).length, 0, 'old failures must not alert');

  // Twenty failures/throttles from one IP: spraying.
  const spray = [
    ...Array.from({ length: 12 }, (_, i) => failed(`user${i}@example.test`, '203.0.113.9', 10)),
    ...Array.from({ length: 8 }, (_, i) => throttled('203.0.113.9', 9 - i * 0.2)),
  ];
  const sprayBursts = detectSecurityBursts(spray, now);
  assert.equal(sprayBursts.some((burst) => burst.key === 'abuse-from-address' && burst.scope === '203.0.113.9'), true);

  // Five invalid single-use links from one IP within the hour: token guessing.
  const guessing = Array.from({ length: 5 }, () =>
    ({ email: '', ip: '192.0.2.4', kind: 'reset-invalid', created_at: iso(30) }));
  assert.equal(detectSecurityBursts(guessing, now).some((burst) => burst.key === 'token-guessing-from-address'), true);
  assert.equal(detectSecurityBursts(guessing.slice(0, 4), now).length, 0, 'four guesses are not a burst');

  // Ordinary use — a couple of mistypes and one success — stays silent.
  assert.deepEqual(detectSecurityBursts([
    failed('person@example.test', '198.51.100.1', 60),
    failed('person@example.test', '198.51.100.1', 59),
    { email: 'person@example.test', ip: '198.51.100.1', kind: 'login', created_at: iso(58) },
  ], now), []);

  // Alerts name a scope, never a secret: the scope is an address tried or a
  // client address, and no token-shaped value appears anywhere in the payload.
  for (const burst of detectSecurityBursts([...targeted, ...spray], now)) {
    assert.ok(burst.scope && burst.advice);
    assert.match(burst.scope, /^[^ ]+@[^ ]+\.[^ ]+$|^[0-9a-fA-F.:]+$/,
      'burst scope must be an email or an IP, never a secret');
    assert.doesNotMatch(JSON.stringify(burst), /[A-Za-z0-9_-]{32,}/, 'no token-shaped value in alerts');
  }
});

test('the reader is administrator-only, capped, validated and alert-bearing', async () => {
  const source = await readFile(new URL('../app/api/admin/security-events/route.ts', import.meta.url), 'utf8');
  assert.match(source, /requireSession\(request, \{ adminOnly: true \}\)/);
  assert.match(source, /ORDER BY created_at DESC LIMIT \?/);
  assert.match(source, /MAX_LIMIT = 500/, 'the page size must be capped');
  assert.match(source, /Math\.min\(/, 'the cap must be enforced');
  assert.match(source, /Unknown event kind\./, 'an unknown kind filter must be refused, not ignored');
  assert.match(source, /detectSecurityBursts\(recent\.results\)/, 'alerts scan the window, not just the page');
  assert.match(source, /SECURITY_EVENT_RETENTION_DAYS/, 'the response states its retention');
  // Only the four minimal columns are ever selected; no join to users or jobs.
  const selects = [...source.matchAll(/SELECT ([A-Za-z0-9_, *]+) FROM auth_events/g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim());
  assert.ok(selects.length > 0);
  for (const columns of selects) {
    assert.ok(columns === 'id, email, ip, kind, created_at' || columns === 'email, ip, kind, created_at',
      `unexpected auth_events projection: ${columns}`);
  }
  assert.doesNotMatch(source, /JOIN\s+(users|jobs)/i);
});

test('self-service credential changes and abuse hits are recorded', async () => {
  const source = await readFile(new URL('../app/api/account/route.ts', import.meta.url), 'utf8');
  assert.match(source, /recordSecurityEvent\(db, \{ email: user\.email, ip: .*?, kind: 'password-change' \}\)/);
  assert.match(source, /recordSecurityEvent\(db, \{ email: user\.email, ip: .*?, kind: 'email-change' \}\)/);
  assert.match(source, /kind: 'throttled'/, 'the account-route rate cap must leave an abuse-limit trace');
  // Which credential changed is recorded; the value never is.
  assert.doesNotMatch(source, /recordSecurityEvent\([^)]*newPassword[^)]*\)/);
  assert.doesNotMatch(source, /recordSecurityEvent\([^)]*password_hash[^)]*\)/);
});

test('privacy copy describes the event log truthfully in the same change', async () => {
  const source = await readFile(new URL('../lib/privacy-policy.ts', import.meta.url), 'utf8');
  assert.match(source, /Security event records/);
  assert.match(source, /password and email changes/);
  assert.match(source, /administrator actions/);
  assert.match(source, /never.*job content|job content.*never/i);
  assert.match(source, /only an administrator can read them/i);
  assert.match(source, /automatically deleted after 30 days/);
});
