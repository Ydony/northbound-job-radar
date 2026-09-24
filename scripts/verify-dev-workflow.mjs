#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test seams for the local verification harness (#85).
 *
 * `npm run verify:dev` is named in CLAUDE.md as the way to check a change locally, and it has
 * failed on a working app twice — once parsing only `application/json` while `/api/scrape`
 * streams NDJSON, once asserting a removed CV gate. A failing
 * harness looks exactly like a broken app, which trains everyone to skip the check. These pure
 * helpers hold the harness's own assumptions so `tests/verify-harness.test.ts` can check them
 * without needing a live server. They change nothing about what the harness demands.
 */

/** Loopback-only guard shared with the live run below. */
export function isLocalVerifyHostname(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

/**
 * Decode one verifier response body without touching the network.
 *
 * `/api/scrape` streams `application/x-ndjson`: progress events, then the result as the last
 * line. The harness once read that stream as text, found no `run` on a string, and failed on a
 * working app. Progress events are chatter; the outcome is whatever came last that is not one.
 * A truncated final line is not worth failing the run over. Plain JSON still parses as JSON and
 * anything else comes back as text, exactly as the live `session()` below relied on.
 */
export function parseVerifierPayload(contentType, bodyText) {
  const type = contentType ?? '';
  if (type.includes('x-ndjson')) {
    const lines = bodyText.split('\n').map((line) => line.trim()).filter(Boolean);
    let data = {};
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event && event.type !== 'progress') data = event;
      } catch {
        // A truncated final line is not worth failing the run over.
      }
    }
    return data;
  }
  if (type.includes('application/json')) {
    return JSON.parse(bodyText);
  }
  return bodyText;
}

export function isAllowedSecondaryImportStatus(status) {
  return status === 200;
}

/** Per-owner isolation: the same source URL must yield a distinct row per account. */
export function sameUrlIsolatedPerOwner(primaryJobId, secondaryJobId) {
  return Boolean(primaryJobId && secondaryJobId && secondaryJobId !== primaryJobId);
}

/** Export state must never carry legacy CV text or object keys. */
export function exportStateLeaksPrivateFields(serializedState) {
  return serializedState.includes('cvText') || serializedState.includes('objectKey');
}

/** A password change revokes existing sessions at once; the stale cookie must die with a 401. */
export function isStaleSessionRevoked(status) {
  return status === 401;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function session(baseUrl, origin) {
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
      const bodyText = await response.text();
      return { response, data: parseVerifierPayload(contentType, bodyText) };
    },
  };
}

async function expectStatus(result, status, label) {
  assert(result.response.status === status,
    `${label}: expected ${status}, received ${result.response.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function register(client, email, password) {
  const result = await client.request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email, password }),
  });
  const data = await expectStatus(result, 200, `register ${email}`);
  if (data.verificationRequired) {
    // Local environments configure no email sender, so registration hands the token back on
    // loopback instead of sending it. Confirming here exercises the verification flow.
    assert(typeof data.verificationToken === 'string' && data.verificationToken.length > 0,
      'Local registration without a sender must hand back a verification token.');
    const confirmed = await client.request(`/api/auth/verify?token=${encodeURIComponent(data.verificationToken)}`);
    await expectStatus(confirmed, 200, `verify ${email}`);
    return;
  }
  assert(data.role === 'user', 'A later account must be a non-admin user.');
}

async function saveCriteria(client) {
  const result = await client.request('/api/criteria', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
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

function manualJobPayload(runId, suffix, title = 'Data Governance Analyst') {
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

async function importJob(client, runId, suffix, title) {
  const result = await client.request('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manualJobPayload(runId, suffix, title)),
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

async function main() {
  const baseUrl = process.env.IKBENEENAPPEL_VERIFY_URL ?? 'http://127.0.0.1:3000';
  const parsedBase = new URL(baseUrl);
  if (!isLocalVerifyHostname(parsedBase.hostname)) {
    throw new Error('The workflow verifier refuses to run against a non-local URL.');
  }

  const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const password = `Local-only-${randomBytes(16).toString('base64url')}!`;
  const primaryEmail = `workflow-${runId}@example.test`;
  const secondaryEmail = `isolation-${runId}@example.test`;
  const changedEmail = `changed-${runId}@example.test`;
  const origin = parsedBase.origin;

  const primary = session(baseUrl, origin);
  const secondary = session(baseUrl, origin);
  let primaryPassword = password;
  let primaryDeleted = false;
  let secondaryDeleted = false;

  try {
    console.log('1/10 Registering two disposable non-admin accounts...');
    await register(primary, primaryEmail, password);
    await register(secondary, secondaryEmail, password);

    console.log('2/10 Saving new search criteria...');
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
    const imported = await importJob(primary, runId, 'primary');
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
      body: JSON.stringify(manualJobPayload(runId, 'primary')),
    });
    await expectStatus(sameUrlForSecondary, 200, 'same URL for second owner');
    assert(sameUrlIsolatedPerOwner(primaryJobId, sameUrlForSecondary.data.job?.id),
      'The same source URL was not isolated per owner.');
    await patchJob(secondary, primaryJobId, { isSaved: false }, 'cross-account patch', 404);
    // Job deletion was removed on 2026-09-24: a delete wrote no tombstone, so the advert
    // returned on the next search. Dismissal is the durable way to put a job away. The
    // boundary is still worth watching from here — if the route is ever reinstated for a
    // "quick cleanup", this is where the harness notices it is reachable across accounts.
    const goneRoute = await secondary.request(`/api/jobs/${primaryJobId}`, { method: 'DELETE' });
    assert(goneRoute.response.status !== 200,
      `DELETE /api/jobs/:id answered ${goneRoute.response.status}. The route was removed; `
      + 'if it is back, it must refuse another account before anything else.');
    // Ask for the whole collection, not the default page. INT-05 (#164) moved /api/state to
    // server-side paging at 40, and by this point the owner has also run a real authorized
    // search — so the one job this assertion is about had dropped off the first page and the
    // harness reported a cross-account deletion that had not happened. The question here is
    // "does the owner still hold this row", which no default page can answer; 2000 is the
    // route's own JOB_PAGE_MAX, and a dev search stays far below it.
    const primaryStateAfterAttack = await expectStatus(await primary.request('/api/state?limit=2000'), 200,
      'owner state after cross-account delete');
    assert(primaryStateAfterAttack.jobs.some((job) => job.id === primaryJobId),
      'A cross-account delete removed the owner job.');

    console.log('6/10 Exercising dismissal and confirming safe state export shape...');
    const disposableJob = await importJob(primary, runId, 'dismiss', 'Master Data Analyst');
    await patchJob(primary, disposableJob.job.id, { visibilityStatus: 'dismissed' }, 'dismiss own job');
    // The part deletion never did: re-importing the same advertisement must not bring it
    // back. `dismissed_jobs` holds the identity tombstone, so the import reports it as
    // dismissed rather than creating a fresh active card.
    const reimported = await primary.request('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manualJobPayload(runId, 'dismiss', 'Master Data Analyst')),
    });
    await expectStatus(reimported, 200, 're-import a dismissed job');
    assert(reimported.data.dismissed === true,
      'A dismissed advertisement came back as active on re-import — the tombstone did not hold.');
    const exportState = await expectStatus(await primary.request('/api/state?limit=2000'), 200, 'read export state');
    assert(!exportStateLeaksPrivateFields(JSON.stringify(exportState)),
      'State exposed legacy CV text or its object key.');
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
    assert(isStaleSessionRevoked(staleResponse.status),
      `Stale session remained valid after password change (${staleResponse.status}).`);

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
      assert(state.jobs.length === 0 && !('profiles' in state),
        'Workspace reset left jobs or legacy profiles behind.');
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
        'new accounts', 'criteria', 'authorized search', 'restricted refusal',
        'pipeline states', 'language correction', 'tenant isolation', 'dismissal survives re-import',
        'safe export state',
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
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
