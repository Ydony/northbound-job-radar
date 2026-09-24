import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CollectionRunBudgets,
  isAccessRefusal,
  MAX_NEW_PER_BULK_SOURCE,
  MAX_NEW_PER_PAGE_SOURCE,
  MAX_NEW_PER_RUN,
} from '../lib/collection-budgets';

// INT-03 (#162): per-run and per-source budgets plus stop-on-block, all with synthetic
// fixtures. The scrape route cannot be imported here (it needs the worker runtime), so
// behavior is tested against the real budget module composed the way the route composes
// it, and the pin test at the bottom proves the route still does so.

test('collection budgets are real numbers, ordered source ceiling below run ceiling', () => {
  assert.equal(Number.isFinite(MAX_NEW_PER_BULK_SOURCE), true, 'bulk ingestion is bounded');
  assert.equal(MAX_NEW_PER_BULK_SOURCE, 200);
  assert.equal(MAX_NEW_PER_PAGE_SOURCE, 4);
  assert.equal(MAX_NEW_PER_RUN, 800);
  assert.ok(MAX_NEW_PER_RUN >= MAX_NEW_PER_BULK_SOURCE, 'one source cannot spend the whole run');
});

test('access refusals are classified as stop signals', () => {
  // Exact shape thrown by fetchHtml in lib/job-adapters.ts.
  assert.equal(isAccessRefusal(new Error('jobs.ch request failed (403).')), true);
  assert.equal(isAccessRefusal(new Error('Undutchables request failed (429).')), true);
  assert.equal(isAccessRefusal(new Error('HTTP 401 Unauthorized')), true);
  assert.equal(isAccessRefusal(new Error('HTTP 451 Unavailable For Legal Reasons')), true);
  // Reason strings thrown as TransportFailure in lib/indeed/client.ts.
  assert.equal(isAccessRefusal(new Error('access_refused')), true);
  assert.equal(isAccessRefusal(new Error('rate_limited')), true);
  assert.equal(isAccessRefusal(new Error('Forbidden')), true);
  assert.equal(isAccessRefusal(new Error('Too many requests')), true);
  assert.equal(isAccessRefusal(new Error('bot challenge')), true);
  assert.equal(isAccessRefusal({ status: 403 }), true);
  assert.equal(isAccessRefusal({ statusCode: 429 }), true);
});

test('transient faults stay retryable, never refusals', () => {
  // A 404 on one detail URL means that listing is gone, not that the source refuses
  // access — unlike isBoardRefusal, which correctly treats a 404 board as dead, this
  // classifier must not let one removed posting block a whole source for the run.
  assert.equal(isAccessRefusal(new Error('HTTP 404 Not Found')), false);
  assert.equal(isAccessRefusal(new Error('HTTP 500 Internal Server Error')), false);
  assert.equal(isAccessRefusal(new Error('timed out after 8000ms')), false);
  assert.equal(isAccessRefusal(new Error('network request failed')), false);
  assert.equal(isAccessRefusal(new Error('Source request failed.')), false);
  assert.equal(isAccessRefusal({ status: 503 }), false);
  assert.equal(isAccessRefusal(null), false);
  assert.equal(isAccessRefusal(undefined), false);
});

test('a source returning 403 is asked once, then left alone for the rest of the run', async () => {
  const budgets = new CollectionRunBudgets();
  let searches = 0;
  let details = 0;
  const search = async (): Promise<string[]> => {
    searches += 1;
    throw new Error('MockSource request failed (403).');
  };
  const fetchDetail = async (url: string): Promise<null> => {
    details += 1;
    assert.ok(url.length > 0, 'a started candidate is a real URL');
    return null;
  };
  // The route's fetch phase: each adapter is searched exactly once; a refusal marks it
  // blocked instead of being retried.
  let blocked = false;
  try {
    await search();
  } catch (error) {
    if (isAccessRefusal(error)) {
      budgets.markBlocked('mock');
      blocked = true;
    }
  }
  assert.equal(searches, 1, 'no retry of the refused search');
  assert.equal(blocked, true);
  // The route's screening phase: a blocked source gets zero allowance, so its detail loop
  // never starts — no retry, no workaround, no disguised traffic.
  const allowed = budgets.allowance('mock', false);
  assert.equal(allowed, 0);
  for (const url of ['a', 'b'].slice(0, allowed)) {
    await fetchDetail(url);
  }
  assert.equal(budgets.allowance('mock', true), 0);
  assert.equal(budgets.isBlocked('mock'), true);
  assert.equal(details, 0, 'no detail request follows a refused search');
});

test('a refusal partway through detail fetches stops that source without further requests', async () => {
  const budgets = new CollectionRunBudgets();
  const candidates = ['a', 'b', 'c', 'd'];
  let fetches = 0;
  const fetchDetail = async (url: string): Promise<string> => {
    fetches += 1;
    if (url === 'c') throw new Error('MockSource request failed (429).');
    return url;
  };
  // The loop below mirrors the route's detail loop; the pin test proves the route keeps
  // this shape (allowance slice, noteAttempted, break on refusal).
  const attempted = candidates.slice(0, budgets.allowance('mock', false));
  assert.equal(attempted.length, 4);
  let started = 0;
  let stopped = false;
  for (const url of attempted) {
    started += 1;
    budgets.noteAttempted(1);
    try {
      await fetchDetail(url);
    } catch (error) {
      if (isAccessRefusal(error)) {
        budgets.markBlocked('mock');
        stopped = true;
        break;
      }
      throw error;
    }
  }
  assert.equal(fetches, 3, 'a, b, then the refusing c — d is never requested');
  assert.equal(stopped, true);
  assert.equal(budgets.allowance('mock', false), 0, 'the source is blocked after refusing');
  assert.equal(attempted.length - started + 1, 2, 'c and d are deferred, not failed');
});

test('a transient mid-run failure does not block the source', async () => {
  const budgets = new CollectionRunBudgets();
  let fetches = 0;
  const fetchDetail = async (): Promise<string> => {
    fetches += 1;
    if (fetches === 1) throw new Error('HTTP 500 Internal Server Error');
    return 'ok';
  };
  let failed = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    budgets.noteAttempted(1);
    try {
      await fetchDetail();
    } catch (error) {
      if (isAccessRefusal(error)) throw new Error('a 500 must never read as a refusal');
      failed += 1;
    }
  }
  assert.equal(fetches, 2, 'the loop continues past a transient failure');
  assert.equal(failed, 1);
  assert.equal(budgets.isBlocked('mock'), false);
  assert.equal(budgets.allowance('mock', false), MAX_NEW_PER_PAGE_SOURCE);
});

test('allowances enforce per-source ceilings and the whole-run remainder', () => {
  const budgets = new CollectionRunBudgets();
  assert.equal(budgets.allowance('ats-ch', true), 200);
  assert.equal(budgets.allowance('jobs.ch', false), 4);
  budgets.noteAttempted(799);
  assert.equal(budgets.attempted, 799);
  assert.equal(budgets.allowance('fresh-source', true), 1, 'only the run remainder is left');
  budgets.noteAttempted(1);
  assert.equal(budgets.allowance('fresh-source', true), 0, 'an exhausted run defers everything');
  assert.equal(budgets.allowance('fresh-source', false), 0);
});

test('the scrape route enforces budgets and stop-on-block as code', async () => {
  const source = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /POSITIVE_INFINITY/, 'bulk ingestion must be bounded');
  assert.match(source, /from '@\/lib\/collection-budgets'/, 'budgets come from the tested module');
  assert.match(source, /budgets\.markBlocked\(adapter\.key\)/, 'refusals mark the source blocked');
  assert.match(source, /budgets\.allowance\(adapter\.key, isBulk\)/, 'attempts consume the run budget');
  assert.match(source, /stoppedOnRefusal \? 'blocked'/, 'a mid-run refusal reports blocked');
  // Evasion machinery, not prose: the comments name the prohibition, so only implementation
  // tokens (clients, agents, flags) are pinned here.
  assert.doesNotMatch(source, /puppeteer|playwright|ProxyAgent|proxy-agent|headless|stealth/i,
    'no evasion mechanisms: no proxy rotation, no browser fallback');
});
