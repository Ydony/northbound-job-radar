import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionValue, hashPassword, isSameOrigin, readCookie, readSessionValue,
  sessionCookie, verifyPassword } from '../lib/auth';
import { isValidEmail, normalizeEmail, passwordProblem } from '../lib/users';

test('hashes are salted, so the same password never produces the same stored value', async () => {
  const first = await hashPassword('correct horse battery', 1000);
  const second = await hashPassword('correct horse battery', 1000);
  assert.notEqual(first, second);
  assert.ok(await verifyPassword('correct horse battery', first));
  assert.ok(await verifyPassword('correct horse battery', second));
});

test('rejects the wrong password and any malformed stored hash', async () => {
  const stored = await hashPassword('correct horse battery', 1000);
  assert.equal(await verifyPassword('wrong password here', stored), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$1$AAAA$AAAA'), false, 'must reject a low iteration count');
});

test('a session round-trips its owner and epoch', async () => {
  const value = await createSessionValue('user-1', 'secret', 3);
  assert.deepEqual(await readSessionValue(value, 'secret'), { userId: 'user-1', epoch: 3 });
});

test('a cookie issued before the epoch was raised is distinguishable', async () => {
  // The guard compares this epoch against the account, which is what makes revocation possible.
  const old = await readSessionValue(await createSessionValue('user-1', 'secret', 1), 'secret');
  const now = await readSessionValue(await createSessionValue('user-1', 'secret', 2), 'secret');
  assert.notEqual(old?.epoch, now?.epoch);
});

test('a tampered or foreign-signed cookie yields no user', async () => {
  const value = await createSessionValue('user-1', 'secret');
  // Swapping the user id or the epoch must invalidate the signature rather than take effect.
  assert.equal(await readSessionValue(value.replace('user-1', 'user-2'), 'secret'), null);
  assert.equal(await readSessionValue(value.replace(':1:', ':99:'), 'secret'), null);
  assert.equal(await readSessionValue(value, 'different-secret'), null);
  assert.equal(await readSessionValue('garbage', 'secret'), null);
  assert.equal(await readSessionValue('', 'secret'), null);
});

test('an expired session is refused', async () => {
  const value = await createSessionValue('user-1', 'secret', 1, Date.now() - 30 * 24 * 60 * 60 * 1000);
  assert.equal(await readSessionValue(value, 'secret'), null);
});

test('the session cookie is not reachable from scripts or other sites', () => {
  const cookie = sessionCookie('abc', true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(sessionCookie('abc', false), /Secure/, 'plain http must not set Secure or the cookie is dropped');
});

test('reads only its own cookie out of the header', () => {
  const request = new Request('https://example.test', { headers: { cookie: 'other=1; ike_session=abc.def; x=2' } });
  assert.equal(readCookie(request), 'abc.def');
  assert.equal(readCookie(new Request('https://example.test')), '');
});

test('cross-origin state changes are refused', () => {
  const make = (origin?: string) => new Request('https://app.test/api/jobs', {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
  assert.equal(isSameOrigin(make('https://app.test')), true);
  assert.equal(isSameOrigin(make('https://evil.test')), false);
  assert.equal(isSameOrigin(make()), true, 'same-origin fetches may omit Origin');
});

test('email and password rules', () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  assert.ok(isValidEmail('person@example.com'));
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(passwordProblem('short'), 'Use at least 12 characters.');
  assert.equal(passwordProblem('a-long-enough-password'), '');
});
