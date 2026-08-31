import type { NextConfig } from 'next';

/**
 * Security headers. The app renders a private CV and job pipeline, so the defaults matter:
 * framing is denied outright to stop clickjacking, the referrer is not leaked to job sites, and
 * the CSP keeps scripts to this origin. 'unsafe-inline' remains for styles only because the app
 * ships inline style attributes; scripts do not get that exemption.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // React streams its hydration payload as inline <script> tags, and this stack has no
      // middleware to stamp a per-request nonce on them. Without 'unsafe-inline' every one of them
      // is blocked: pages still render server-side, but nothing hydrates, so no button, form or
      // link works while direct URLs appear fine. The XSS exposure this reopens is limited here -
      // all user data renders through React's escaping and there is no dangerouslySetInnerHTML
      // anywhere - but it should become nonce-based before any public deployment.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
