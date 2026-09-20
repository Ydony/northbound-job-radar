import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from '@/lib/security-policy';


export function middleware(request: NextRequest) {
  // crypto.randomUUID is available in workerd and in the dev runtime, and is a cryptographically
  // strong source. The nonce must be unguessable and must differ per response, or it is only a
  // longer way of writing 'unsafe-inline'.
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = contentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  /**
   * Document requests only.
   *
   * Static assets are served straight from disk and carry no inline script, so stamping a policy
   * on them costs a nonce generation per file for no gain. Everything else - pages and API routes
   * alike - goes through here, so no route can quietly end up without a policy.
   */
  matcher: ['/((?!assets/|favicon\\.ico|robots\\.txt|manifest\\.webmanifest).*)'],
};
