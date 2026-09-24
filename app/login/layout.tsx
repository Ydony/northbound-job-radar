import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { TURNSTILE_SCRIPT_URL } from '@/lib/turnstile';

/**
 * Loads the Turnstile widget script for the sign-in page (#171).
 *
 * The script carries the request nonce because the policy keeps `'strict-dynamic'`, under which
 * a host allowlist alone does not authorize an external script. The nonce is read from the same
 * `content-security-policy` request header the middleware sets for rendering (see
 * lib/security-policy.ts). Without it — script blocked, widget absent — the client shows a bot
 * check error and registration stays disabled rather than silently unprotected.
 */
export default async function LoginLayout({ children }: { children: ReactNode }) {
  const policy = (await headers()).get('content-security-policy') ?? '';
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1] ?? '';
  return (
    <>
      {nonce !== '' && <script src={TURNSTILE_SCRIPT_URL} nonce={nonce} async defer />}
      {children}
    </>
  );
}
