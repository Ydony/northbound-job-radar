/**
 * A per-request nonce for the Content-Security-Policy (#2).
 *
 * React streams its hydration payload as inline `<script>` tags. Allowing them with
 * `'unsafe-inline'` allows *every* inline script, which is the one thing a script CSP exists to
 * prevent. A nonce allows exactly the tags the server generated and nothing else.
 *
 * The header is set on the **request** as well as the response, because that is where the
 * renderer reads it from: vinext takes the nonce out of the request's `content-security-policy`
 * and stamps it onto the script tags it emits, matching Next.js. Setting it only on the response
 * would produce a policy that blocks the very scripts the page needs.
 *
 * `'strict-dynamic'` is what lets the bootstrap module load the client chunks it imports: a
 * script trusted by nonce may load more, and host-based rules are then ignored by browsers that
 * understand it. `'self'` stays for older browsers that do not.
 *
 * The failure mode if any of this is wrong is a page that renders perfectly and does nothing -
 * no button, form or link works, while direct URLs look fine - and nothing in this repository
 * exercises `app/job-radar.tsx`. So this was verified in a browser against a running server, not
 * inferred from the configuration.
 */
export function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Kept for real: the run progress bar sets its width as an inline style attribute.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}
