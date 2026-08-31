#!/usr/bin/env node

/**
 * Exercises every administrator action against a local environment.
 *
 * The workflow verifier covers what an ordinary account can do. This covers the other half: the
 * actions that change someone else's account. Each one is checked for its effect, not merely for a
 * 200 — disabling must actually end that person's session, a password reset must invalidate the old
 * password, and the guards that stop an installation losing its last administrator must hold.
 *
 * It needs an administrator's credentials, which are read from the environment so they are never
 * written into this file:
 *
 *   IKBENEENAPPEL_ADMIN_EMAIL=... IKBENEENAPPEL_ADMIN_PASSWORD=... npm run verify:admin
 */

import { randomBytes } from 'node:crypto';

const baseUrl = process.env.IKBENEENAPPEL_VERIFY_URL ?? 'http://127.0.0.1:3000';
const parsedBase = new URL(baseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedBase.hostname)) {
  throw new Error('The admin verifier refuses to run against a non-local URL.');
}

const adminEmail = process.env.IKBENEENAPPEL_ADMIN_EMAIL;
const adminPassword = process.env.IKBENEENAPPEL_ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  throw new Error('Set IKBENEENAPPEL_ADMIN_EMAIL and IKBENEENAPPEL_ADMIN_PASSWORD before running this.');
}

const origin = parsedBase.origin;
const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const targetEmail = `admin-target-${runId}@example.test`;
const targetPassword = `Local-only-${randomBytes(16).toString('base64url')}!`;
const resetPassword = `Reset-only-${randomBytes(16).toString('base64url')}!`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function session() {
  let cookie = '';
  return {
    async request(path, options = {}) {
      const headers = new Headers(options.headers);
      headers.set('Origin', origin);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0];
      const type = response.headers.get('content-type') ?? '';
      return { response, data: type.includes('application/json') ? await response.json() : await response.text() };
    },
  };
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const patch = (body) => ({ ...json(body), method: 'PATCH' });
const del = (body) => ({ ...json(body), method: 'DELETE' });

async function expect(result, status, label) {
  assert(result.response.status === status,
    `${label}: expected ${status}, got ${result.response.status} ${JSON.stringify(result.data).slice(0, 160)}`);
  return result.data;
}

const checks = [];
const admin = session();
const target = session();

console.log('1/9 Signing in as the administrator...');
await expect(await admin.request('/api/auth', json({ email: adminEmail, password: adminPassword })),
  200, 'admin sign-in');
const overview = await expect(await admin.request('/api/admin'), 200, 'admin overview');
assert(Array.isArray(overview.users), 'the overview must list accounts');
// Counts only: an administrator must never be handed anyone's CV text or job list.
assert(!JSON.stringify(overview).includes('cvText'), 'the overview must not expose CV text');
checks.push('admin overview is counts-only');

console.log('2/9 Creating a disposable target account...');
await expect(await target.request('/api/auth', json({ action: 'register', email: targetEmail, password: targetPassword })),
  200, 'target registration');
await expect(await target.request('/api/state'), 200, 'target can use its own workspace');
checks.push('target account created');

console.log('3/9 Confirming a non-admin cannot reach administration...');
await expect(await target.request('/api/admin'), 403, 'non-admin overview must be refused');
await expect(await target.request('/api/admin', patch({ userId: 'anything', action: 'promote' })),
  403, 'non-admin promote must be refused');
checks.push('administration refused to non-admins');

const listed = await expect(await admin.request('/api/admin'), 200, 'overview after registration');
const targetId = listed.users.find((user) => user.email === targetEmail)?.id;
assert(targetId, 'the new account should appear in the overview');
const adminId = listed.users.find((user) => user.email === adminEmail)?.id;

console.log('4/9 Promoting and demoting...');
await expect(await admin.request('/api/admin', patch({ userId: targetId, action: 'promote' })), 200, 'promote');
assert((await admin.request('/api/admin')).data.users.find((u) => u.id === targetId)?.role === 'admin',
  'promote must take effect');
await expect(await admin.request('/api/admin', patch({ userId: targetId, action: 'demote' })), 200, 'demote');
assert((await admin.request('/api/admin')).data.users.find((u) => u.id === targetId)?.role === 'user',
  'demote must take effect');
checks.push('promote and demote');

console.log('5/9 Disabling, and confirming it ends the session immediately...');
await expect(await admin.request('/api/admin', patch({ userId: targetId, action: 'disable' })), 200, 'disable');
// The point of disabling is that it takes effect now, not when their cookie happens to expire.
const afterDisable = await target.request('/api/state');
assert([401, 403].includes(afterDisable.response.status),
  `a disabled account must lose access at once, got ${afterDisable.response.status}`);
await expect(await target.request('/api/auth', json({ email: targetEmail, password: targetPassword })),
  401, 'a disabled account must not be able to sign in');
checks.push('disable revokes access immediately');

console.log('6/9 Re-enabling...');
await expect(await admin.request('/api/admin', patch({ userId: targetId, action: 'enable' })), 200, 'enable');
await expect(await target.request('/api/auth', json({ email: targetEmail, password: targetPassword })),
  200, 'an enabled account can sign in again');
checks.push('enable restores access');

console.log('7/9 Resetting a password, and confirming the old one dies...');
await expect(await admin.request('/api/admin', patch({ userId: targetId, action: 'set-password', newPassword: resetPassword })),
  200, 'set-password');
await expect(await session().request('/api/auth', json({ email: targetEmail, password: targetPassword })),
  401, 'the previous password must stop working');
await expect(await session().request('/api/auth', json({ email: targetEmail, password: resetPassword })),
  200, 'the new password must work');
await expect(await admin.request('/api/admin', patch({ userId: targetId, action: 'set-password', newPassword: 'short' })),
  400, 'a weak replacement password must be refused');
checks.push('password reset invalidates the old password');

console.log('8/9 Confirming the last administrator cannot be removed...');
await expect(await admin.request('/api/admin', patch({ userId: adminId, action: 'demote' })),
  409, 'demoting the only administrator must be refused');
await expect(await admin.request('/api/admin', patch({ userId: adminId, action: 'disable' })),
  409, 'disabling your own account must be refused');
await expect(await admin.request('/api/admin', del({ userId: adminId, confirm: 'DELETE' })),
  409, 'deleting your own account from administration must be refused');
await expect(await admin.request('/api/admin', del({ userId: targetId })),
  400, 'deletion without confirmation must be refused');
checks.push('last-administrator and self-action guards');

console.log('9/9 Deleting the disposable account...');
await expect(await admin.request('/api/admin', del({ userId: targetId, confirm: 'DELETE' })), 200, 'delete');
const finalUsers = (await admin.request('/api/admin')).data.users;
assert(!finalUsers.some((user) => user.email === targetEmail), 'the deleted account must be gone');
await expect(await session().request('/api/auth', json({ email: targetEmail, password: resetPassword })),
  401, 'a deleted account must not be able to sign in');
checks.push('account deletion');

console.log(JSON.stringify({ ok: true, environment: baseUrl, checks }, null, 2));
