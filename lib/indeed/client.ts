import { indeedHeaders, indeedReadiness } from './auth';
import type { IndeedAccess, IndeedCredentials, IndeedRecord, IndeedSearchInput,
  IndeedSearchResult, IndeedStopReason } from './contracts';

const ENDPOINT = 'https://apis.indeed.com/graphql';
// Transport validation ceilings, not the live collection budget (that lives
// with the collector in collection.ts). maxRequests 8 is the page-multiple the
// eventual 200-rows-per-query design needs (8 x 25); the running collector
// still sends 1 request per query and at most 4 per click.
export const INDEED_LIMITS = Object.freeze({ maxRequests: 8, maxJobs: 400,
  pageSize: 100, timeoutMs: 20_000, responseBytes: 2_000_000, delayMs: 500 });

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const text = (value: unknown, cap: number) => typeof value === 'string' && value.length <= cap ? value : '';
const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

class TransportFailure extends Error {
  constructor(readonly reason: IndeedStopReason, readonly retryAfterSeconds?: number) {
    super(reason); // Never include upstream bodies, headers, URLs or thrown fetch errors.
  }
}

function queryFor(input: IndeedSearchInput, limit: number, cursor: string | null) {
  // Input types are not guessed: use the observed inline arguments, with JSON
  // string escaping for every dynamic GraphQL string (including server cursors).
  return `query LocalDescriptionCheck {
    jobSearch(what: ${JSON.stringify(input.keywords)},
      location: {where: ${JSON.stringify(input.location)}, radius: ${input.radiusMiles ?? 10}, radiusUnit: MILES},
      limit: ${limit}, sort: RELEVANCE${cursor ? `, cursor: ${JSON.stringify(cursor)}` : ''}) {
      pageInfo { nextCursor }
      results { job { key title datePublished description { html }
        location { city countryCode } employer { name } } }
    }
  }`;
}

function record(value: unknown): IndeedRecord | null {
  const job = object(value);
  if (!job) return null;
  const key = text(job.key, 128);
  const title = text(job.title, 240);
  if (!/^[a-zA-Z0-9_-]+$/.test(key) || !title.trim()) return null;
  const location = object(job.location);
  const description = object(job.description)?.html;
  if (description != null && (typeof description !== 'string' || description.length > 120_000)) return null;
  const countryCode = typeof location?.countryCode === 'string' ? location.countryCode.toUpperCase() : '';
  if (countryCode && countryCode !== 'NL' && countryCode !== 'CH') return null;
  return {
    key, title, employer: text(object(job.employer)?.name, 300), city: text(location?.city, 300),
    country: countryCode === 'NL' || countryCode === 'CH' ? countryCode : 'unknown',
    postedAtMs: typeof job.datePublished === 'number' && Number.isFinite(job.datePublished)
      && job.datePublished >= 0 && job.datePublished <= 8.64e15 ? job.datePublished : null,
    descriptionHtml: typeof description === 'string' ? description : '',
    descriptionEvidence: 'api-description-field', completeness: 'unknown',
  };
}

function retryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

async function jsonBody(response: Response) {
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new TransportFailure('invalid_response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TransportFailure('invalid_response');
  let total = 0;
  let body = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > INDEED_LIMITS.responseBytes) throw new TransportFailure('response_too_large');
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    try { return JSON.parse(body) as unknown; }
    catch { throw new TransportFailure('invalid_response'); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function page(fetcher: typeof fetch, headers: Record<string, string>, query: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, INDEED_LIMITS.timeoutMs);
  if (signal?.aborted) controller.abort();
  try {
    controller.signal.throwIfAborted();
    const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'manual',
      credentials: 'omit', headers, body: JSON.stringify({ query }), signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new TransportFailure('access_refused');
      if (response.status === 429) throw new TransportFailure('rate_limited', retryAfter(response.headers.get('retry-after')));
      if (response.status >= 300 && response.status < 400) throw new TransportFailure('redirect_refused');
      throw new TransportFailure('upstream_error');
    }
    const payload = object(await jsonBody(response));
    if (payload && 'errors' in payload && !Array.isArray(payload.errors)) throw new TransportFailure('invalid_response');
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      const errorSignals = payload.errors.map(error => {
        const value = object(error);
        return `${String(value?.message ?? '')} ${String(object(value?.extensions)?.code ?? '')}`;
      });
      const accessFailure = errorSignals.some(value => /unauthor|unauthenticated|forbidden|does not have access|permission/i.test(value));
      const rateFailure = errorSignals.some(value => /rate[_ -]?limit|too many requests/i.test(value));
      throw new TransportFailure(accessFailure ? 'access_refused' : rateFailure ? 'rate_limited' : 'upstream_error');
    }
    const search = object(object(payload?.data)?.jobSearch);
    const pageInfo = object(search?.pageInfo);
    if (!Array.isArray(search?.results) || !pageInfo || !('nextCursor' in pageInfo)
      || (pageInfo.nextCursor !== null && (typeof pageInfo.nextCursor !== 'string' || pageInfo.nextCursor.length > 8192))) {
      throw new TransportFailure('invalid_response');
    }
    return { rows: search.results as unknown[], cursor: pageInfo.nextCursor as string | null };
  } catch (error) {
    if (signal?.aborted) throw new TransportFailure('cancelled');
    if (expired) throw new TransportFailure('timeout');
    if (error instanceof TransportFailure) throw error;
    throw new TransportFailure('network_error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** No database, UI, source registration, phone, session cookie or public endpoint. */
export function createIndeedClient(config: { access: IndeedAccess; credentials?: IndeedCredentials }, fetcher: typeof fetch = fetch) {
  const access = { ...config.access };
  const credentials = config.credentials ? { ...config.credentials } : undefined;
  let busy = false;
  let accessRefused = false;
  let cooldownUntil = 0;
  return {
    readiness: () => indeedReadiness(access, credentials),
    async search(input: IndeedSearchInput): Promise<IndeedSearchResult> {
      const result: IndeedSearchResult = { contractVersion: 1, outcome: 'failed', reason: 'invalid_input',
        jobs: [], requestsMade: 0, responseRows: 0, duplicateRows: 0, rejectedRows: 0, hasMore: null };
      const finish = (reason: IndeedStopReason) => {
        result.reason = reason;
        result.outcome = reason === 'end_of_results' && !result.rejectedRows ? 'complete'
          : result.jobs.length ? 'partial'
          : ['disabled', 'denied', 'not_configured'].includes(reason) ? 'unavailable' : 'failed';
        return result;
      };
      const readiness = indeedReadiness(access, credentials);
      if (readiness !== 'ready' || !credentials) return finish(readiness === 'ready' ? 'not_configured' : readiness);
      if (accessRefused) return finish('access_refused');
      if (cooldownUntil > Date.now()) {
        result.retryAfterSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
        return finish('rate_limited');
      }
      if (busy) return finish('busy');
      const pageSize = input.pageSize ?? 25;
      const maxRequests = input.maxRequests ?? 1;
      const maxJobs = input.maxJobs ?? 25;
      if (!['NL', 'CH'].includes(input.country) || typeof input.keywords !== 'string' || !input.keywords.trim()
        || input.keywords.length > 300 || typeof input.location !== 'string' || !input.location.trim()
        || input.location.length > 300 || !integer(input.radiusMiles ?? 10, 0, 500)
        || !integer(pageSize, 1, INDEED_LIMITS.pageSize) || !integer(maxRequests, 1, INDEED_LIMITS.maxRequests)
        || !integer(maxJobs, 1, INDEED_LIMITS.maxJobs)) return finish('invalid_input');
      if (input.signal?.aborted) return finish('cancelled');
      busy = true;
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      const seenJobs = new Set<string>();
      try {
        for (let index = 0; index < maxRequests; index++) {
          if (index > 0) await new Promise(resolve => setTimeout(resolve, INDEED_LIMITS.delayMs));
          if (input.signal?.aborted) return finish('cancelled');
          const limit = Math.min(pageSize, maxJobs - result.jobs.length);
          result.requestsMade++;
          const response = await page(fetcher, indeedHeaders(credentials, input.country), queryFor(input, limit, cursor), input.signal);
          if (response.rows.length > limit) return finish('invalid_response');
          result.responseRows += response.rows.length;
          for (const row of response.rows) {
            const job = record(object(row)?.job);
            if (!job || (job.country !== 'unknown' && job.country !== input.country)) { result.rejectedRows++; continue; }
            if (seenJobs.has(job.key)) { result.duplicateRows++; continue; }
            seenJobs.add(job.key);
            result.jobs.push(job);
          }
          result.hasMore = Boolean(response.cursor);
          if (!response.cursor) return finish(result.rejectedRows && !result.jobs.length ? 'invalid_response' : 'end_of_results');
          if (seenCursors.has(response.cursor)) return finish('repeated_cursor');
          seenCursors.add(response.cursor);
          cursor = response.cursor;
          if (result.jobs.length >= maxJobs) return finish('budget_exhausted');
        }
        return finish('budget_exhausted');
      } catch (error) {
        const failure = error instanceof TransportFailure ? error : new TransportFailure('network_error');
        result.retryAfterSeconds = failure.retryAfterSeconds;
        if (failure.reason === 'access_refused') accessRefused = true;
        if (failure.reason === 'rate_limited') cooldownUntil = Date.now() + Math.max(1, failure.retryAfterSeconds ?? 60) * 1000;
        return finish(failure.reason);
      } finally { busy = false; }
    },
  };
}
