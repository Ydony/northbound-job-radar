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
  {
    key: 'Permissions-Policy',
    value: [
      'camera=()', 'microphone=()', 'geolocation=()', 'interest-cohort=()',
      // Nothing here uses any of these, and a private job pipeline is a bad place to leave a
      // capability enabled on the chance that something might want it later.
      'payment=()', 'usb=()', 'serial=()', 'bluetooth=()', 'midi=()',
      'display-capture=()', 'idle-detection=()', 'local-fonts=()',
    ].join(', '),
  },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  // Isolates this origin from anything that opens it or embeds its resources. The app holds one
  // person's job pipeline; nothing outside it has a reason to reach in.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  // The Content-Security-Policy is NOT here any more. It carries a per-request nonce, which a
  // static config cannot produce, so it is built in middleware.ts. Adding one back here would
  // send two policies, and a browser enforces the intersection - the nonce policy would still
  // apply, but so would whatever was left here, which is how a header that looks harmless ends
  // up blocking hydration.
];

const nextConfig: NextConfig = {
  async headers() {
    // '/:path*' did not match the bare '/' in this runtime, which left the dashboard - the page
    // holding every job and both CVs - with no security headers at all while every other route had
    // them. Match the root explicitly rather than relying on the pattern.
    return [
      { source: '/', headers: securityHeaders },
      { source: '/:path*', headers: securityHeaders },
    ];
  },
};

export default nextConfig;
