#!/usr/bin/env node
/**
 * Measure employer-board fetch reliability for #75.
 *
 * Fetches every configured board three times in a row (same order, same concurrency as the
 * app) and reports per attempt how many boards succeeded, timed out, or were refused, with
 * status codes — plus which boards changed outcome between passes. This is what tells the
 * timeout hypothesis apart from the rate-limit hypothesis. Run with:
 *
 *   npx tsx scripts/measure-board-fetches.ts [--passes N] [--timeout-ms MS] [--retry-once]
 *
 * --retry-once applies the app's single retry of timeouts/network/5xx (never 429/4xx) so the
 * effect of the fix can be measured without hammering a refusing source.
 */
import { atsCompanies, BOARD_CONCURRENCY, fetchCompany, isBoardRefusal, type AtsCompany, type BoardFetchOutcome } from '../lib/ats-feeds';

interface Args { passes: number; timeoutMs?: number; retryOnce: boolean }
function parseArgs(argv: string[]): Args {
  let passes = 3;
  let timeoutMs: number | undefined;
  let retryOnce = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--passes') passes = Math.max(1, Number(argv[++i]) || 3);
    else if (argv[i] === '--timeout-ms') timeoutMs = Number(argv[++i]) || undefined;
    else if (argv[i] === '--retry-once') retryOnce = true;
  }
  return { passes, timeoutMs, retryOnce };
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isRetryable(outcome: BoardFetchOutcome) {
  if (outcome.status === 'timeout' || outcome.status === 'network-error') return true;
  if (outcome.status === 'http-error' && outcome.httpStatus !== undefined) {
    return outcome.httpStatus >= 500 && outcome.httpStatus < 600;
  }
  return false;
}

async function fetchBoard(company: AtsCompany, timeoutMs: number | undefined, retryOnce: boolean): Promise<BoardFetchOutcome> {
  const first = await fetchCompany(company, timeoutMs);
  if (retryOnce && first.status !== 'ok' && !isBoardRefusal(first) && isRetryable(first)) {
    // One retry only, and never against a refusal: a 429/4xx is a stop signal, not a prompt.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return fetchCompany(company, timeoutMs);
  }
  return first;
}

function summarize(label: string, outcomes: BoardFetchOutcome[]) {
  const byStatus = new Map<string, number>();
  const byHttp = new Map<number, number>();
  let postings = 0;
  for (const outcome of outcomes) {
    byStatus.set(outcome.status, (byStatus.get(outcome.status) ?? 0) + 1);
    if (outcome.status === 'http-error' && outcome.httpStatus !== undefined) {
      byHttp.set(outcome.httpStatus, (byHttp.get(outcome.httpStatus) ?? 0) + 1);
    }
    postings += outcome.jobs.length;
  }
  console.log(`\n== ${label} ==`);
  console.log(`boards: ${outcomes.length}  postings: ${postings}`);
  for (const [status, count] of [...byStatus.entries()].sort()) {
    console.log(`  ${status}: ${count}`);
  }
  if (byHttp.size) {
    console.log(`  http codes: ${[...byHttp.entries()].sort((a, b) => a[0] - b[0]).map(([code, n]) => `${code}x${n}`).join(' ')}`);
  }
  return postings;
}

async function main() {
  const { passes, timeoutMs, retryOnce } = parseArgs(process.argv.slice(2));
  console.log(`boards: ${atsCompanies.length}  passes: ${passes}  concurrency: ${BOARD_CONCURRENCY}` +
    `${timeoutMs ? `  timeout: ${timeoutMs}ms` : ''}${retryOnce ? '  retry-once: on' : ''}`);
  const all: BoardFetchOutcome[][] = [];
  for (let pass = 0; pass < passes; pass++) {
    const started = Date.now();
    const outcomes = await mapPool(atsCompanies, BOARD_CONCURRENCY, (company, i) => {
      if ((i + 1) % 50 === 0) console.log(`  pass ${pass + 1}: ${i + 1}/${atsCompanies.length} boards started…`);
      return fetchBoard(company, timeoutMs, retryOnce);
    });
    console.log(`  pass ${pass + 1} took ${Math.round((Date.now() - started) / 1000)}s`);
    summarize(`pass ${pass + 1}`, outcomes);
    all.push(outcomes);
  }

  // Which boards decayed between passes — the shape #75 reported as falling totals.
  console.log('\n== boards that failed on a later pass after succeeding ==');
  let decayed = 0;
  for (let i = 0; i < atsCompanies.length; i++) {
    const firstOk = all[0][i].status === 'ok';
    const laterFail = all.slice(1).some((outcomes) => outcomes[i].status !== 'ok');
    if (firstOk && laterFail) {
      decayed++;
      const trail = all.map((outcomes) => outcomes[i].status + (outcomes[i].httpStatus ? `(${outcomes[i].httpStatus})` : '')).join(' -> ');
      const company = atsCompanies[i];
      if (decayed <= 30) console.log(`  ${company.platform}:${company.slug}  ${trail}`);
    }
  }
  console.log(`decayed boards: ${decayed}/${atsCompanies.length}`);

  console.log('\n== slowest successful boards on the last pass (timeout suspects) ==');
  const ok = all[all.length - 1].filter((o) => o.status === 'ok').sort((a, b) => b.durationMs - a.durationMs);
  for (const outcome of ok.slice(0, 15)) {
    console.log(`  ${outcome.durationMs}ms  ${outcome.jobs.length} postings  ${outcome.company.platform}:${outcome.company.slug}`);
  }
  console.log('\n== failed boards on the last pass ==');
  const failed = all[all.length - 1].filter((o) => o.status !== 'ok');
  for (const outcome of failed.slice(0, 40)) {
    console.log(`  ${outcome.status}${outcome.httpStatus ? `(${outcome.httpStatus})` : ''}  ${outcome.durationMs}ms  ${outcome.company.platform}:${outcome.company.slug}  ${outcome.error ?? ''}`);
  }
  if (failed.length > 40) console.log(`  …and ${failed.length - 40} more`);
}

await main();
