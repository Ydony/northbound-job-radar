import assert from 'node:assert/strict';
import test from 'node:test';
import nextConfig from '../next.config';
import { contentSecurityPolicy } from '../lib/security-policy';

/** The nonce is per request, so tests build a policy with a known one. */
const TEST_NONCE = 'testnonce00000000000000000000000';

async function headerValue(key: string, path: string) {
  const rules = await nextConfig.headers!();
  const header = rules
    .flatMap((rule) => rule.headers)
    .find((entry) => entry.key === key);
  assert.ok(header, `no ${key} configured for ${path}`);
  return header!.value;
}

/**
 * The policy is no longer a static header: it carries a per-request nonce, so middleware.ts
 * builds it. These tests read the same builder the middleware uses, which is the whole reason it
 * lives in lib/ rather than inside the middleware file.
 */
function cspFor() {
  return contentSecurityPolicy(TEST_NONCE);
}

/** Every directive as a name -> value map, so a test can assert on one without regex games. */
function cspDirectives() {
  const entries = cspFor().split(';').map((part) => part.trim()).filter(Boolean);
  return new Map(entries.map((entry) => {
    const [name, ...values] = entry.split(/\s+/);
    return [name, values.join(' ')];
  }));
}

test('React hydrates by nonce, and no inline script is allowed without one', async () => {
  // Without a working allowance the pages still render server-side but nothing hydrates: no
  // button, form or link works, while direct URLs look fine. That failure mode is easy to misread
  // as a browser or ad-blocker problem, so it is pinned here.
  //
  // 'unsafe-inline' allowed every inline script, which is the one thing a script CSP exists to
  // prevent. The nonce allows exactly the tags the server generated. 'strict-dynamic' is what
  // lets the bootstrap module load the chunks it imports.
  const csp = cspFor();
  assert.match(csp, new RegExp(`script-src [^;]*'nonce-${TEST_NONCE}'`));
  assert.match(csp, /script-src [^;]*'strict-dynamic'/);
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/);
});

test('every response carries a different nonce', () => {
  // A fixed nonce is only a longer way of writing 'unsafe-inline'.
  const first = contentSecurityPolicy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const second = contentSecurityPolicy('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.notEqual(first, second);
  assert.match(first, /'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'/);
});

test('the static config no longer sends a policy of its own', async () => {
  // Two policies means a browser enforces the intersection, so a leftover static header would
  // silently block the very scripts the nonce policy allows.
  const rules = await nextConfig.headers!();
  const stray = rules.flatMap((rule) => rule.headers)
    .find((entry) => entry.key === 'Content-Security-Policy');
  assert.equal(stray, undefined, 'next.config.ts must not also send a Content-Security-Policy');
});

test('the CSP still denies framing, foreign form posts and plugins', async () => {
  const csp = cspFor();
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test('images may come only from this origin or a data URI', async () => {
  // This was "'self' data: https:", which permitted an image from anywhere on the web. Nothing
  // loads a remote image, so the allowance bought nothing and widened what an injection could
  // reach — an exfiltration channel, since the URL of a blocked-looking image is still requested.
  const directives = cspDirectives();
  assert.equal(directives.get('img-src'), "'self' data:");
});

test('the directives with no legitimate use here are closed, not merely absent', async () => {
  // default-src covers an omitted directive, but only for the fetch directives. Naming them makes
  // the intent readable and survives a future default-src being loosened.
  const directives = cspDirectives();
  // frame-src admits exactly the Turnstile challenge host (#171) and nothing else; see the
  // Turnstile test below for why that allowance exists.
  assert.equal(directives.get('frame-src'), 'https://challenges.cloudflare.com');
  assert.equal(directives.get('media-src'), "'none'");
  assert.equal(directives.get('object-src'), "'none'");
  assert.equal(directives.get('worker-src'), "'self'");
  assert.equal(directives.get('font-src'), "'self'");
  assert.equal(directives.get('connect-src'), "'self'");
});

test('the Turnstile allowance is exactly the challenge host, nowhere else', async () => {
  // The registration bot check loads its widget script from Cloudflare and runs its challenge in
  // that host's frame. Both allowances name the host outright — no scheme wildcards, no
  // additional hosts — and framing of this app by anyone stays denied (frame-ancestors).
  const directives = cspDirectives();
  assert.equal(directives.get('frame-src'), 'https://challenges.cloudflare.com');
  assert.match(cspFor(), /script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(cspFor(), /frame-ancestors 'none'/);
});

test('the origin is isolated from anything that opens or embeds it', async () => {
  assert.equal(await headerValue('Cross-Origin-Opener-Policy', '/'), 'same-origin');
  assert.equal(await headerValue('Cross-Origin-Resource-Policy', '/'), 'same-origin');
  assert.equal(await headerValue('X-Permitted-Cross-Domain-Policies', '/'), 'none');
});

test('device capabilities the app never uses are denied outright', async () => {
  const policy = await headerValue('Permissions-Policy', '/');
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'bluetooth',
    'display-capture', 'idle-detection']) {
    assert.match(policy, new RegExp(`${feature}=\(\)`), `${feature} is not denied`);
  }
});

test('the dashboard is covered, not just every path but the root', async () => {
  // '/:path*' did not match the bare '/' in this runtime, which once left the page holding the
  // whole job pipeline with no security headers at all while every other route had them.
  const rules = await nextConfig.headers!();
  const sources = rules.map((rule) => rule.source);
  assert.ok(sources.includes('/'), 'the root has no explicit header rule');
  assert.ok(sources.includes('/:path*'), 'non-root paths have no header rule');
});
