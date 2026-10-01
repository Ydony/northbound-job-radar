#!/usr/bin/env node
/** Bounded, read-only dashboard/search-result probe. Never invokes provider collection. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseCapacityArgs(argv) {
  const values = { requests: 20, parallel: 2, ownerHost: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--owner-host') values.ownerHost = true;
    else if (['--base', '--cookie-file', '--requests', '--parallel'].includes(option)) {
      if (!argv[index + 1]) throw new Error(`missing value for ${option}`);
      values[option.slice(2).replace('-file', 'File')] = argv[++index];
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!values.base) throw new Error('--base is required');
  const url = new URL(values.base);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--base must be an origin without credentials or path');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local && (!values.ownerHost || url.protocol !== 'https:')) {
    throw new Error('remote probes require HTTPS and --owner-host acknowledgment');
  }
  if (local && url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported base protocol');
  for (const key of ['requests', 'parallel']) {
    const number = Number(values[key]);
    const max = key === 'requests' ? 50 : 5;
    if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`${key} must be 1–${max}`);
    values[key] = number;
  }
  if (values.parallel > values.requests) throw new Error('parallel cannot exceed requests');
  return values;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

export async function runCapacityProbe({ base, cookie, requests, parallel }) {
  if (!Number.isInteger(requests) || requests < 1 || requests > 50 ||
      !Number.isInteger(parallel) || parallel < 1 || parallel > 5 || parallel > requests) {
    throw new Error('requests/parallel outside safe bounds');
  }
  const url = new URL('/api/state', base);
  const statuses = {};
  const latencies = [];
  let next = 0;
  let attempted = 0;
  let failures = 0;
  let aborted = 0;
  let stopped = false;
  const stop = new AbortController();
  const started = performance.now();
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (!stopped && next < requests) {
      next++;
      attempted++;
      const requestStarted = performance.now();
      const requestSignal = AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]);
      let cancelled = false;
      try {
        const response = await fetch(url, {
          method: 'GET', headers: { Cookie: cookie }, redirect: 'manual',
          signal: requestSignal,
        });
        const jsonResponse = response.headers.get('content-type')?.includes('application/json');
        if (response.status !== 200 || !jsonResponse) {
          const status = response.status === 200 ? 'invalid-state' : String(response.status);
          statuses[status] = (statuses[status] ?? 0) + 1;
          failures++;
          stopped = true;
          stop.abort();
          await response.body?.cancel().catch(() => undefined);
        } else {
          const body = await response.text();
          let validState = false;
          try {
            const data = JSON.parse(body);
            validState = Boolean(data?.account && Array.isArray(data?.jobs));
          } catch {
            // A 200 HTML/login/error body is a failed measurement, not a successful dashboard.
          }
          const status = validState ? '200' : 'invalid-state';
          statuses[status] = (statuses[status] ?? 0) + 1;
          if (!validState) {
            failures++;
            stopped = true;
            stop.abort();
          }
        }
      } catch {
        if (stop.signal.aborted && requestSignal.reason === stop.signal.reason) {
          aborted++;
          cancelled = true;
        } else {
          statuses.network = (statuses.network ?? 0) + 1;
          failures++;
          stopped = true;
          stop.abort();
        }
      }
      if (!cancelled) latencies.push(Math.round(performance.now() - requestStarted));
    }
  }));
  return {
    endpoint: '/api/state', requests, attempted, parallel,
    ok: attempted - failures - aborted, failures, aborted,
    statuses, elapsedMs: Math.round(performance.now() - started),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCapacityArgs(process.argv.slice(2));
    if (!options.cookieFile) throw new Error('--cookie-file is required');
    const cookie = readFileSync(options.cookieFile, 'utf8').trim();
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error('cookie file must contain one Cookie header line');
    const result = await runCapacityProbe({ ...options, cookie });
    console.log(JSON.stringify(result, null, 2));
    if (result.failures) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
