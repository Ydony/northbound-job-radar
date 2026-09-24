#!/usr/bin/env node
// Synthetic account/API acceptance; never searches an upstream job site.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseVerifierPayload } from './verify-dev-workflow.mjs';

const base = new URL(process.env.IKBENEENAPPEL_VERIFY_URL ?? 'http://127.0.0.1:3110');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(process.env.IKBENEENAPPEL_VERIFY_DISPOSABLE, 'true', 'Disposable storage required');
const run = randomUUID();
const password = 'Disposable-Indeed-QA-only-2026!';
function client() {
  let cookie = '';
  return { async request(path, method = 'GET', body, expected = 200) {
    const response = await fetch(new URL(path, base), { method, redirect: 'manual',
      headers: { Origin: base.origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${response.status}`);
    return parseVerifierPayload(response.headers.get('content-type'), text);
  } };
}
const bootstrap = client(), owner = client(), other = client();
const registered = [];
const ad = { sourceUrl: `https://nl.indeed.com/viewjob?jk=${run.replaceAll('-', '')}`,
  title: 'Data Analyst', company: `Synthetic QA ${run}`, location: 'Amsterdam, Netherlands',
  postedAt: '2026-09-01', description: 'We are looking for a data analyst to work with our international team. You will analyze data, write reports and work with stakeholders. All meetings and documentation are in English. '.repeat(9) };
async function register(connection, name) {
  const result = await connection.request('/api/auth', 'POST', {
    action: 'register', email: name === 'bootstrap' ? 'indeed-bootstrap@example.test' : `${name}-${run}@example.test`, password });
  registered.push(connection);
  // INT-14a (#170): a new account is unverified and every call it makes answers 401 until the
  // emailed link is followed. No sender is configured locally, so the token comes back on
  // loopback. The role is read from /api/state afterwards because the register response no
  // longer carries one — better to ask than to assert a role this never saw.
  if (result.verificationRequired) {
    assert.ok(result.verificationToken, 'Local registration must hand back a verification token.');
    await connection.request(`/api/auth/verify?token=${encodeURIComponent(result.verificationToken)}`);
    return (await connection.request('/api/state')).account.role;
  }
  return result.role;
}
try {
  const bootstrapRole = process.argv.includes('--reuse-bootstrap')
    ? (await bootstrap.request('/api/auth', 'POST', { action: 'login', email: 'indeed-bootstrap@example.test', password })).role
    : await register(bootstrap, 'bootstrap');
  assert.equal(bootstrapRole, 'admin', 'Use a fresh disposable database');
  assert.equal((await bootstrap.request('/api/admin/indeed')).state, 'disabled', 'No live calls in synthetic verification');
  assert.equal(await register(owner, 'owner'), 'user');
  assert.equal(await register(other, 'other'), 'user');
  const ownerId = (await owner.request('/api/account')).account.id;
  await owner.request('/api/admin/indeed', 'GET', undefined, 403);
  await owner.request('/api/scrape', 'POST', { sourceGroup: 'indeed' }, 403);
  await owner.request('/api/scrape', 'POST', { mode: 'all' }, 403);
  await owner.request('/api/jobs', 'POST', ad, 403);
  await bootstrap.request('/api/admin', 'PATCH', { userId: ownerId, action: 'promote' });
  await owner.request('/api/criteria', 'PUT', { roleKeywords: ['Data Analyst'], searchNetherlands: true, searchSwitzerland: false });
  const search = await owner.request('/api/scrape', 'POST', { mode: 'authorized', sourceGroup: 'indeed' });
  assert.equal(search.run.sources.length, 2);
  const nl = search.run.sources.find(source => source.sourceKey === 'indeed-nl');
  const ch = search.run.sources.find(source => source.sourceKey === 'indeed-ch');
  assert.equal(nl.status, 'disabled');
  assert.equal(nl.foundCount, 0);
  assert.equal(ch.status, 'skipped');
  assert.match(ch.message, /switched off|disabled|not selected/i);
  const first = (await owner.request('/api/jobs', 'POST', ad)).job;
  assert.equal(first.languageStatus, 'pass');
  const publicAd = { ...ad, sourceUrl: `https://example.com/jobs/${run}` };
  const publicJob = (await owner.request('/api/jobs', 'POST', publicAd)).job;
  assert.notEqual(first.id, publicJob.id, 'Private Indeed record must not collapse into public source');
  await owner.request(`/api/jobs/${first.id}`, 'PATCH', { isSaved: true, applicationStatus: 'applied',
    visibilityStatus: 'dismissed', languageFeedback: 'incorrect', correctedLanguageStatus: 'review', languageFeedbackReason: 'Synthetic correction' });
  const repeat = await owner.request('/api/jobs', 'POST', { ...ad, sourceUrl: ad.sourceUrl + '&utm_source=qa' });
  assert.equal(repeat.dismissed, true);
  assert.equal((await owner.request('/api/feedback')).total, 1);
  await other.request(`/api/jobs/${first.id}`, 'PATCH', { isSaved: false }, 404);
  assert.equal((await other.request('/api/state')).totalJobs, 0);
  const otherJob = (await other.request('/api/jobs', 'POST', publicAd)).job;
  assert.notEqual(otherJob.id, publicJob.id);
  await bootstrap.request('/api/admin', 'PATCH', { userId: ownerId, action: 'demote' });
  const publicState = await owner.request('/api/state');
  assert.equal(publicState.totalJobs, 1);
  assert.equal(publicState.jobs[0].id, publicJob.id);
  assert.equal(JSON.stringify(publicState).toLowerCase().includes('indeed'), false, 'State/export/history leaks Indeed metadata');
  assert.equal((await owner.request('/api/feedback')).total, 0);
  await owner.request('/api/admin/indeed', 'GET', undefined, 403);
  // A demoted owner is refused every write to the hidden record. The two delete calls that
  // stood here went with the routes on 2026-09-24; the refusal above is what they proved.
  await owner.request(`/api/jobs/${first.id}`, 'PATCH', { isSaved: false }, 404);
  await bootstrap.request('/api/admin', 'PATCH', { userId: ownerId, action: 'promote' });
  const state = await owner.request('/api/state');
  const kept = state.jobs.find(job => job.id === first.id);
  assert.ok(kept, 'Denied writes must preserve the hidden record');
  assert.equal(kept.isSaved, true);
  assert.equal(kept.applicationStatus, 'applied');
  assert.equal(kept.visibilityStatus, 'dismissed');
  assert.equal(kept.correctedLanguageStatus, 'review');
  assert.equal(JSON.stringify(state).includes('cvText'), false);
  assert.equal(JSON.stringify(state).includes('objectKey'), false);
  await owner.request('/api/workspace', 'DELETE', { confirm: 'RESET' });
  assert.equal((await owner.request('/api/state')).totalJobs, 0);
  assert.equal((await other.request('/api/state')).jobs[0].id, otherJob.id);
  for (const page of ['/', '/settings', '/admin', '/sources', '/privacy', '/login']) await bootstrap.request(page);
  console.log(JSON.stringify({ result: 'passed', base: base.origin, upstreamRequests: 0,
    checks: ['country selection', 'disabled report', 'ordinary-user denial', 'two-account isolation', 'private/public duplicates', 'saved/applied/dismissed/correction retention', 'demotion hides jobs/history/feedback', 'export state', 'reset isolation', 'page HTTP rendering'],
    notTested: ['live upstream', 'browser interaction'] }, null, 2));
} finally {
  // The first administrator remains because the application forbids deleting its last admin.
  for (const connection of registered.filter(item => item !== bootstrap)) {
    await connection.request('/api/account', 'DELETE', { currentPassword: password, confirm: 'DELETE' });
  }
}
