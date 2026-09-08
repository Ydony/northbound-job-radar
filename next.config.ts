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
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // React streams its hydration payload as inline <script> tags. Without 'unsafe-inline'
      // every one of them is blocked: pages still render server-side, but nothing hydrates, so
      // no button, form or link works while direct URLs appear fine.
      //
      // The earlier note here said this stack "has no middleware to stamp a per-request nonce".
      // That is not true of vinext 1.0.0-beta.3, whose own capability check reports middleware as
      // supported, so a nonce is a real option and the reason to keep 'unsafe-inline' is now a
      // different one: the failure mode is a page that renders perfectly and does nothing, and
      // nothing in this repository exercises app/job-radar.tsx. See #2 — the switch is held until
      // it can be verified in a browser, not because it cannot be done.
      //
      // The exposure this reopens stays limited: all user data renders through React's escaping
      // and there is no dangerouslySetInnerHTML anywhere.
      "script-src 'self' 'unsafe-inline'",
      // Needed for real: the run progress bar sets its width as an inline style attribute.
      "style-src 'self' 'unsafe-inline'",
      // Was "'self' data: https:", which allowed an image from anywhere on the web. Nothing in
      // the app loads a remote image — no <img> with an external src, no next/image, no url()
      // in the stylesheet — so the allowance only widened what an injection could reach.
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
    ].join('; '),
  },
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
