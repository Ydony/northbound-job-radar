import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndeedClient, INDEED_LIMITS } from '../lib/indeed/client';
import { indeedReadiness } from '../lib/indeed/auth';
import type { IndeedAccess, IndeedSearchInput } from '../lib/indeed/contracts';

// Entirely synthetic. No upstream traffic or real keys in this test suite.
const credentials = { apiKey: 'a'.repeat(64), userAgent: 'Synthetic local test', appInfo: 'synthetic=fixture' };
const access: IndeedAccess = { enabled: true, localExecution: true, administrator: true, appIdentityExperimentApproved: true };
const config = () => ({ access: { ...access }, credentials: { ...credentials } });
const input: IndeedSearchInput = { country: 'NL', keywords: 'data analyst', location: 'Amsterdam', pageSize: 1, maxJobs: 2 };
const job = (key = 'synthetic-1') => ({ key, title: 'Data Analyst', datePublished: 1780000000000,
  description: { html: '<p>English description</p>' }, location: { city: 'Amsterdam', countryCode: 'NL' }, employer: { name: 'Example' } });
const payload = (jobs: unknown[], cursor: string | null = null) => ({ data: { jobSearch: {
  results: jobs.map(job => ({ job })), pageInfo: { nextCursor: cursor },
} } });
function transport(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected extra network request');
    return response;
  };
  return { calls, fetcher };
}

test('Indeed refuses disabled, public, remote and unapproved callers before network access', async () => {
  for (const [flag, expected] of [['enabled', 'disabled'], ['localExecution', 'denied'],
    ['administrator', 'denied'], ['appIdentityExperimentApproved', 'denied']] as const) {
    const fixture = transport([]);
    const cfg = config();
    cfg.access[flag] = false;
    const result = await createIndeedClient(cfg, fixture.fetcher).search(input);
    assert.equal(result.reason, expected);
    assert.equal(result.outcome, 'unavailable');
    assert.equal(fixture.calls.length, 0);
  }
});

test('Indeed credentials are explicit, validated and readiness never exposes them', () => {
  assert.equal(indeedReadiness(access), 'not_configured');
  assert.equal(indeedReadiness(access, { ...credentials, appInfo: 'value\r\nAuthorization: bad' }), 'not_configured');
  assert.equal(indeedReadiness(access, { ...credentials, apiKey: 'invalid' }), 'not_configured');
  assert.equal(indeedReadiness(access, credentials), 'ready');
});

test('Indeed calls only the fixed HTTPS host with redirects and cookies disabled', async () => {
  const fixture = transport([Response.json(payload([job()]))]);
  const cfg = config();
  const client = createIndeedClient(cfg, fixture.fetcher);
  cfg.credentials.apiKey = 'b'.repeat(64); // External mutation cannot change the client snapshot.
  const result = await client.search(input);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.jobs[0].descriptionHtml, '<p>English description</p>');
  assert.equal(result.jobs[0].completeness, 'unknown');
  assert.equal(result.jobs[0].country, 'NL');
  const call = fixture.calls[0];
  assert.equal(call.url, 'https://apis.indeed.com/graphql');
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.credentials, 'omit');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('indeed-api-key'), credentials.apiKey);
  assert.equal(headers.get('indeed-co'), 'NL');
  assert.equal(headers.has('authorization'), false);
  assert.equal(headers.has('cookie'), false);
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
});

test('Indeed safely quotes search input and pagination cursors', async () => {
  const cursor = 'cursor"} query { secret }\n';
  const fixture = transport([Response.json(payload([job()], cursor)), Response.json(payload([job('synthetic-2')]))]);
  const keywords = 'analyst" } mutation { unwanted } #\n';
  const result = await createIndeedClient(config(), fixture.fetcher).search({ ...input, keywords, maxRequests: 2 });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.requestsMade, 2);
  const query0 = JSON.parse(String(fixture.calls[0].init.body)).query;
  const query1 = JSON.parse(String(fixture.calls[1].init.body)).query;
  assert.ok(query0.includes(`what: ${JSON.stringify(keywords)}`));
  assert.ok(query1.includes(`cursor: ${JSON.stringify(cursor)}`));
});

test('Indeed sends only validated date sort and bounded dateOnIndeed lookback', async () => {
  const fixture = transport([Response.json(payload([job()]))]);
  await createIndeedClient(config(), fixture.fetcher).search({ ...input, sort: 'DATE', hoursOld: 168 });
  const query = JSON.parse(String(fixture.calls[0].init.body)).query;
  assert.match(query, /sort: DATE/);
  assert.match(query, /filters: \{date: \{field: "dateOnIndeed", start: "168h"\}\}/);
  for (const invalid of [{ hoursOld: 0 }, { hoursOld: 169 }, { sort: 'DATE) { secret' }]) {
    const result = await createIndeedClient(config(), fixture.fetcher).search({ ...input, ...invalid } as IndeedSearchInput);
    assert.equal(result.reason, 'invalid_input');
  }
  assert.equal(fixture.calls.length, 1);
});

test('Indeed enforces budgets and does not call a continuation automatically', async () => {
  const fixture = transport([Response.json(payload([job()], 'next'))]);
  const result = await createIndeedClient(config(), fixture.fetcher).search(input);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'budget_exhausted');
  assert.equal(result.hasMore, true);
  assert.equal(fixture.calls.length, 1);
  const invalid = await createIndeedClient(config(), fixture.fetcher).search({ ...input, maxRequests: INDEED_LIMITS.maxRequests + 1 });
  assert.equal(invalid.reason, 'invalid_input');
  assert.equal(fixture.calls.length, 1);
});

test('Indeed stops repeated cursors and counts duplicate records', async () => {
  const fixture = transport([Response.json(payload([job()], 'same')), Response.json(payload([job()], 'same'))]);
  const result = await createIndeedClient(config(), fixture.fetcher).search({ ...input, maxRequests: 3 });
  assert.equal(result.reason, 'repeated_cursor');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.duplicateRows, 1);
  assert.equal(fixture.calls.length, 2);
});

test('Indeed refuses cross-country rows and preserves absent dates/descriptions as unknown', async () => {
  const missing = { ...job(), datePublished: null, description: null, location: null };
  const wrongCountry = { ...job('wrong'), location: { countryCode: 'CH' } };
  const fixture = transport([Response.json(payload([missing, wrongCountry, { key: 'bad', title: '' }]))]);
  const result = await createIndeedClient(config(), fixture.fetcher).search({ ...input, pageSize: 3, maxJobs: 3 });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.rejectedRows, 2);
  assert.equal(result.jobs[0].postedAtMs, null);
  assert.equal(result.jobs[0].country, 'unknown');
  assert.equal(result.jobs[0].descriptionHtml, '');
});

test('Indeed latches access refusal without retries or leaking response text', async () => {
  const fixture = transport([new Response(`secret=${credentials.apiKey}`, { status: 403 })]);
  const client = createIndeedClient(config(), fixture.fetcher);
  const first = await client.search(input);
  const second = await client.search(input);
  assert.equal(first.reason, 'access_refused');
  assert.equal(second.requestsMade, 0);
  assert.equal(fixture.calls.length, 1);
  assert.equal(JSON.stringify(first).includes(credentials.apiKey), false);
});

test('Indeed honors Retry-After without an automatic retry', async () => {
  const fixture = transport([new Response('limited', { status: 429, headers: { 'retry-after': '120' } })]);
  const client = createIndeedClient(config(), fixture.fetcher);
  const first = await client.search(input);
  assert.equal(first.reason, 'rate_limited');
  assert.equal(first.retryAfterSeconds, 120);
  assert.equal((await client.search(input)).requestsMade, 0);
  assert.equal(fixture.calls.length, 1);
});

test('Indeed never follows redirects or exposes upstream exception content', async () => {
  const redirect = transport([new Response(null, { status: 302, headers: { location: 'https://example.test/steal' } })]);
  assert.equal((await createIndeedClient(config(), redirect.fetcher).search(input)).reason, 'redirect_refused');
  assert.equal(redirect.calls.length, 1);
  const failure = transport([new Error(`upstream credentials ${credentials.apiKey}`)]);
  const result = await createIndeedClient(config(), failure.fetcher).search(input);
  assert.equal(result.reason, 'network_error');
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
});

test('Indeed distinguishes valid empty results from malformed data and GraphQL errors', async () => {
  for (const [response, reason] of [
    [Response.json(payload([])), 'end_of_results'],
    [Response.json({ data: null }), 'invalid_response'],
    [new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } }), 'invalid_response'],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), 'invalid_response'],
    [Response.json({ errors: [{ message: 'The client does not have access to a service' }] }), 'access_refused'],
    [Response.json({ errors: [{ message: 'Invalid query with secret value' }] }), 'upstream_error'],
    [Response.json({ errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }), 'access_refused'],
    [Response.json({ errors: [{ extensions: { code: 'RATE_LIMITED' } }] }), 'rate_limited'],
  ] as const) {
    const fixture = transport([response]);
    assert.equal((await createIndeedClient(config(), fixture.fetcher).search(input)).reason, reason);
  }
});

test('Indeed retains earlier results when a later page fails', async () => {
  const fixture = transport([Response.json(payload([job()], 'next')), new Response('broken', { status: 503 })]);
  const result = await createIndeedClient(config(), fixture.fetcher).search({ ...input, maxRequests: 2 });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.reason, 'upstream_error');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.requestsMade, 2);
});

test('Indeed rejects oversized responses', async () => {
  const fixture = transport([new Response(' '.repeat(INDEED_LIMITS.responseBytes + 1), { headers: { 'content-type': 'application/json' } })]);
  assert.equal((await createIndeedClient(config(), fixture.fetcher).search(input)).reason, 'response_too_large');
});

test('Indeed cancellation before a request makes no network call', async () => {
  const fixture = transport([]);
  const controller = new AbortController();
  controller.abort();
  const result = await createIndeedClient(config(), fixture.fetcher).search({ ...input, signal: controller.signal });
  assert.equal(result.reason, 'cancelled');
  assert.equal(fixture.calls.length, 0);
});

test('Indeed serializes searches on one configured client', async () => {
  let release: (response: Response) => void = () => undefined;
  const fetcher: typeof fetch = async () => new Promise(resolve => { release = resolve; });
  const client = createIndeedClient(config(), fetcher);
  const first = client.search(input);
  assert.equal((await client.search(input)).reason, 'busy');
  release(Response.json(payload([])));
  assert.equal((await first).outcome, 'complete');
});

test('Indeed enforces the request timeout and redacts transport errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error(credentials.apiKey)), { once: true });
  });
  const pending = createIndeedClient(config(), fetcher).search(input);
  t.mock.timers.tick(INDEED_LIMITS.timeoutMs);
  const result = await pending;
  assert.equal(result.reason, 'timeout');
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
});

test('Indeed aborts an in-flight request when its caller cancels', async () => {
  const controller = new AbortController();
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('cancelled transport')), { once: true });
  });
  const pending = createIndeedClient(config(), fetcher).search({ ...input, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).reason, 'cancelled');
});

test('Indeed does not relabel a third-country result as unknown or Dutch', async () => {
  const fixture = transport([Response.json(payload([{ ...job(), location: { countryCode: 'DE' } }]))]);
  const result = await createIndeedClient(config(), fixture.fetcher).search(input);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.rejectedRows, 1);
  assert.equal(result.reason, 'invalid_response');
});
