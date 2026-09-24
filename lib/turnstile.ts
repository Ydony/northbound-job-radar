/**
 * Cloudflare Turnstile bot protection for registration (INT-14b, #171).
 *
 * The sitekey is public and safe to commit; the secret key never is — the owner sets the real
 * one with `wrangler secret put TURNSTILE_SECRET_KEY --name ikbeneenappel-prod`, and this module
 * only ever reads it from the environment. Dev and test use Turnstile's documented test
 * credentials (always-pass / always-fail), and unit tests inject a mocked fetch so no test ever
 * touches the real verification endpoint.
 *
 * Test credentials: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 *
 * Workers-compatible by construction: global fetch only, no Node APIs.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// Documented test sitekeys. The always-pass key renders a widget that succeeds without
// interaction; the always-fail key renders one that always fails. Public values.
export const TURNSTILE_TEST_SITEKEY_ALWAYS_PASS = '1x00000000000000000000AA';
export const TURNSTILE_TEST_SITEKEY_ALWAYS_FAIL = '2x00000000000000000000AB';

// Documented test secrets, matching the sitekeys above. The always-pass secret accepts any token
// the always-pass widget produces; the always-fail secret rejects everything.
export const TURNSTILE_TEST_SECRET_ALWAYS_PASS = '1x0000000000000000000000000000000AA';
export const TURNSTILE_TEST_SECRET_ALWAYS_FAIL = '2x0000000000000000000000000000000AA';

export interface TurnstileFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface TurnstileVerification {
  ok: boolean;
  error?: string;
}

interface SiteverifyResponse {
  success?: boolean;
  'error-codes'?: unknown;
}

/**
 * Verifies a Turnstile token against Cloudflare's siteverify endpoint.
 *
 * Fails **closed**: a missing token, a missing secret, an unreachable endpoint, or an
 * unreadable answer all verify as not-ok, never as ok. A bot check that passes when the
 * checker is down is not a check.
 */
export async function verifyTurnstileToken(
  token: unknown,
  options: {
    secretKey: string;
    remoteIp?: string;
    fetchImpl?: TurnstileFetch;
    verifyUrl?: string;
  },
): Promise<TurnstileVerification> {
  const { secretKey, remoteIp } = options;
  if (typeof token !== 'string' || token.length === 0) return { ok: false, error: 'missing-token' };
  if (!secretKey) return { ok: false, error: 'missing-secret' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const verifyUrl = options.verifyUrl ?? TURNSTILE_VERIFY_URL;
  let response: Response;
  try {
    response = await fetchImpl(verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: secretKey, response: token, remoteip: remoteIp ?? undefined }),
    });
  } catch {
    return { ok: false, error: 'verification-unreachable' };
  }
  let body: SiteverifyResponse;
  try {
    body = (await response.json()) as SiteverifyResponse;
  } catch {
    return { ok: false, error: 'verification-invalid' };
  }
  if (body?.success === true) return { ok: true };
  const codes = Array.isArray(body?.['error-codes'])
    ? (body['error-codes'] as unknown[]).map(String).join(',')
    : '';
  return { ok: false, error: codes ? `verification-failed:${codes}` : 'verification-failed' };
}

/** Minimal shape of the Turnstile client widget used by the registration form. */
export interface TurnstileWidget {
  render(element: HTMLElement, options: {
    sitekey: string;
    callback?: (token: string) => void;
    'expired-callback'?: () => void;
    'error-callback'?: () => void;
  }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileWidget;
  }
}
