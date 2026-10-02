/**
 * Private-response cache policy (T19, PUBLIC_DEPLOYMENT_READINESS "High" row).
 *
 * Every API response that carries account data, a session cookie, or a
 * single-use token must say so on the wire: `Cache-Control: no-store`.
 * Without it a CDN or reverse proxy placed in front of the app is free to
 * serve one account's `/api/state` to the next visitor, or to hand back a
 * cached registration response containing another account's verification
 * token. `Response.json()` sets no cache headers on its own.
 *
 * This module is deliberately pure: it imports nothing, so unit tests can
 * import it directly under Node. `lib/guard.ts` re-exports the helpers for
 * routes, mirroring the `lib/rate-limit.ts` pattern.
 */

export const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;

/**
 * A JSON response that no cache — browser, proxy, or CDN — may store.
 * Drop-in for `Response.json()`: same body/status/headers semantics, plus
 * `cache-control: no-store` merged in (an explicit caller-supplied
 * cache-control still wins, so no call site can silently weaken this).
 */
export function noStoreJson(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return Response.json(data, { ...init, headers });
}

/** Stamps `cache-control: no-store` onto an already-built response. */
export function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
