#!/usr/bin/env node
/**
 * T21 — Phone-viewport signup/settings/source-status walkthrough (F6).
 *
 * What already exists, and what this adds:
 *
 * - `scripts/check-visual.mjs` measures the signed-in dashboard in a real browser at 390px
 *   (no sideways scroll, 44px tap floor, 12px type floor, type ladder). It only visits `/`.
 * - `scripts/verify-dev-workflow.mjs` step 7 changes email/password and step 8 renders every
 *   page with HTTP 200, but at no viewport and with no layout or role-gating assertions.
 * - `tests/source-access.test.ts`, `tests/public-admin-isolation.test.ts` and
 *   `tests/source-policies.test.ts` pin the administrator/ordinary source-status split.
 *
 * This script is the missing walkthrough for the other half of F6: signup, settings and source
 * status, exercised end to end with disposable synthetic accounts while requesting every page
 * with a phone user agent. It asserts what is assertable without a layout engine — the signup
 * refusals and successes, the settings change with session revocation, the administrator-only
 * source-status gating in the served `/sources` HTML, and that every page in the flow serves a
 * phone viewport meta tag with its controls present. It performs no real search and touches no
 * production system; the search/results phone flows stay with `check:visual` and the dashboard
 * harness, and the owner's real-phone pass is `docs/PHONE_CHECKLIST.md`.
 *
 * Layout at 390px for these pages is covered by `npm run check:visual` on a machine with
 * Chrome or Edge (this container has neither) plus the owner's actual-phone checklist. Nothing
 * here needs a browser: plain `fetch` with a phone UA is the whole transport, which is itself
 * the "no local PC dependency" point — every step below works from any phone browser.
 *
 * Usage (needs a local server in another terminal):
 *
 *   npm run dev                      # :3000, own empty database
 *   npm run verify:phone
 *
 * `IKBENEENAPPEL_VERIFY_URL` overrides the target. Loopback only: this registers accounts.
 */

import { randomBytes } from 'node:crypto';

/** The phone this walkthrough pretends to be: a current iPhone Safari UA. */
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const baseUrl = process.env.IKBENEENAPPEL_VERIFY_URL ?? 'http://127.0.0.1:3000';
const parsedBase = new URL(baseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedBase.hostname)) {
  throw new Error('The phone walkthrough refuses to run against a non-local URL.');
}
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
      // Every page in this walkthrough is requested as a phone. The app serves the same HTML
      // to all user agents (no UA sniffing), so a 200 here is evidence the flow is reachable
      // from a phone browser rather than only from a desktop one.
      headers.set('User-Agent', PHONE_UA);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0];
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      let data = text;
      if (contentType.includes('application/json')) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { response, data, text };
    },
  };
}

async function expectStatus(result, status, label) {
  assert(result.response.status === status,
    `${label}: expected ${status}, received ${result.response.status}: ${result.text.slice(0, 200)}`);
  return result.data;
}

async function register(client, email, password) {
  const result = await client.request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email, password }),
  });
  if (result.response.status === 429) {
    console.log('SKIPPED: registration is rate limited (5 per 15 minutes per IP, HTTP 429).');
    console.log('Nothing was measured. Wait for the window to clear and run this again.');
    process.exit(2);
  }
  if (result.response.status === 403) {
    // Registration is open on dev and closed on test; say which it is rather than failing blind.
    console.log('SKIPPED: registration is closed on this installation (HTTP 403).');
    console.log('This walkthrough needs an environment with registration open, which is dev');
    console.log('(ALLOW_SIGNUPS=true). Nothing was measured.');
    process.exit(2);
  }
  const data = await expectStatus(result, 200, `register ${email}`);
  if (data.verificationRequired) {
    // Local environments configure no email sender, so registration hands the token back on
    // loopback instead of sending it. Confirming here exercises the verification link a phone
    // user would follow from their email app.
    assert(typeof data.verificationToken === 'string' && data.verificationToken.length > 0,
      'Local registration without a sender must hand back a verification token.');
    const confirmed = await client.request(`/api/auth/verify?token=${encodeURIComponent(data.verificationToken)}`);
    await expectStatus(confirmed, 200, `verify ${email}`);
  }
  return data;
}

/**
 * Take the first-account slot when the database is empty, so the account that follows is an
 * ordinary user. On an already-populated environment this is just another disposable user.
 */
async function bootstrapIfEmpty(client, email, password) {
  const result = await client.request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email, password }),
  });
  if (result.response.status === 429) {
    console.log('SKIPPED: registration is rate limited (5 per 15 minutes per IP, HTTP 429).');
    process.exit(2);
  }
  if (result.response.status === 403) {
    console.log('SKIPPED: registration is closed on this installation (HTTP 403).');
    console.log('This walkthrough needs an environment with registration open, which is dev');
    console.log('(ALLOW_SIGNUPS=true). Nothing was measured.');
    process.exit(2);
  }
  if (result.response.status !== 200) {
    console.log('      (environment already has accounts)');
    return null;
  }
  if (result.data?.role === 'admin') {
    console.log('      (empty database: claimed the administrator slot)');
    return result.data;
  }
  if (result.data?.verificationRequired && typeof result.data.verificationToken === 'string') {
    await client.request(`/api/auth/verify?token=${encodeURIComponent(result.data.verificationToken)}`);
  }
  return result.data;
}

async function roleOf(client, label) {
  const account = await expectStatus(await client.request('/api/account'), 200, `read ${label} role`);
  assert(account.account?.role === 'admin' || account.account?.role === 'user',
    `${label} has no readable role.`);
  return account.account.role;
}

/** A page in the phone flow must render for a phone UA with a viewport tag and its controls. */
async function expectPhonePage(client, path, landmarks, label) {
  const result = await client.request(path);
  await expectStatus(result, 200, `render ${label} for a phone`);
  const html = result.text;
  assert(html.includes('name="viewport"') && html.includes('width=device-width'),
    `${label} serves no phone viewport meta tag — a phone would render it at desktop width.`);
  assert(html.length > 500, `${label} returned an implausibly small page (${html.length} chars).`);
  for (const landmark of landmarks) {
    assert(html.includes(landmark),
      `${label} rendered without its expected control (${JSON.stringify(landmark)}).`);
  }
  return html;
}

async function deleteSelf(client, password, label) {
  const result = await client.request('/api/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: password, confirm: 'DELETE' }),
  });
  if (result.response.status === 409) {
    // The sole administrator cannot delete itself; that guard is the point, not a failure.
    console.log(`      (${label} is the only administrator, so it stays; the guard held)`);
    return false;
  }
  await expectStatus(result, 200, `delete ${label}`);
  return true;
}

async function main() {
  const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const password = `Local-only-${randomBytes(16).toString('base64url')}!`;
  const checks = [];
  const bootstrap = session();
  const user = session();

  console.log('1/6 Registering disposable accounts as a phone would...');
  const bootstrapped = await bootstrapIfEmpty(bootstrap, `phone-bootstrap-${runId}@example.test`, password);
  await register(user, `phone-user-${runId}@example.test`, password);
  const userRole = await roleOf(user, 'phone user');
  assert(userRole === 'user', `The phone walkthrough account must be ordinary, got ${userRole}.`);
  checks.push('phone-UA registration and email verification');
  let admin = null;
  if (bootstrapped?.role === 'admin') {
    admin = bootstrap;
    checks.push('empty database: administrator slot claimed deliberately');
  } else {
    const bootstrapRole = bootstrapped ? await roleOf(bootstrap, 'bootstrap account') : null;
    if (bootstrapRole === 'admin') admin = bootstrap;
  }
  if (!admin) console.log('      (no administrator session: the admin half of step 4 is skipped)');

  // Passwords as currently known, so cleanup below can delete even when the run dies midway.
  let userPassword = password;
  let userGone = false;
  let adminGone = false;
  try {
  console.log('2/6 Exercising the signup refusals a phone form must surface...');
  const weak = await user.request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email: `phone-weak-${runId}@example.test`, password: 'short' }),
  });
  assert(weak.response.status === 400, `A short password must be refused, got ${weak.response.status}.`);
  const wrongPassword = await session().request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email: `phone-user-${runId}@example.test`, password: `Wrong-${password}` }),
  });
  assert(wrongPassword.response.status === 401, `A wrong password must be refused, got ${wrongPassword.response.status}.`);
  const reset = await session().request('/api/auth/password-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `phone-user-${runId}@example.test` }),
  });
  await expectStatus(reset, 200, 'password-reset request');
  checks.push('weak-password refusal, wrong-password refusal, reset request');

  console.log('3/6 Rendering every page of the flow for a phone user agent...');
  const signedOut = session();
  await expectPhonePage(signedOut, '/login',
    ['Need an account? Register', 'Ik ben een appel'], 'signed-out signup/sign-in');
  checks.push('signed-out /login renders with viewport tag and mode switch');
  // The dashboard is a client component: over plain HTTP it serves the session-gated shell
  // (`Checking your session…`) and the content loads from `/api/state` after hydration. What a
  // phone transport must prove is the shell plus the data endpoint; the rendered cards at 390px
  // are `npm run check:visual` on a machine with a browser, plus the actual-phone checklist.
  await expectPhonePage(user, '/',
    ['Checking your session'], 'signed-in dashboard shell');
  const state = await user.request('/api/state');
  const stateBody = await expectStatus(state, 200, 'dashboard data for a phone');
  assert(Array.isArray(stateBody.jobs) && stateBody.criteria !== undefined,
    'The dashboard data endpoint did not return jobs and criteria for the phone session.');
  checks.push('dashboard shell and its data endpoint serve a phone session');
  await expectPhonePage(user, '/settings',
    ['Email and password', 'Delete this account'], 'settings (email/password + delete)');
  await expectPhonePage(user, '/privacy',
    ['Privacy and GDPR'], 'privacy notice');
  checks.push('settings and privacy render with viewport tag and controls');

  console.log('4/6 Confirming source status shows only public controls to an ordinary phone...');
  // The one 'Open public pages' policy is itself administrator-only, so an ordinary account
  // sees neither that group nor 'Restricted sites' — only the public groups remain.
  const userSources = await expectPhonePage(user, '/sources',
    ['Where the jobs', 'Authorized APIs'], 'ordinary source status');
  assert(!userSources.includes('<h2>Restricted sites</h2>'),
    'An ordinary account was shown the Restricted-sites section it can neither trigger nor benefit from.');
  checks.push('ordinary /sources omits administrator-only status');
  if (admin) {
    const adminRole = await roleOf(admin, 'administrator');
    assert(adminRole === 'admin', 'The administrator session lost its role.');
    const adminSources = await expectPhonePage(admin, '/sources',
      ['Where the jobs', '<h2>Restricted sites</h2>', '<h2>Open public pages</h2>'], 'administrator source status');
    assert(adminSources.includes('Restricted sites'), 'The administrator source status did not render.');
    checks.push('administrator /sources shows the extra-source status');
  }

  console.log('5/6 Changing email and password from Settings as the phone user would...');
  const staleCookie = user.cookie;
  const changedPassword = `Changed-${randomBytes(16).toString('base64url')}!`;
  const changedEmail = `phone-changed-${runId}@example.test`;
  const accountChange = await user.request('/api/account', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: password, newEmail: changedEmail, newPassword: changedPassword }),
  });
  await expectStatus(accountChange, 200, 'change account credentials');
  userPassword = changedPassword;
  // A new address must be verified before it can sign in again — the same rule as registration.
  // Locally the token comes back in the PATCH response; on the phone it arrives by email and the
  // user follows the link from their email app. Either way the link must be followed first.
  if (accountChange.data?.verificationToken) {
    const followLink = await session().request(
      `/api/auth/verify?token=${encodeURIComponent(accountChange.data.verificationToken)}`);
    await expectStatus(followLink, 200, 'verify the new address');
  }
  const staleResponse = await fetch(`${baseUrl}/api/account`, {
    headers: { Origin: origin, Cookie: staleCookie, 'User-Agent': PHONE_UA },
  });
  assert(staleResponse.status === 401,
    `Stale session remained valid after password change (${staleResponse.status}).`);
  const relogin = await session().request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email: changedEmail, password: changedPassword }),
  });
  await expectStatus(relogin, 200, 'sign in with the new credentials');
  checks.push('settings email/password change, new-address verification, stale-session revocation, re-sign-in');

  console.log('6/6 Deleting the disposable accounts...');
  userGone = await deleteSelf(user, userPassword, 'phone user');
  if (admin) adminGone = await deleteSelf(admin, password, 'bootstrap administrator');
  checks.push('disposable accounts deleted (sole-administrator guard respected)');
  } finally {
    // A failed run must not leave disposable accounts behind.
    if (!userGone && user.cookie) await deleteSelf(user, userPassword, 'phone user').catch(() => undefined);
    if (admin && !adminGone && admin.cookie) {
      await deleteSelf(admin, password, 'bootstrap administrator').catch(() => undefined);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    environment: baseUrl,
    phoneUserAgent: PHONE_UA,
    adminSourceStatusExercised: Boolean(admin),
    checks,
  }, null, 2));
}

await main();
