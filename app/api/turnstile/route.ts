import { turnstileSecrets } from '@/db/runtime';
import { TURNSTILE_TEST_SITEKEY_ALWAYS_PASS } from '@/lib/turnstile';

/**
 * Serves the Turnstile sitekey to the registration form (#171). The sitekey is public by
 * design — it identifies which challenge to render and is useless without the secret key, which
 * never leaves the server. Unauthenticated on purpose: the form needs it before any account
 * exists. Without an owner-configured key this serves the documented test key, which only ever
 * verifies on this computer (the auth route refuses non-local registration without a real key).
 */
export async function GET() {
  const { siteKey } = turnstileSecrets();
  return Response.json({ sitekey: siteKey || TURNSTILE_TEST_SITEKEY_ALWAYS_PASS });
}
