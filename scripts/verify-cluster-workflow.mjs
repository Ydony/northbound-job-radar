#!/usr/bin/env node
// Run only on disposable, signup-enabled dev/test state in an isolated checkout.
// Does not fetch external job sites. All accounts and advertisements are synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.IKBENEENAPPEL_VERIFY_URL ?? 'http://127.0.0.1:3000');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Local verification only');
assert.equal(process.env.IKBENEENAPPEL_VERIFY_DISPOSABLE, 'true', 'Explicitly select disposable state');
const run = randomUUID();
const password = `Synthetic-${randomUUID()}!`;

function client() {
  let cookie = '';
  return {
    async request(path, method = 'GET', body, expected = 200) {
      const headers = { Origin: base.origin, ...(cookie ? { Cookie: cookie } : {}) };
      const multipart = body instanceof FormData;
      if (body && !multipart) headers['Content-Type'] = 'application/json';
      const response = await fetch(new URL(path, base), {
        method, headers, body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
      });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      const data = await response.json();
      assert.equal(response.status, expected, `${method} ${path}: ${response.status}`);
      return data;
    },
  };
}

const bootstrap = client();
const owner = client();
const other = client();
const registered = [];
let bootstrapRole;
async function register(connection, name) {
  const result = await connection.request('/api/auth', 'POST', {
    action: 'register', email: `${name}-${run}@example.test`, password,
  });
  registered.push(connection);
  return result.role;
}
const ad = (suffix, postedAt) => ({
  sourceUrl: `https://example.com/jobs/${run}-${suffix}`, title: 'Data Analyst',
  company: `Synthetic ${run}`, location: 'Amsterdam, Netherlands', postedAt,
  description: 'We are looking for a data analyst to work with our international team. You will analyze data, write reports, and work with stakeholders. All meetings and documentation are in English. '.repeat(9),
});

try {
  bootstrapRole = await register(bootstrap, 'bootstrap');
  assert.equal(await register(owner, 'owner'), 'user');
  assert.equal(await register(other, 'other'), 'user');
  await owner.request('/api/criteria', 'PUT', {
    roleKeywords: ['Data Analyst', 'Supply Chain'], requiredKeywords: ['data'], excludedKeywords: ['mandatory Dutch'],
  });
  const first = (await owner.request('/api/jobs', 'POST', ad('first', '2026-09-01'))).job;
  await owner.request(`/api/jobs/${first.id}`, 'PATCH', { isSaved: true, applicationStatus: 'applied' });
  await owner.request(`/api/jobs/${first.id}`, 'PATCH', {
    languageFeedback: 'incorrect', correctedLanguageStatus: 'review', languageFeedbackReason: 'Synthetic correction',
  });
  const copy = (await owner.request('/api/jobs', 'POST', ad('copy', '2026-09-03'))).job;
  assert.notEqual(first.id, copy.id);
  const repost = (await owner.request('/api/jobs', 'POST', ad('repost', '2026-06-01'))).job;
  const otherJob = (await other.request('/api/jobs', 'POST', ad('first', '2026-09-01'))).job;
  assert.notEqual(otherJob.id, first.id);
  const otherBefore = await other.request('/api/state');
  const state = await owner.request('/api/state');
  assert.equal(state.totalJobs, 3);
  assert.equal(state.jobs.length, 2);
  assert.equal(state.hiddenDuplicates, 1);
  assert.ok(state.jobs.some((job) => job.id === repost.id));
  const kept = state.jobs.find((job) => job.id === first.id);
  assert.equal(kept.isSaved, true);
  assert.equal(kept.applicationStatus, 'applied');
  assert.equal(kept.correctedLanguageStatus, 'review');
  assert.equal('profiles' in state, false);
  assert.deepEqual(state.criteria.roleKeywords, ['Data Analyst', 'Supply Chain']);
  assert.deepEqual((await other.request('/api/state')).jobs, otherBefore.jobs);
  await other.request(`/api/jobs/${first.id}`, 'PATCH', { isSaved: false }, 404);
  await other.request(`/api/jobs/${first.id}`, 'DELETE');
  assert.ok((await owner.request('/api/state')).jobs.find((job) => job.id === first.id)?.isSaved);
  await owner.request(`/api/jobs/${first.id}`, 'PATCH', { visibilityStatus: 'dismissed' });
  const repeated = await owner.request('/api/jobs', 'POST', ad('first', '2026-09-01'));
  assert.equal(repeated.dismissed, true);
  const dismissed = (await owner.request('/api/state')).jobs.find((job) => job.id === first.id);
  assert.equal(dismissed.visibilityStatus, 'dismissed');
  assert.equal(dismissed.correctedLanguageStatus, 'review');
  assert.equal(dismissed.isSaved, true);
  assert.equal(dismissed.applicationStatus, 'applied');
  console.log(JSON.stringify({ ok: true, base: base.origin, checks: [
    'fresh schema', 'two ordinary accounts', 'criteria', 'duplicate folding',
    'distinct repost retained', 'saved/applied/correction preserved', 'owner isolation',
    'cross-account mutations refused', 'dismissal survives repeated import',
  ] }));
} finally {
  for (const connection of registered.reverse()) {
    // The initial admin is retained only in this disposable checkout; last-admin deletion is forbidden.
    if (connection === bootstrap && bootstrapRole === 'admin') continue;
    await connection.request('/api/account', 'DELETE', { currentPassword: password, confirm: 'DELETE' });
  }
}
