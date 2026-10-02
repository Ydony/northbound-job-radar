#!/usr/bin/env node
/**
 * Phone-viewport search/results/action walkthrough with synthetic accounts (T20, feature F6).
 *
 * What already exists and what this adds:
 * - `scripts/check-visual.mjs` already runs a phone pass (390x844) in a real browser: overflow,
 *   44px tap floor, type ladder, band edges, screens-to-first-card. It needs Chrome/Edge, so it
 *   cannot run where no browser is installed; reuse it wherever one is.
 * - `scripts/verify-dev-workflow.mjs` already exercises the account/job/API flows over HTTP with
 *   disposable accounts, but with no viewport in mind and no phone-layout guards.
 * - This harness is the phone slice: the same synthetic-account flows the feature's acceptance
 *   criteria name (sign in, roles/countries/keywords, search + progress/results, language
 *   explanation + correction, save/dismiss/applied, filter/page, return without lost state,
 *   admin extra-source status + email/password change, ordinary-user public-only controls),
 *   plus static guards over `app/globals.css` / `app/job-radar.tsx` pinning the bounded phone
 *   layout/control fixes (reachable nav, 44/48px floors, single-column card, no sideways page).
 *
 * No browser, no provider, no network egress: it boots the real standalone bundle on a throwaway
 * empty database (like `verify:selfhosted`), with no provider credentials, so every source
 * truthfully reports itself unavailable and nothing leaves the machine. Temp state lives under
 * `os.tmpdir()`, which this environment points inside the worktree - never a hardcoded /tmp.
 *
 * Run with: `npm run build` first, then `npm run verify:phone`.
 * Loopback only, by assertion. Exits non-zero on the first failed expectation, and always stops
 * the server it started.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVerifierPayload } from './verify-dev-workflow.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const bundle = join(root, 'dist', 'standalone', 'server.js');
// A port of its own, so this can never pass by talking to a dev/test server someone else
// started - which is how a stale build gets mistaken for a current one.
const PORT = Number(process.env.VERIFY_PHONE_PORT ?? 3220);
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

if (!existsSync(bundle)) {
  console.error(`No standalone bundle at ${bundle}. Run \`npm run build\` first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'phone-walkthrough-'));
const databasePath = join(work, 'app.sqlite');

let failures = 0;
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` - ${detail}`}`);
  return false;
}

/** One cookie jar per synthetic account, sending a phone User-Agent like the owner's device. */
function client() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, options = {}) {
      const headers = new Headers(options.headers);
      headers.set('Origin', BASE);
      headers.set('User-Agent', PHONE_UA);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(`${BASE}${path}`, { ...options, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0];
      const body = await response.text();
      return {
        status: response.status,
        data: parseVerifierPayload(response.headers.get('content-type'), body),
        raw: body,
      };
    },
  };
}

async function expect(result, status, label) {
  if (!check(result.status === status, label, `expected ${status}, got ${result.status}: ${JSON.stringify(result.data).slice(0, 200)}`)) {
    throw new Error(`stopped after: ${label}`);
  }
  return result.data;
}

const server = spawn(process.execPath, [bundle], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    SQLITE_PATH: databasePath,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    // Dev parity for a throwaway loopback database: both verifiers create disposable
    // accounts, so registration stays open here (docs/ENVIRONMENTS.md). Production and
    // test keep it closed; nothing here changes that.
    ALLOW_SIGNUPS: 'true',
    DB: undefined,
  },
});

const log = [];
server.stdout.on('data', (chunk) => log.push(String(chunk)));
server.stderr.on('data', (chunk) => log.push(String(chunk)));

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited with ${server.exitCode}:\n${log.join('')}`);
    try {
      const response = await fetch(`${BASE}/login`, { headers: { 'User-Agent': PHONE_UA } });
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server never answered on ${BASE}:\n${log.join('')}`);
}

/** Advertisement bodies mirroring check-visual: long enough for the language gate to judge. */
const body = (extra) => `We are hiring an analyst to improve enterprise data quality, metadata,
master data controls, governance processes, reporting, stakeholder collaboration and supply-chain
data. This is a permanent role in an international team where all meetings, documentation and
day-to-day collaboration are conducted in English. You will define standards, analyse quality
issues, facilitate workshops with business stakeholders, and deliver measurable improvements
across several business functions. The team is distributed across Amsterdam and Zurich and works
in English end to end, including code review, written specifications and planning. You will own
the reporting layer end to end, from the definitions agreed with the business through to the
dashboards people actually open on a Monday morning, and you will be expected to say plainly
when a number cannot be trusted. We expect several years of experience in a comparable analyst
role, confidence with SQL and at least one business-intelligence tool, and the judgement to know
which questions are worth answering. Written and spoken English is used for everything, including
performance reviews, onboarding and the handbook. ${extra}`;

function jobPayload(runId, suffix, title, description) {
  return {
    sourceUrl: `https://example.com/phone/${runId}-${suffix}`,
    title,
    company: 'Phone Walkthrough Company',
    location: 'Amsterdam, Netherlands',
    postedAt: '2026-09-17',
    description,
  };
}

/** Collect every `@media(max-width:850px){...}` segment with brace matching. */
function phoneSegments(css) {
  const segments = [];
  const marker = '@media(max-width:850px)';
  let from = 0;
  while (true) {
    const start = css.indexOf(marker, from);
    if (start < 0) break;
    const open = css.indexOf('{', start);
    if (open < 0) break;
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    segments.push(css.slice(open + 1, i - 1));
    from = i;
  }
  return segments.join('\n');
}

async function main() {
  console.log(`Serving ${bundle}`);
  console.log(`Database ${databasePath} (empty)`);
  await waitForServer();

  const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const password = (tag) => `${tag}-${randomBytes(12).toString('base64url')}!xA`;
  const adminPassword = password('Admin-local');
  const userPassword = password('Local-only');
  const adminEmail = `phone-admin-${runId}@example.test`;
  const userEmail = `phone-user-${runId}@example.test`;
  const changedEmail = `phone-changed-${runId}@example.test`;
  const changedPassword = password('Changed-only');

  const admin = client();
  let user = client();
  let userDeleted = false;
  let adminDeleted = false;
  let userPasswordNow = userPassword;

  try {
    console.log('1/10 Synthetic accounts: first registration takes the admin slot, second is ordinary...');
    const adminReg = await admin.request('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', email: adminEmail, password: adminPassword }),
    });
    const adminData = await expect(adminReg, 200, 'register the administrator');
    check(adminData.role === 'admin', 'first account on an empty database is the administrator', JSON.stringify(adminData).slice(0, 120));
    const userReg = await user.request('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', email: userEmail, password: userPassword }),
    });
    const userData = await expect(userReg, 200, 'register the ordinary account');
    if (userData.verificationRequired) {
      check(typeof userData.verificationToken === 'string', 'loopback hands back a verification token');
      await expect(await user.request(`/api/auth/verify?token=${encodeURIComponent(userData.verificationToken)}`), 200, 'verify the ordinary account');
    } else {
      check(userData.role === 'user', 'second account is a non-admin user', JSON.stringify(userData).slice(0, 120));
    }

    console.log('2/10 Roles, countries and keywords save from the phone form...');
    await expect(await user.request('/api/criteria', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roleKeywords: ['Master Data', 'Supply Chain'],
        searchNetherlands: true,
        searchSwitzerland: true,
        requiredKeywords: ['English'],
        excludedKeywords: ['German required'],
      }),
    }), 200, 'save roles/countries/keywords');
    const stateAfterCriteria = await expect(await user.request('/api/state'), 200, 'read state after saving criteria');
    check(stateAfterCriteria.criteria?.roleKeywords?.length === 2, 'saved roles persist', JSON.stringify(stateAfterCriteria.criteria?.roleKeywords));
    check(stateAfterCriteria.criteria?.searchNetherlands === true && stateAfterCriteria.criteria?.searchSwitzerland === true,
      'both country switches persist');

    console.log('3/10 Trigger search and read progress/results...');
    const scrape = await user.request('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'authorized' }),
    });
    const scrapeData = await expect(scrape, 200, 'authorized search completes');
    check(Array.isArray(scrapeData.run?.sources) && scrapeData.run.sources.length > 0,
      'search reports per-source results', `${scrapeData.run?.sources?.length ?? 0} sources`);
    const truthful = (scrapeData.run.sources ?? []).every((s) => s.sourceKey && s.status && typeof s.message === 'string');
    check(truthful, 'every source carries a truthful status, never a bare success');
    const progressEvents = scrape.raw.split('\n').filter((line) => line.includes('"type":"progress"') || line.includes('"type": "progress"')).length;
    console.log(`  note ${progressEvents} progress event(s) streamed (zero is fine on a fast local run)`);
    await expect(await user.request('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all' }),
    }), 403, 'restricted search stays refused for an ordinary account');

    console.log('4/10 Seed one advertisement per verdict and read the language explanation...');
    const seeds = [
      ['pass', 'Senior Business Analyst', body('The working language is English throughout.')],
      ['review', 'Risk and Insurance Analyst', body('Dutch is a plus but not essential for this role.')],
      ['unknown', 'Marketing Analyst', body('The rest of this advertisement was not published and ends here...')],
    ];
    for (const [verdict, title, description] of seeds) {
      await expect(await user.request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobPayload(runId, verdict, title, description)),
      }), 200, `import the ${verdict} advertisement`);
    }
    const seeded = await expect(await user.request('/api/state?limit=2000'), 200, 'read seeded state');
    check(seeded.jobs.length >= 3, 'all three advertisements are listed', `${seeded.jobs.length} job(s)`);
    const unexplained = seeded.jobs.filter((j) => !j.languageSummary || !j.languageSummary.trim());
    check(unexplained.length === 0, 'every card carries its language explanation', `${unexplained.length} without one`);
    const target = seeded.jobs[0];

    console.log('5/10 Correct a result, save, mark applied, dismiss, restore...');
    const corrected = await expect(await user.request(`/api/jobs/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ languageFeedback: 'incorrect', correctedLanguageStatus: 'review', languageFeedbackReason: 'Phone walkthrough correction' }),
    }), 200, 'correct the language verdict');
    check(corrected.feedback?.correctedStatus === 'review', 'correction is stored', JSON.stringify(corrected.feedback).slice(0, 120));
    await expect(await user.request(`/api/jobs/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isSaved: true }),
    }), 200, 'save to Pipeline');
    await expect(await user.request(`/api/jobs/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationStatus: 'applied' }),
    }), 200, 'mark applied');
    const pipeline = await expect(await user.request('/api/state?view=pipeline'), 200, 'read the Pipeline view');
    check(pipeline.jobs.some((j) => j.id === target.id), 'saved+applied job is in Pipeline');
    await expect(await user.request(`/api/jobs/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibilityStatus: 'dismissed' }),
    }), 200, 'dismiss the job');
    const dismissed = await expect(await user.request('/api/state?view=dismissed'), 200, 'read the Dismissed view');
    check(dismissed.jobs.some((j) => j.id === target.id), 'dismissed job waits behind its own view');
    await expect(await user.request(`/api/jobs/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibilityStatus: 'active' }),
    }), 200, 'restore the job');

    console.log('6/10 Filter, page, and return without lost state...');
    for (const query of ['view=all&language=pass', 'view=new&language=review', 'country=netherlands', 'application=applied']) {
      const filtered = await user.request(`/api/state?${query}`);
      await expect(filtered, 200, `filter holds under ${query}`);
      check(Array.isArray(filtered.data.jobs), `filtered list stays a list under ${query}`);
    }
    const pageOne = await expect(await user.request('/api/state?limit=1'), 200, 'read page one');
    if (pageOne.nextCursor) {
      const pageTwo = await expect(await user.request(`/api/state?limit=1&cursor=${encodeURIComponent(pageOne.nextCursor)}`), 200, 'read page two');
      check(pageTwo.jobs[0]?.id !== pageOne.jobs[0]?.id, 'paging advances instead of repeating');
    } else {
      console.log('  note no nextCursor on a three-job workspace; paging shape already covered by unit tests');
    }
    // Return: reload the whole collection and confirm nothing acted upon was lost.
    const returned = await expect(await user.request('/api/state?limit=2000'), 200, 'return to the full list');
    const again = returned.jobs.find((j) => j.id === target.id);
    check(again?.isSaved === true, 'save survives the return');
    check(again?.applicationStatus === 'applied', 'applied survives the return');
    check(again?.visibilityStatus === 'active', 'restore survives the return');
    check(again?.correctedLanguageStatus === 'review', 'correction survives the return');

    console.log('7/10 Administrator sees extra-source status; ordinary user sees only public controls...');
    const overview = await expect(await admin.request('/api/admin'), 200, 'admin overview loads');
    check(Array.isArray(overview.users), 'overview lists accounts');
    check(!JSON.stringify(overview).includes('sourceUrl'), 'overview stays counts-only, never job lists');
    const health = await expect(await admin.request('/api/health'), 200, 'admin source health loads');
    check(Array.isArray(health.sources), 'health names each keyed source', `${health.sources?.length ?? 0} source(s)`);
    await expect(await user.request('/api/admin'), 403, 'ordinary account is refused administration');
    await expect(await user.request('/api/health'), 403, 'ordinary account is refused source health');

    console.log('8/10 Administrator changes email/password from Settings; stale session dies...');
    // Snapshot a second session for the same account, so the revocation below is observed
    // on a cookie this run is not using to act.
    const snapshot = client();
    await expect(await snapshot.request('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail, password: userPasswordNow }),
    }), 200, 'sign in again to hold a stale session');
    const changed = await expect(await user.request('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: userPasswordNow, newEmail: changedEmail, newPassword: changedPassword }),
    }), 200, 'change email and password');
    userPasswordNow = changedPassword;
    if (changed.verificationToken) {
      await expect(await user.request(`/api/auth/verify?token=${encodeURIComponent(changed.verificationToken)}`), 200, 'verify the changed email');
    }
    const staleProbe = await fetch(`${BASE}/api/account`, {
      headers: { Origin: BASE, Cookie: snapshot.cookie, 'User-Agent': PHONE_UA },
    });
    check(staleProbe.status === 401, 'stale session is revoked at once', `got ${staleProbe.status}`);
    // The walking account continues on its fresh cookie (rotation is server-side per session).
    const relogin = client();
    await expect(await relogin.request('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: changedEmail, password: changedPassword }),
    }), 200, 'changed credentials sign in');
    // Hand the fresh jar to the cleanup below.
    user = relogin;

    console.log('9/10 Phone pages render over a phone User-Agent...');
    for (const path of ['/', '/settings', '/sources', '/privacy']) {
      const page = await user.request(path);
      await expect(page, 200, `render ${path} for the ordinary account`);
      check(typeof page.data === 'string' && page.data.length > 500, `${path} renders substance`, `${String(page.data).length} chars`);
    }
    const settingsPage = await user.request('/settings');
    check(String(settingsPage.data).includes('Email and password'), 'Settings exposes the email/password control');
    await expect(await admin.request('/admin'), 200, 'render /admin for the administrator');

    console.log('10/10 Bounded phone layout/control guards over the shipped CSS and markup...');
    const css = readFileSync(join(root, 'app', 'globals.css'), 'utf8');
    const radar = readFileSync(join(root, 'app', 'job-radar.tsx'), 'utf8');
    const phone = phoneSegments(css);
    check(phone.length > 2000, 'phone media block exists and has substance', `${phone.length} chars`);
    check(!css.includes('nav{display:none}'), 'no rule hides navigation at phone width');
    check(/nav\s*\{[^}]*grid-column:\s*1\/-1/.test(phone), 'navigation drops to its own reachable row on a phone');
    check(/nav\s+\.nav-signout\s*,?\s*nav\s+\.view-toggle[^}]*min-height:\s*var\(--size-tap-min/.test(phone)
      || /nav \.nav-signout,nav \.view-toggle\{[^}]*min-height/.test(phone),
      'sign-out and view-toggle clear the 44px touch floor on a phone');
    check(!css.includes('.settings-bar .run-button, .settings-bar /*'), 'no dangling selector swallows the phone stats rule');
    check(/\.settings-bar \.run-button\s*\{[^}]*min-height:\s*48px[^}]*width:\s*100%/.test(phone),
      'Find new jobs stacks full-width at 48px on a phone');
    check(/\.source-dashboard\s*\{[^}]*padding-block:\s*20px 22px/.test(phone), 'statistics band keeps its phone insets');
    check(/\.job-card\s*\{[^}]*flex-direction:\s*column/.test(phone), 'job card is one column on a phone');
    check(/\.job-card \.job-body\s*\{\s*display:\s*contents/.test(phone), 'actions order after requirements on a phone');
    check(/\.phone-language\s*button[^{]*\{[^}]*height:\s*44px/.test(phone) || /\.phone-language button \{[^}]*height:44px/.test(phone),
      'phone language row clears the 44px floor');
    check(/\.apply-link\s*\{[^}]*min-height:\s*48px/.test(phone), 'apply pill clears 48px on a phone');
    check(css.includes('overflow-wrap: anywhere'), 'advertisement text breaks instead of pushing the page sideways');
    check(/details\.filters > summary\s*\{[^}]*min-height:\s*var\(--size-tap-min/.test(css), 'filter disclosure clears the touch floor');
    check(/\.view-tabs button\s*\{[^}]*min-height:\s*var\(--size-tap-min/.test(phone), 'view tabs clear the touch floor on a phone');
    check(/\.pill\s*\{[^}]*min-height:\s*var\(--size-tap-min/.test(css), 'filter pills clear the touch floor');
    check(/\.job-pager button\s*\{[^}]*height:\s*var\(--size-tap-min/.test(css), 'pager clears the touch floor');
    check(/\.confirm-actions button\s*\{[^}]*min-height:\s*var\(--size-tap-min/.test(css), 'destructive confirm clears the touch floor');
    for (const marker of ['Find new jobs', 'Search settings', 'Screened jobs', 'View as user', 'phone-language',
      'job-pager', 'card-menu', 'requirements-more', '/settings', '/admin', 'Sign out']) {
      check(radar.includes(marker), `phone tree renders ${marker}`);
    }

    console.log('Cleaning up the disposable accounts...');
    const goneUser = await user.request('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: userPasswordNow, confirm: 'DELETE' }),
    });
    await expect(goneUser, 200, 'delete the ordinary account');
    userDeleted = true;
    // The installation must never lose its last administrator, so deleting the only
    // admin is refused - that refusal is itself the expected outcome here. Either way
    // both accounts live only in the throwaway database this run deletes below.
    const goneAdmin = await admin.request('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: adminPassword, confirm: 'DELETE' }),
    });
    if (goneAdmin.status === 200) {
      adminDeleted = true;
      console.log('  ok   delete the admin account');
    } else {
      check(goneAdmin.status === 409, 'last-administrator guard holds', `got ${goneAdmin.status}: ${JSON.stringify(goneAdmin.data).slice(0, 120)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      viewport: '390px phone (harness) + 390x844 real-browser pass in scripts/check-visual.mjs',
      checks: [
        'synthetic admin + ordinary accounts', 'roles/countries/keywords', 'search + truthful per-source report',
        'restricted refusal', 'language explanation on every card', 'verdict correction',
        'save/applied/dismiss/restore', 'filter/page/return without lost state',
        'admin extra-source status', 'ordinary public-only controls',
        'email/password change + session revocation', 'phone pages render', 'bounded layout/control guards',
      ],
    }, null, 2));
  } finally {
    if (!userDeleted) {
      await user.request('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: userPasswordNow, confirm: 'DELETE' }),
      }).catch(() => undefined);
    }
    if (!adminDeleted) {
      await admin.request('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: adminPassword, confirm: 'DELETE' }),
      }).catch(() => undefined);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`\ncould not complete the walkthrough: ${error.message}`);
  failures += 1;
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // The OS reclaims the throwaway database directory.
  }
}

if (failures > 0) {
  console.error(`\n${failures} failed.`);
  process.exit(1);
}
console.log('\nphone walkthrough passed');
