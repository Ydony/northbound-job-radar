#!/usr/bin/env node
/**
 * Measure the running app in a real browser, signed in, and fail on what is wrong.
 *
 * `scripts/check-design.mjs` reads the stylesheet, so it can settle token values and the type
 * ladder and nothing else. Everything that actually goes wrong here is a layout fact: a column
 * that floors at min-content and pushes the page wider than the screen, a control under its tap
 * floor, bands starting at three different left edges. Those need a layout engine.
 *
 * Nothing is added to package.json for this. Node has had WebSocket since 22, and every machine
 * that can develop this app already has Chrome or Edge, so the browser is driven over the
 * DevTools Protocol directly.
 *
 * Signing in is the part that usually blocks a worker: nobody should be typing a password into
 * a verification script, and no credential belongs in the repository. It registers a throwaway
 * account against the local server, exactly as `npm run verify:dev` does, and lets the browser
 * hold the cookie.
 *
 *   npm run dev            # in one terminal
 *   node scripts/check-visual.mjs
 *
 * Loopback only, by assertion. It writes to whatever database the dev server is pointed at, so
 * it must never be aimed at anything real.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const BASE = process.env.VISUAL_CHECK_URL ?? 'http://127.0.0.1:3000';
const { hostname } = new URL(BASE);
if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
  console.error(`refusing to run against ${hostname}: this registers an account and is loopback-only`);
  process.exit(2);
}

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find((path) => existsSync(path));
if (!browser) {
  console.error('no Chrome or Edge found; this check needs one of:\n  ' + BROWSERS.join('\n  '));
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'ajh-visual-'));
const port = 9000 + Math.floor(Math.random() * 900);
const child = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

let socket;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Evaluate in the page and return the value, surfacing page-side errors rather than hiding them. */
async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'page error');
  return result.value;
}

async function waitFor(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Everything measured in one pass, in the page.
 *
 * These are the checks that were being done by hand during the design review. A bare `1fr`
 * floors at min-content, so one long word in somebody else's advertisement decides how wide the
 * page is — five separate blowouts on this page came from exactly that, which is why overflow is
 * measured per element and not just on the document.
 */
const MEASURE = `(() => {
  const el = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string'
    ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const overflowing = [];
  const small = [];
  const shortTargets = [];
  const sizes = {};
  const narrow = window.innerWidth < 850;
  const tapFloor = narrow ? 44 : 24;
  for (const e of document.querySelectorAll('*')) {
    if (e.offsetParent === null && e.tagName !== 'BODY') continue;
    const style = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && style.overflowX === 'visible') {
      overflowing.push({ el: el(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth });
    }
    const ownText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText) {
      const px = parseFloat(style.fontSize);
      sizes[px] = (sizes[px] || 0) + 1;
      if (px < 12) small.push({ el: el(e), px, text: e.textContent.trim().slice(0, 40) });
    }
    if (/^(BUTTON|A|SELECT|SUMMARY|LABEL)$/.test(e.tagName)) {
      const box = e.getBoundingClientRect();
      const inProse = e.tagName === 'A' && e.parentElement
        && /^(P|LI|SPAN)$/.test(e.parentElement.tagName);
      if (box.height > 0 && box.height < tapFloor && !inProse) {
        shortTargets.push({ el: el(e), height: Math.round(box.height), text: e.textContent.trim().slice(0, 30) });
      }
    }
  }
  const edges = [...document.querySelectorAll('main > *')]
    .filter((e) => e.getBoundingClientRect().height > 0 && e.tagName !== 'DIALOG')
    .map((e) => Math.round(e.getBoundingClientRect().left + parseFloat(getComputedStyle(e).paddingLeft)));
  const card = document.querySelector('.job-card');
  return {
    width: window.innerWidth,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    overflowing: overflowing.slice(0, 8),
    overflowCount: overflowing.length,
    belowFloor: small.slice(0, 8),
    belowFloorCount: small.length,
    shortTargets: shortTargets.slice(0, 8),
    shortTargetCount: shortTargets.length,
    renderedSizes: Object.keys(sizes).map(Number).sort((a, b) => a - b),
    bandEdges: [...new Set(edges.filter((n) => n > 0))],
    screensToFirstCard: card
      ? Number(((card.getBoundingClientRect().top + window.scrollY) / window.innerHeight).toFixed(2))
      : null,
    cards: document.querySelectorAll('.job-card').length,
  };
})()`;

const LADDER = [12, 14, 17, 24, 32];
const failures = [];
const notes = [];

try {
  // Attach to the page the browser opened for us.
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }, 'the browser to start');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not attach to the browser')), { once: true });
  });
  await send('Runtime.enable');
  await send('Page.enable');

  // The server has to be up before anything else is worth trying.
  await waitFor(() => fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false),
    `the dev server on ${BASE} (start it with: npm run dev)`);

  // Register from inside the page, so the browser keeps the cookie and no password is ever
  // written down, passed on a command line, or read from the environment.
  await send('Page.navigate', { url: BASE });
  await waitFor(() => evaluate('document.readyState === "complete"'), 'the first page load');
  const account = `visual-${Date.now()}-${randomBytes(3).toString('hex')}@local.test`;
  const secret = `Local-only-${randomBytes(18).toString('base64url')}!`;
  const registered = await evaluate(`fetch('/api/auth', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'register', email: ${JSON.stringify(account)}, password: ${JSON.stringify(secret)} }),
  }).then((r) => r.status)`);
  if (registered !== 200) {
    // Registration is open on dev and closed on test; say which it is rather than failing blind.
    throw new Error(`could not register a throwaway account (HTTP ${registered}). `
      + 'This check needs an environment with registration open, which is dev.');
  }
  notes.push(`signed in as a throwaway account (${account})`);

  // Registering signs the account in, and the app moves off the login page as it does. Settle on
  // the workspace first: evaluating against a context that is mid-navigation fails with
  // "Inspected target navigated or closed", which looks like a broken app and is not one.
  await send('Page.navigate', { url: BASE });
  await waitFor(() => evaluate('document.readyState === "complete"'), 'the workspace after sign-in');

  // A fresh account has no jobs, so the card — the densest thing on the page and the one most
  // worth measuring — would never render. Seed one advertisement per verdict so all three
  // signal colours and the card layout are actually on screen when the measurements run.
  const body = (extra) => `We are hiring an analyst to improve enterprise data quality, metadata,
master data controls, governance processes, reporting, stakeholder collaboration and supply-chain
data. This is a permanent role in an international team where all meetings, documentation and
day-to-day collaboration are conducted in English. You will define standards, analyse quality
issues, facilitate workshops with business stakeholders, and deliver measurable improvements
across several business functions. The team is distributed across Amsterdam and Zurich and works
in English end to end, including code review, written specifications and planning. ${extra}`;
  const seeds = [
    ['pass', 'Senior Business Analyst', body('The working language is English throughout.')],
    ['review', 'Risk and Insurance Analyst', body('Dutch is a plus but not essential for this role.')],
    // Long enough for the import to accept, but ending mid-text: that trailing ellipsis is what
    // the language gate reads as a truncated advertisement, which is the third verdict. A short
    // body would be rejected by the import before it ever reached the gate.
    ['unknown', 'Marketing Analyst', body('The rest of this advertisement was not published and ends here...')],
  ];
  for (const [verdict, title, description] of seeds) {
    const status = await evaluate(`fetch('/api/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceUrl: 'https://example.com/jobs/' + ${JSON.stringify(verdict)} + '-' + Date.now(),
        title: ${JSON.stringify(title)}, company: 'Visual Check Company',
        location: 'Amsterdam, Netherlands', postedAt: '2026-09-17',
        description: ${JSON.stringify(description)},
      }),
    }).then((r) => r.status)`);
    if (status !== 200) notes.push(`could not seed the ${verdict} advertisement (HTTP ${status})`);
  }

  for (const [label, width, height] of [['desktop', 1400, 950], ['phone', 390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 768,
    });
    await send('Page.navigate', { url: BASE });
    await waitFor(() => evaluate('document.readyState === "complete" && !!document.querySelector("main")'),
      `${label} to render`);
    await new Promise((r) => setTimeout(r, 1200)); // let hydration settle
    const m = await evaluate(MEASURE);

    console.log(`\n${label} — ${m.width}px, ${m.cards} job cards`);
    const say = (ok, text) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${text}`); if (!ok) failures.push(`${label}: ${text}`); };

    say(m.pageOverflow <= 0, m.pageOverflow > 0
      ? `the page scrolls sideways by ${m.pageOverflow}px` : 'no horizontal page scroll');
    say(m.overflowCount === 0, m.overflowCount
      ? `${m.overflowCount} elements wider than their container, e.g. ${m.overflowing[0].el} `
        + `(${m.overflowing[0].scrollWidth} in ${m.overflowing[0].clientWidth})`
      : 'nothing overflows its container');
    say(m.belowFloorCount === 0, m.belowFloorCount
      ? `${m.belowFloorCount} elements render text below 12px, e.g. ${m.belowFloor[0].el} at ${m.belowFloor[0].px}px`
      : 'no text below 12px');
    say(m.shortTargetCount === 0, m.shortTargetCount
      ? `${m.shortTargetCount} controls under the ${m.width < 850 ? 44 : 24}px floor, e.g. `
        + `${m.shortTargets[0].el} at ${m.shortTargets[0].height}px ("${m.shortTargets[0].text}")`
      : `every control clears the ${m.width < 850 ? 44 : 24}px floor`);

    const offLadder = m.renderedSizes.filter((n) => !LADDER.includes(n));
    say(offLadder.length === 0, offLadder.length
      ? `sizes off the ladder: ${offLadder.join(', ')}` : `sizes rendered: ${m.renderedSizes.join(', ')}`);

    if (label === 'desktop') {
      say(m.bandEdges.length <= 1, m.bandEdges.length > 1
        ? `bands start at ${m.bandEdges.length} different left edges: ${m.bandEdges.join(', ')}`
        : `every band starts at ${m.bandEdges[0] ?? 0}px`);
    } else if (m.screensToFirstCard !== null) {
      say(m.screensToFirstCard <= 1, `the first job sits ${m.screensToFirstCard} screens down`);
    }
  }
} catch (error) {
  console.error(`\ncould not complete the check: ${error.message}`);
  failures.push(error.message);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  child.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows holds it briefly */ }
}

for (const note of notes) console.log(`\n${note}`);
if (failures.length) {
  console.log(`\n${failures.length} failed. The agreed design is in docs/design/canvas/ — open`);
  console.log('index.html beside the running app to see what these add up to.');
  process.exit(1);
}
console.log('\nall visual checks passed');
