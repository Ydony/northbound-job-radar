import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TURNSTILE_TEST_SECRET_ALWAYS_FAIL,
  TURNSTILE_TEST_SECRET_ALWAYS_PASS,
  TURNSTILE_TEST_SITEKEY_ALWAYS_FAIL,
  TURNSTILE_TEST_SITEKEY_ALWAYS_PASS,
  TURNSTILE_VERIFY_URL,
  verifyTurnstileToken,
  type TurnstileFetch,
} from '../lib/turnstile';

/**
 * Turnstile verification talks to Cloudflare's siteverify endpoint, so every test here injects a
 * mocked fetch. Nothing in this file may make a real network request: dev/test build against the
 * documented test keys, and the real secret key is never present in this repository.
 */

function mockFetch(answer: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: TurnstileFetch = async (input, init) => {
    calls.push({ url: input, init });
    return Response.json(answer);
  };
  return { calls, fetchImpl };
}

test('the committed constants are Turnstile\'s documented test keys', () => {
  // https://developers.cloudflare.com/turnstile/troubleshooting/testing/ — public values, safe
  // to commit. If Cloudflare ever rotates them, this is the one place to change.
  assert.equal(TURNSTILE_TEST_SITEKEY_ALWAYS_PASS, '1x00000000000000000000AA');
  assert.equal(TURNSTILE_TEST_SECRET_ALWAYS_PASS, '1x0000000000000000000000000000000AA');
  assert.equal(TURNSTILE_TEST_SITEKEY_ALWAYS_FAIL, '2x00000000000000000000AB');
  assert.equal(TURNSTILE_TEST_SECRET_ALWAYS_FAIL, '2x0000000000000000000000000000000AA');
});

test('a passing token posts the secret, token and IP to the siteverify endpoint', async () => {
  const { calls, fetchImpl } = mockFetch({ success: true });
  const result = await verifyTurnstileToken('token-from-widget', {
    secretKey: TURNSTILE_TEST_SECRET_ALWAYS_PASS,
    remoteIp: '203.0.113.7',
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TURNSTILE_VERIFY_URL);
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    secret: TURNSTILE_TEST_SECRET_ALWAYS_PASS,
    response: 'token-from-widget',
    remoteip: '203.0.113.7',
  });
});

test('a failing token surfaces the provider error codes and verifies as not-ok', async () => {
  const { fetchImpl } = mockFetch({ success: false, 'error-codes': ['invalid-input-response'] });
  const result = await verifyTurnstileToken('bad-token', {
    secretKey: TURNSTILE_TEST_SECRET_ALWAYS_FAIL,
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /invalid-input-response/);
});

test('a failure without codes is still a failure, never an exception', async () => {
  const { fetchImpl } = mockFetch({ success: false });
  assert.deepEqual(await verifyTurnstileToken('bad-token', {
    secretKey: TURNSTILE_TEST_SECRET_ALWAYS_FAIL, fetchImpl,
  }), { ok: false, error: 'verification-failed' });
});

test('a missing token never reaches the endpoint', async () => {
  for (const token of ['', undefined, null, 42]) {
    const { calls, fetchImpl } = mockFetch({ success: true });
    const result = await verifyTurnstileToken(token, {
      secretKey: TURNSTILE_TEST_SECRET_ALWAYS_PASS, fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing-token');
    assert.equal(calls.length, 0, 'no request should be made without a token');
  }
});

test('a missing secret fails closed without a request', async () => {
  const { calls, fetchImpl } = mockFetch({ success: true });
  const result = await verifyTurnstileToken('token-from-widget', { secretKey: '', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing-secret');
  assert.equal(calls.length, 0);
});

test('an unreachable endpoint fails closed', async () => {
  const fetchImpl: TurnstileFetch = async () => { throw new Error('network down'); };
  const result = await verifyTurnstileToken('token-from-widget', {
    secretKey: TURNSTILE_TEST_SECRET_ALWAYS_PASS, fetchImpl,
  });
  assert.deepEqual(result, { ok: false, error: 'verification-unreachable' });
});

test('an unreadable answer fails closed', async () => {
  const fetchImpl: TurnstileFetch = async () => new Response('not json');
  const result = await verifyTurnstileToken('token-from-widget', {
    secretKey: TURNSTILE_TEST_SECRET_ALWAYS_PASS, fetchImpl,
  });
  assert.deepEqual(result, { ok: false, error: 'verification-invalid' });
});
