import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import IndeedStatusPanel from '../app/indeed-status';
import { approvedProfile, configuredVars, createIndeedOperator, decodeSearch, localOrigin,
  INDEED_OPERATOR_SEARCH_TIMEOUT_MS } from '../scripts/indeed-operator.mjs';
import { INDEED_RUNNING_BUDGET } from '../lib/indeed/collection';

const profile = { INDEED_API_KEY: 'a'.repeat(64), INDEED_USER_AGENT: 'Synthetic fixture', INDEED_APP_INFO: 'synthetic=1' };
const result = { added: [{ id: 'synthetic' }], scanned: 25, alreadyKnown: 2,
  run: { sources: [{ sourceKey: 'indeed-nl', status: 'partial' }] } };
test('operator rejects remote targets, credentials in URLs, paths and query strings before fetch', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1.example.com', 'http://user:pass@localhost', 'http://localhost/path', 'http://localhost?key=secret']) {
    assert.throws(() => localOrigin(url));
  }
  assert.equal(localOrigin('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
});
test('operator searches once without readiness or login preflight and returns added jobs', async () => {
  assert.ok(INDEED_OPERATOR_SEARCH_TIMEOUT_MS > INDEED_RUNNING_BUDGET.leaseMs,
    'the operator must not cancel before the final collection lease expires');
  const calls: string[] = [];
  const operator = createIndeedOperator({ baseUrl: 'http://localhost:3001', cookie: 'session=synthetic',
    fetcher: async (url, init) => {
      calls.push(String(url));
      assert.equal(init!.redirect, 'error');
      assert.deepEqual(JSON.parse(init!.body as string), { mode: 'authorized', sourceGroup: 'indeed' });
      assert.equal(new Headers(init!.headers).get('Origin'), 'http://localhost:3001');
      return new Response(JSON.stringify({ type: 'progress' }) + '\n' + JSON.stringify(result));
    } });
  assert.equal((await operator.search()).added[0].id, 'synthetic');
  assert.deepEqual(calls, ['http://localhost:3001/api/scrape']);
});
test('operator refuses truncated/progress-only search streams and never retries HTTP refusals', async () => {
  for (const text of ['', '{}', '{"type":"progress"}', JSON.stringify(result) + '\n{']) assert.throws(() => decodeSearch(text));
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const operator = createIndeedOperator({ baseUrl: 'http://localhost:3001', fetcher: async () => {
      calls++; return new Response('secret upstream body', { status });
    } });
    await assert.rejects(operator.search(), error => !String(error).includes('secret upstream'));
    assert.equal(calls, 1);
  }
});
test('disabled or cooling down sources are not reported as a successful search', async () => {
  const operator = createIndeedOperator({ baseUrl: 'http://localhost', fetcher: async () => Response.json({
    ...result, added: [], run: { sources: [{ sourceKey: 'indeed-nl', status: 'unavailable' }] },
  }) });
  assert.equal((await operator.search()).ok, false);
});
test('setup preserves other secrets, replaces only Indeed config and validates before writing', async () => {
  const vars = configuredVars('SESSION_SECRET=synthetic-session\nOTHER_KEY=keep\nINDEED_ENABLED=false\nINDEED_API_KEY=old\n', profile);
  assert.match(vars, /OTHER_KEY=keep/);
  assert.match(vars, /SESSION_SECRET=synthetic-session/);
  assert.equal(vars.split('INDEED_API_KEY=').length, 2);
  assert.match(vars, /INDEED_ENABLED="true"/);
  assert.throws(() => configuredVars('', { ...profile, INDEED_API_KEY: 'invalid' }));
  const fetched = await approvedProfile(async (url, init) => {
    assert.match(String(url), /^https:\/\/raw.githubuser.*\/fda080a373e8226f3fd60635323f5da9af9892b1\//);
    assert.equal(init!.redirect, 'error');
    return new Response(JSON.stringify({ 'indeed-api-key': profile.INDEED_API_KEY, 'user-agent': profile.INDEED_USER_AGENT, 'indeed-app-info': profile.INDEED_APP_INFO }));
  });
  assert.deepEqual(fetched, profile);
});
test('Indeed button is immediately usable without a separate readiness click', () => {
  const props = {
    search: () => {}, busy: false, roles: ['Data Analyst', 'Master Data'],
    netherlands: true, switzerland: true,
    settings: { nlLocation: 'Amsterdam, Netherlands', nlRadiusKm: 16, chLocation: 'Switzerland', chRadiusKm: 16, updatedAt: '' },
    runSources: [{
      sourceKey: 'indeed-nl', sourceName: 'Indeed Netherlands', country: 'netherlands' as const,
      status: 'complete' as const, rolesSearched: ['Data Analyst'], foundCount: 25, knownCount: 20,
      newCount: 6, importedCount: 5, matchedCount: 3, duplicateCount: 1, skippedCount: 0, message: 'ok',
    }],
    runStartedAt: '2026-09-22T10:00:00.000Z',
  };
  const html = renderToStaticMarkup(createElement(IndeedStatusPanel, props));
  assert.match(html, /Search Indeed only/);
  assert.doesNotMatch(html, /disabled/);
  // First-two-roles label, per-country settings, and the honest run report render.
  assert.match(html, /first two saved roles/);
  assert.match(html, /at most 200 returned/);
  assert.match(html, /800 in total/);
  assert.match(html, /Netherlands place/);
  assert.match(html, /Switzerland distance/);
  assert.match(html, /returned 25/);
  assert.match(html, /new 5/);
  assert.doesNotMatch(html, /new 6/);
  assert.match(html, /matched 3/);
  assert.match(renderToStaticMarkup(createElement(IndeedStatusPanel, { ...props, busy: true })), /disabled/);
  // Ordinary-role rendering never applies here: the parent only mounts this
  // panel for administrators, and the run sources above come from the admin's
  // own latest run.
  const noRoles = renderToStaticMarkup(createElement(IndeedStatusPanel, { ...props, roles: [] }));
  assert.match(noRoles, /no saved roles yet/);
});

test('website and CLI share one authenticated collection route; the panel is admin-only', async () => {
  const radar = await readFile(new URL('../app/job-radar.tsx', import.meta.url), 'utf8');
  // The panel mounts for administrators only. Ordinary accounts never see the
  // source, its configuration, or its history: the server withholds Indeed
  // rows and run sources before aggregation, and the admin preview reads the
  // server's ordinary-audience response instead of subtracting admin rows.
  assert.match(radar, /\{isAdmin && <IndeedStatusPanel/);
  assert.match(radar, /userPreview\?\.collectionTotals/);
  assert.match(radar, /\/api\/state\?preview=user/);
  const state = await readFile(new URL('../app/api/state/route.ts', import.meta.url), 'utf8');
  assert.match(state, /hideIndeedRecords/);
  // Both entry points dispatch the same authorized scrape; there is no second
  // ingestion path or job store.
  assert.match(radar, /findJobs\('authorized', 'indeed'\)/);
  // A second rapid click returns before dispatch: the synchronous ref guard
  // fires before the state-driven disabled button can propagate.
  assert.match(radar, /if \(scrapeBusyRef\.current\) return;/);
  assert.match(radar, /scrapeBusyRef\.current = true;/);
  const operator = await readFile(new URL('../scripts/indeed-operator.mjs', import.meta.url), 'utf8');
  assert.match(operator, /sourceGroup.*indeed/);
  const settingsRoute = await readFile(new URL('../app/api/admin/indeed/settings/route.ts', import.meta.url), 'utf8');
  assert.match(settingsRoute, /adminOnly: true/);
  const adminRoute = await readFile(new URL('../app/api/admin/indeed/route.ts', import.meta.url), 'utf8');
  assert.match(adminRoute, /adminOnly: true/);
});
