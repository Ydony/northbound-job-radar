import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isLoopbackRequest } from '../lib/indeed/access';
import {
  isHostedCollectionRequest,
  jobSourceAdapters,
  pageFetchRefusalMessage,
  restrictedSourceKeys,
} from '../lib/job-adapters';

// T15 (F4): collection controls and status messages must stay truthful on a hosted
// installation, where the VPN workflow is shelved (local-only launcher), and must keep
// verifying refusal/cooldown/restart behavior with synthetic fixtures. Route handlers need
// live sessions, which this harness cannot mint, so the pure helpers are tested
// functionally and the route/client wiring is pinned structurally — the repo's
// established split (see tests/public-admin-isolation.test.ts).

function requestTo(url: string) {
  return new Request(url, { method: 'POST' });
}

test('loopback requests are local; everything else is hosted', () => {
  for (const url of [
    'http://localhost:3000/api/scrape',
    'https://localhost:3000/api/scrape',
    'http://127.0.0.1:3001/api/scrape',
    'http://[::1]:3000/api/scrape',
  ]) assert.equal(isLoopbackRequest(requestTo(url)), true, `${url} must read as local`);
  for (const url of [
    'https://ikbeneenappel-prod.anddonatas.workers.dev/api/scrape',
    'https://ikbeneenappel.nl/api/scrape',
    'http://192.168.1.20:3000/api/scrape',
    'http://10.0.0.5:3000/api/scrape',
  ]) assert.equal(isLoopbackRequest(requestTo(url)), false, `${url} must read as hosted`);
});

test('the hosted collection flag is exactly the negation of the loopback gate', () => {
  // One heuristic for both gates: the Indeed `localExecution` check and the page-fetch
  // refusal must never disagree about what counts as local.
  assert.equal(isHostedCollectionRequest(requestTo('http://localhost:3000/api/scrape')), false);
  assert.equal(isHostedCollectionRequest(requestTo('https://ikbeneenappel.nl/api/scrape')), true);
});

test('the restricted tier is exactly the four VPN-gated sources', () => {
  assert.deepEqual(restrictedSourceKeys().sort(),
    ['jobs.ch', 'jobscout24.ch', 'jobup.ch', 'undutchables.nl'].sort());
});

test('a hosted refusal names the unavailable tier instead of a local command', () => {
  const message = pageFetchRefusalMessage({ hosted: true });
  for (const key of restrictedSourceKeys()) {
    const name = jobSourceAdapters.find((adapter) => adapter.key === key)!.name;
    assert.ok(message.includes(name), `hosted refusal must name ${name}`);
  }
  assert.match(message, /not available on this hosted installation/i);
  assert.match(message, /VPN launcher is local-only/i);
  assert.ok(!message.includes('dev:private'), 'a phone cannot run a local launcher command');
  assert.match(message, /Find new jobs/i, 'the refusal must point at what still works');
});

test('a local refusal still names the launcher that fixes it', () => {
  const message = pageFetchRefusalMessage({ hosted: false });
  assert.match(message, /npm run dev:private/);
  assert.ok(!/hosted installation/i.test(message), 'a local refusal must not claim hosted unavailability');
});

test('the scrape route refuses the page-fetching mode differently per origin, same gate', async () => {
  const source = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');
  assert.match(source, /isHostedCollectionRequest\(request\)/,
    'the refusal must be decided from the request origin');
  assert.match(source, /pageFetchRefusalMessage\(\{ hosted:/,
    'the refusal text must come from the hosted-aware helper');
  assert.match(source, /authSecrets\(\)\.vpnEnforced/,
    'the VPN enforcement gate itself must stay: messaging changes, collection does not');
  assert.match(source, /status: 409/,
    'the refusal keeps its status code; only the message became origin-aware');
  // The non-admin guard predates this change and must survive it untouched.
  assert.match(source, /requestedAll && user\.role !== 'admin'/,
    'mode=all stays administrator-only');
  // F4 forbids working around a refusal: no evasion, proxy rotation, challenge bypass,
  // login automation or higher volume may be introduced alongside hosted messaging. The
  // route states that prohibition in comments, so this pins the absence of the machinery
  // itself: no browser/proxy library imports and no disguise-shaped code.
  assert.doesNotMatch(source, /from '[^']*(puppeteer|playwright|proxy|stealth|socks)[^']*'/i,
    'no evasion library may ride along with hosted messaging');
  assert.doesNotMatch(source, /stealth|fingerprint.{0,20}spoof|rotate.{0,20}(proxy|ip)|captcha.{0,20}(solv|bypass)/i,
    'no disguise-shaped code may ride along with hosted messaging');
});

test('the state route exposes page-fetch availability and hosted origin', async () => {
  const source = await readFile(new URL('../app/api/state/route.ts', import.meta.url), 'utf8');
  assert.match(source, /pageFetchAvailable: authSecrets\(\)\.vpnEnforced/,
    'the client must learn whether the tier can run here');
  assert.match(source, /hostedInstallation: isHostedCollectionRequest\(request\)/,
    'the client must learn whether a local launcher could change that');
  const types = await readFile(new URL('../lib/types.ts', import.meta.url), 'utf8');
  assert.match(types, /pageFetchAvailable\?: boolean/, 'AppState must carry page-fetch availability');
  assert.match(types, /hostedInstallation\?: boolean/, 'AppState must carry hosted origin');
});

test('the dashboard states hosted unavailability instead of offering the VPN button', async () => {
  const source = await readFile(new URL('../app/job-radar.tsx', import.meta.url), 'utf8');
  assert.match(source, /pageFetchShelvedHere/,
    'the control must react to the server-sent hosted flags');
  assert.match(source, /Page-fetching sources are unavailable on this hosted installation/,
    'a hosted administrator must read unavailability, not a VPN promise');
  assert.match(source, /Find new jobs.*still searches the authorized sources/,
    'the hosted note must point at what still works');
  // The button survives for local use (with and without the VPN running); it is the
  // hosted combination that replaces it with the note.
  assert.match(source, /Search all — VPN on/, 'the local control must remain');
});

test('the Indeed local experiment is not generalized to hosted production', async () => {
  // F4 acceptance: a source-specific decision is required before any hosted Indeed
  // implementation, so T15 pins the existing local-only shape rather than extending it.
  const runtime = await readFile(new URL('../db/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /env\.INDEED_LOCAL_ONLY === 'true' && isLoopbackRequest\(request\)/,
    'Indeed local execution stays loopback-gated');
  for (const key of ['indeed-ch', 'indeed-nl']) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key)!;
    assert.equal(adapter.availability, 'disabled', `${key} must stay disabled by default`);
    assert.equal(adapter.access, 'local-experiment', `${key} must stay a local experiment`);
    assert.equal(adapter.adminOnly, true, `${key} must stay administrator-only`);
  }
});

test('restricted sources keep their local VPN wording and caps', async () => {
  // The static adapter messages still describe the local workflow (pinned by
  // tests/job-adapters.test.ts); hosted callers never see them because the hosted
  // refusal fires before any restricted source is contacted.
  const scrape = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');
  const refusalAt = scrape.indexOf('pageFetchRefusalMessage({ hosted:');
  const permittedAt = scrape.indexOf('const permittedAdapters');
  assert.ok(refusalAt > 0 && permittedAt > refusalAt,
    'the hosted refusal must fire before any adapter is permitted, so VPN absence cannot silently produce success');
  const budgets = await readFile(new URL('../lib/collection-budgets.ts', import.meta.url), 'utf8');
  assert.match(budgets, /MAX_NEW_PER_PAGE_SOURCE = 4/, 'the page-fetching cap is unchanged');
  assert.match(budgets, /MAX_NEW_PER_RUN = 800/, 'the whole-run ceiling is unchanged');
});
