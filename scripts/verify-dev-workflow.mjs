#!/usr/bin/env node

import { randomBytes } from 'node:crypto';

const baseUrl = process.env.IKBENEENAPPEL_VERIFY_URL ?? 'http://127.0.0.1:3000';
const parsedBase = new URL(baseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedBase.hostname)) {
  throw new Error('The workflow verifier refuses to run against a non-local URL.');
}

const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const password = `Local-only-${randomBytes(16).toString('base64url')}!`;
const primaryEmail = `workflow-${runId}@example.test`;
const secondaryEmail = `isolation-${runId}@example.test`;
const changedEmail = `changed-${runId}@example.test`;
const origin = parsedBase.origin;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function session() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, options = {}) {
      const headers = new Headers(options.headers);
      headers.set('Origin', origin);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0];
      const contentType = response.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();
      return { response, data };
    },
  };
}

async function expectStatus(result, status, label) {
  assert(result.response.status === status,
    `${label}: expected ${status}, received ${result.response.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function register(client, email) {
  const result = await client.request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email, password }),
  });
  const data = await expectStatus(result, 200, `register ${email}`);
  assert(data.role === 'user', 'A later account must be a non-admin user.');
}

async function uploadCv(client) {
  const cvText = `Data Governance Analyst
Experienced data governance and master data professional focused on data quality, stewardship,
metadata, supply chain processes, stakeholder management, SQL, reporting, and process improvement.
Led cross-functional data-quality initiatives, defined governance controls, documented business
rules, and delivered analysis in English for international teams.`;
  const form = new FormData();
  form.set('slot', 'a');
  form.set('cvText', cvText);
  form.set('file', new File([cvText], 'workflow-cv.txt', { type: 'text/plain' }));
  const result = await client.request('/api/profile', { method: 'POST', body: form });
  const data = await expectStatus(result, 200, 'upload CV');
  assert(data.cv?.slot === 'a', 'CV response did not preserve slot a.');
}

async function saveCriteria(client) {
  const result = await client.request('/api/criteria', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roleOverrideA: 'Data Governance Analyst',
      roleOverrideB: '',
      roleKeywords: ['Master Data', 'Supply Chain', 'Data Analyst'],
      location: '',
      workplace: 'any',
      seniority: 'mid',
      contractType: 'permanent',
      requiredKeywords: [],
      excludedKeywords: ['German required'],
    }),
  });
  const data = await expectStatus(result, 200, 'save criteria');
  assert(data.criteria?.roleKeywords?.length === 3, 'Saved role keywords do not match the request.');
}

function manualJobPayload(suffix, title = 'Data Governance Analyst') {
  return {
    sourceUrl: `https://example.com/jobs/${runId}-${suffix}`,
    title,
    company: 'Local Workflow Test Company',
    location: 'Amsterdam, Netherlands',
    postedAt: '2026-08-31',
    description: `We are hiring a ${title} to improve enterprise data quality, metadata, master
data controls, governance processes, reporting, stakeholder collaboration, and supply-chain data.
The working language is English. Dutch is useful but entirely optional and is not required. This
is a permanent role in an international team where all meetings, documentation, and collaboration
are conducted in English. Candidates will define standards, analyze quality issues, facilitate
workshops, and deliver measurable improvements across business functions.`,
  };
}

async function importJob(client, suffix, title) {
  const result = await client.request('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manualJobPayload(suffix, title)),
  });
  return expectStatus(result, 200, `import job ${suffix}`);
}

async function patchJob(client, id, body, label, expectedStatus = 200) {
  const result = await client.request(`/api/jobs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return expectStatus(result, expectedStatus, label);
}

async function deleteSelf(client, accountPassword) {
  const result = await client.request('/api/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: accountPassword, confirm: 'DELETE' }),
  });
  await expectStatus(result, 200, 'delete disposable account');
}

const primary = session();
const secondary = session();
let primaryPassword = password;
let primaryDeleted = false;
let secondaryDeleted = false;

try {
console.log('1/10 Registering two disposable non-admin accounts...');
await register(primary, primaryEmail);
await register(secondary, secondaryEmail);

console.log('2/10 Uploading a new CV and saving new criteria...');
await uploadCv(primary);
await saveCriteria(primary);

console.log('3/10 Exercising authorized and refused restricted search modes...');
const authorizedSearch = await primary.request('/api/scrape', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'authorized' }),
});
const authorizedData = await expectStatus(authorizedSearch, 200, 'authorized search');
assert(Array.isArray(authorizedData.run?.sources), 'Authorized search did not return per-source results.');
const restrictedSearch = await primary.request('/api/scrape', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'all' }),
});
await expectStatus(restrictedSearch, 403, 'non-admin restricted search');

console.log('4/10 Exercising save, apply, dismiss, restore, and language correction...');
const imported = await importJob(primary, 'primary');
const primaryJobId = imported.job.id;
await patchJob(primary, primaryJobId, { isSaved: true }, 'save job');
await patchJob(primary, primaryJobId, { applicationStatus: 'applied' }, 'mark applied');
await patchJob(primary, primaryJobId, { visibilityStatus: 'dismissed' }, 'dismiss job');
await patchJob(primary, primaryJobId, { visibilityStatus: 'active' }, 'restore job');
await patchJob(primary, primaryJobId, {
  languageFeedback: 'incorrect',
  correctedLanguageStatus: 'review',
  languageFeedbackReason: 'Local workflow correction',
}, 'correct language verdict');

console.log('5/10 Confirming per-owner identity and cross-account isolation...');
const sameUrlForSecondary = await secondary.request('/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(manualJobPayload('primary')),
});
await expectStatus(sameUrlForSecondary, 400, 'secondary import without CV');
await uploadCv(secondary);
const secondaryImport = await secondary.request('/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(manualJobPayload('primary')),
});
const secondaryJob = await expectStatus(secondaryImport, 200, 'same URL for second owner');
assert(secondaryJob.job.id !== primaryJobId, 'The same source URL was not isolated per owner.');
await patchJob(secondary, primaryJobId, { isSaved: false }, 'cross-account patch', 404);
await expectStatus(await secondary.request(`/api/jobs/${primaryJobId}`, { method: 'DELETE' }), 200,
  'cross-account delete response');
const primaryStateAfterAttack = await expectStatus(await primary.request('/api/state'), 200,
  'owner state after cross-account delete');
assert(primaryStateAfterAttack.jobs.some((job) => job.id === primaryJobId),
  'A cross-account delete removed the owner job.');

console.log('6/10 Exercising job deletion and confirming safe state export shape...');
const disposableJob = await importJob(primary, 'delete', 'Master Data Analyst');
await expectStatus(await primary.request(`/api/jobs/${disposableJob.job.id}`, { method: 'DELETE' }), 200,
  'delete own job');
const exportState = await expectStatus(await primary.request('/api/state'), 200, 'read export state');
assert(!JSON.stringify(exportState).includes('cvText') && !JSON.stringify(exportState).includes('objectKey'),
  'State exposed private CV text or its object key.');
JSON.stringify(exportState);

console.log('7/10 Exercising email/password change and session revocation...');
const staleCookie = primary.cookie;
const changedPassword = `Changed-${randomBytes(16).toString('base64url')}!`;
const accountChange = await primary.request('/api/account', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ currentPassword: primaryPassword, newEmail: changedEmail, newPassword: changedPassword }),
});
await expectStatus(accountChange, 200, 'change account credentials');
primaryPassword = changedPassword;
const staleResponse = await fetch(`${baseUrl}/api/account`, {
  headers: { Origin: origin, Cookie: staleCookie },
});
assert(staleResponse.status === 401, `Stale session remained valid after password change (${staleResponse.status}).`);

console.log('8/10 Rendering application pages and checking access boundaries...');
for (const path of ['/', '/settings', '/admin', '/sources', '/privacy']) {
  const page = await primary.request(path);
  await expectStatus(page, 200, `render ${path}`);
  assert(typeof page.data === 'string' && page.data.length > 500, `${path} returned an implausibly small page.`);
}
await expectStatus(await primary.request('/api/admin'), 403, 'non-admin API boundary');

console.log('9/10 Resetting each disposable workspace...');
for (const client of [primary, secondary]) {
  const reset = await client.request('/api/workspace', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESET' }),
  });
  await expectStatus(reset, 200, 'reset workspace');
  const state = await expectStatus(await client.request('/api/state'), 200, 'state after reset');
  assert(state.jobs.length === 0 && state.profiles.length === 0,
    'Workspace reset left jobs or CV profiles behind.');
}

console.log('10/10 Deleting the disposable accounts...');
await deleteSelf(secondary, password);
secondaryDeleted = true;
await deleteSelf(primary, primaryPassword);
primaryDeleted = true;

console.log(JSON.stringify({
  ok: true,
  authorizedSourcesReported: authorizedData.run.sources.length,
  checks: [
    'new accounts', 'CV upload', 'criteria', 'authorized search', 'restricted refusal',
    'pipeline states', 'language correction', 'tenant isolation', 'safe export state',
    'credential change', 'session revocation', 'page rendering', 'workspace reset', 'account deletion',
  ],
}, null, 2));
} finally {
  if (!secondaryDeleted && secondary.cookie) {
    await deleteSelf(secondary, password).catch(() => undefined);
  }
  if (!primaryDeleted && primary.cookie) {
    await deleteSelf(primary, primaryPassword).catch(() => undefined);
  }
}
