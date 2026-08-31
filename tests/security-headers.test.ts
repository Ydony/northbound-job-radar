import assert from 'node:assert/strict';
import test from 'node:test';
import nextConfig from '../next.config';

async function cspFor(path: string) {
  const rules = await nextConfig.headers!();
  const header = rules
    .flatMap((rule) => rule.headers)
    .find((entry) => entry.key === 'Content-Security-Policy');
  assert.ok(header, `no CSP configured for ${path}`);
  return header!.value;
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
