import assert from 'node:assert/strict';
import test from 'node:test';
import nextConfig from '../next.config';

async function headerValue(key: string, path: string) {
  const rules = await nextConfig.headers!();
  const header = rules
    .flatMap((rule) => rule.headers)
    .find((entry) => entry.key === key);
  assert.ok(header, `no ${key} configured for ${path}`);
  return header!.value;
}

async function cspFor(path: string) {
  return headerValue('Content-Security-Policy', path);
}

/** Every directive as a name -> value map, so a test can assert on one without regex games. */
async function cspDirectives(path = '/') {
  const entries = (await cspFor(path)).split(';').map((part) => part.trim()).filter(Boolean);
  return new Map(entries.map((entry) => {
    const [name, ...values] = entry.split(/\s+/);
    return [name, values.join(' ')];
  }));
}

test('the CSP allows the inline scripts React needs to hydrate', async () => {
  // Without this the pages still render server-side but nothing hydrates: no button, form or
  // link works, while direct URLs look fine. That failure mode is easy to misread as a browser
  // or ad-blocker problem, so it is pinned here.
  const csp = await cspFor('/');
  assert.match(csp, /script-src [^;]*'unsafe-inline'/);
});

test('the CSP still denies framing, foreign form posts and plugins', async () => {
  const csp = await cspFor('/');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test('images may come only from this origin or a data URI', async () => {
  // This was "'self' data: https:", which permitted an image from anywhere on the web. Nothing
  // loads a remote image, so the allowance bought nothing and widened what an injection could
  // reach — an exfiltration channel, since the URL of a blocked-looking image is still requested.
  const directives = await cspDirectives();
  assert.equal(directives.get('img-src'), "'self' data:");
});

test('the directives with no legitimate use here are closed, not merely absent', async () => {
  // default-src covers an omitted directive, but only for the fetch directives. Naming them makes
  // the intent readable and survives a future default-src being loosened.
  const directives = await cspDirectives();
  assert.equal(directives.get('frame-src'), "'none'");
  assert.equal(directives.get('media-src'), "'none'");
  assert.equal(directives.get('object-src'), "'none'");
  assert.equal(directives.get('worker-src'), "'self'");
  assert.equal(directives.get('font-src'), "'self'");
  assert.equal(directives.get('connect-src'), "'self'");
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
