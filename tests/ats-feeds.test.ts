import assert from 'node:assert/strict';
import test from 'node:test';
import { atsCompanies, BOARD_CONCURRENCY, fetchCompany, feedUrl, isBoardRefusal, isBoardRetryable,
  mapWithConcurrency, parseFeed, searchAtsBoards, searchAtsBoardsDetailed, type AtsCompany } from '../lib/ats-feeds';
import { countryFromLocation } from '../lib/job-identity';

const greenhouse: AtsCompany = { slug: 'example', name: 'Example', platform: 'greenhouse', country: 'netherlands' };

test('every configured company has a unique slug and a known platform', () => {
  const keys = atsCompanies.map((company) => `${company.platform}:${company.slug}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate ATS company entry');
  assert.ok(atsCompanies.length >= 20, 'expected a meaningful number of boards');
  assert.ok(atsCompanies.some((company) => company.country === 'netherlands'));
  assert.ok(atsCompanies.some((company) => company.country === 'switzerland'));
});

test('builds the documented public endpoint for each platform', () => {
  assert.match(feedUrl(greenhouse), /boards-api\.greenhouse\.io\/v1\/boards\/example\/jobs\?content=true$/);
  assert.match(feedUrl({ ...greenhouse, platform: 'lever' }), /api\.lever\.co\/v0\/postings\/example\?mode=json$/);
  assert.match(feedUrl({ ...greenhouse, platform: 'recruitee' }), /example\.recruitee\.com\/api\/offers\/$/);
  assert.match(feedUrl({ ...greenhouse, platform: 'ashby' }), /posting-api\/job-board\/example$/);
  assert.match(feedUrl({ ...greenhouse, platform: 'personio' }), /example\.jobs\.personio\.de\/xml$/);
  assert.match(feedUrl({ ...greenhouse, platform: 'teamtailor' }), /example\.teamtailor\.com\/jobs\.json$/);
  assert.match(feedUrl({ ...greenhouse, platform: 'workable' }), /apply\.workable\.com\/api\/v1\/widget\/accounts\/example\?details=true$/);
});

test('parses a Greenhouse board and decodes escaped description markup', () => {
  const body = JSON.stringify({
    jobs: [{
      absolute_url: 'https://boards.greenhouse.io/example/jobs/1',
      title: 'Data Analyst',
      location: { name: 'Amsterdam, Netherlands' },
      first_published: '2026-08-01T00:00:00Z',
      content: '&lt;p&gt;We need SQL &amp; Python.&lt;/p&gt;',
    }],
  });
  const [job] = parseFeed(greenhouse, body);
  assert.equal(job.title, 'Data Analyst');
  assert.equal(job.company, 'Example');
  assert.equal(job.location, 'Amsterdam, Netherlands');
  assert.match(job.descriptionHtml, /<p>We need SQL & Python\.<\/p>/);
});

test('parses Ashby and Recruitee shapes', () => {
  const ashby = parseFeed({ ...greenhouse, platform: 'ashby' }, JSON.stringify({
    jobs: [{ jobUrl: 'https://jobs.ashbyhq.com/example/1', title: 'Engineer', location: 'Zurich', publishedAt: '2026-08-02', descriptionHtml: '<p>Build things.</p>' }],
  }));
  assert.equal(ashby[0].title, 'Engineer');
  assert.equal(ashby[0].location, 'Zurich');

  const recruitee = parseFeed({ ...greenhouse, platform: 'recruitee' }, JSON.stringify({
    offers: [{ careers_url: 'https://example.recruitee.com/o/1', title: 'Analyst', city: 'Utrecht', country: 'NL', description: 'Work here.', requirements: 'SQL' }],
  }));
  assert.equal(recruitee[0].location, 'Utrecht, NL');
  assert.match(recruitee[0].descriptionHtml, /Work here\./);
});

test('parses a Personio XML feed', () => {
  const xml = `<positions><position><id>42</id><name>Data Engineer</name><office>Zurich</office>
    <createdAt>2026-08-03</createdAt>
    <jobDescriptions><jobDescription><name>Tasks</name><value>Build pipelines.</value></jobDescription></jobDescriptions>
    </position></positions>`;
  const [job] = parseFeed({ ...greenhouse, platform: 'personio' }, xml);
  assert.equal(job.title, 'Data Engineer');
  assert.equal(job.location, 'Zurich');
  assert.match(job.descriptionHtml, /Build pipelines\./);
  assert.match(job.sourceUrl, /\/job\/42$/);
});

test('drops entries missing a URL, title or description', () => {
  const body = JSON.stringify({ jobs: [{ absolute_url: '', title: 'x', content: '' }, { absolute_url: 'u', title: '', content: 'c' }] });
  assert.equal(parseFeed(greenhouse, body).length, 0);
});

test('board fetching never has more requests in flight than the platform allows', async () => {
  // Cloudflare queues a seventh simultaneous connection per invocation. Opening more buys nothing
  // but waiting, so the pool is held to the platform's number.
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), BOARD_CONCURRENCY, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return i * 2;
  });
  assert.ok(peak <= BOARD_CONCURRENCY, `peak concurrency ${peak} exceeded ${BOARD_CONCURRENCY}`);
  assert.equal(peak, BOARD_CONCURRENCY, 'the pool should actually use its full width');
  assert.deepEqual(results, Array.from({ length: 40 }, (_, i) => i * 2), 'results must keep input order');
});

test('a slow board times out on its own and does not fail the search', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as typeof fetch;
  try {
    const started = Date.now();
    const outcome = await fetchCompany({ slug: 'slow', name: 'Slow', platform: 'greenhouse', country: 'netherlands' }, 50);
    assert.equal(outcome.status, 'timeout');
    assert.deepEqual(outcome.jobs, []);
    assert.ok(Date.now() - started < 1_000, 'the timeout did not cut the request short');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a board failure is classified, never collapsed to an empty list', async () => {
  const realFetch = globalThis.fetch;
  const company: AtsCompany = { slug: 'example', name: 'Example', platform: 'greenhouse', country: 'netherlands' };
  const okBody = JSON.stringify({ jobs: [{
    absolute_url: 'https://boards.greenhouse.io/example/jobs/1', title: 'Data Analyst',
    location: { name: 'Amsterdam, Netherlands' }, content: '<p>Work.</p>',
  }] });
  try {
    globalThis.fetch = (async () => new Response(okBody, { status: 200 })) as typeof fetch;
    const ok = await fetchCompany(company);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.jobs.length, 1);
    assert.equal(ok.httpStatus, undefined);

    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as typeof fetch;
    const missing = await fetchCompany(company);
    assert.equal(missing.status, 'http-error');
    assert.equal(missing.httpStatus, 404);
    assert.deepEqual(missing.jobs, []);

    globalThis.fetch = (async () => new Response('slow down', { status: 429 })) as typeof fetch;
    const limited = await fetchCompany(company);
    assert.equal(limited.status, 'http-error');
    assert.equal(limited.httpStatus, 429);

    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const network = await fetchCompany(company);
    assert.equal(network.status, 'network-error');
    assert.deepEqual(network.jobs, []);

    globalThis.fetch = (async () => new Response('not json{{{', { status: 200 })) as typeof fetch;
    const unparseable = await fetchCompany(company);
    assert.equal(unparseable.status, 'parse-error');
    assert.deepEqual(unparseable.jobs, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a refusal stops the retry, a transient failure gets exactly one more try', () => {
  assert.equal(isBoardRefusal({ status: 'http-error', httpStatus: 429 }), true);
  assert.equal(isBoardRefusal({ status: 'http-error', httpStatus: 403 }), true);
  assert.equal(isBoardRefusal({ status: 'http-error', httpStatus: 404 }), true);
  assert.equal(isBoardRefusal({ status: 'http-error', httpStatus: 500 }), false);
  assert.equal(isBoardRefusal({ status: 'timeout' }), false);
  assert.equal(isBoardRefusal({ status: 'ok' }), false);
  assert.equal(isBoardRetryable({ status: 'timeout' }), true);
  assert.equal(isBoardRetryable({ status: 'network-error' }), true);
  assert.equal(isBoardRetryable({ status: 'http-error', httpStatus: 500 }), true);
  assert.equal(isBoardRetryable({ status: 'http-error', httpStatus: 429 }), false);
  assert.equal(isBoardRetryable({ status: 'http-error', httpStatus: 404 }), false);
  assert.equal(isBoardRetryable({ status: 'ok' }), false);
  assert.equal(isBoardRetryable({ status: 'parse-error' }), false);
});

test('the board search retries a transient failure once but never a refusal', async () => {
  const realFetch = globalThis.fetch;
  const flakyUrl = feedUrl(atsCompanies[0]);
  const limitedUrl = feedUrl(atsCompanies[1]);
  const calls = new Map<string, number>();
  try {
    globalThis.fetch = (async (url: string) => {
      const count = (calls.get(url) ?? 0) + 1;
      calls.set(url, count);
      if (url === flakyUrl && count === 1) throw new TypeError('fetch failed');
      if (url === limitedUrl) return new Response('slow down', { status: 429 });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const outcomes = await searchAtsBoardsDetailed();
    assert.equal(outcomes.length, atsCompanies.length);
    // Every configured board resolves an outcome; no rejection escapes the search.
    assert.ok(outcomes.every((outcome) => outcome.jobs !== undefined && outcome.durationMs >= 0));
    const flaky = outcomes.find((outcome) => outcome.company.slug === atsCompanies[0].slug)!;
    assert.equal(flaky.status, 'ok', 'one retry recovers a transient network failure');
    assert.equal(calls.get(flakyUrl), 2, 'a transient failure is retried exactly once');
    const limited = outcomes.find((outcome) => outcome.company.slug === atsCompanies[1].slug)!;
    assert.equal(limited.status, 'http-error');
    assert.equal(limited.httpStatus, 429);
    assert.equal(calls.get(limitedUrl), 1, 'a 429 refusal is a stop signal, never retried');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('parses a Teamtailor JSON feed, taking the country from its ISO code', () => {
  // Shape copied from a live board: a JSON Feed whose items carry the whole advertisement in
  // content_html and a schema.org JobPosting with a structured address.
  const company: AtsCompany = { slug: 'example', name: 'Example', platform: 'teamtailor', country: 'netherlands' };
  const body = JSON.stringify({
    version: 'https://jsonfeed.org/version/1',
    title: 'Example',
    items: [
      {
        id: 'a', title: 'Data Analyst', url: 'https://example.teamtailor.com/jobs/1-data-analyst',
        date_published: '2026-05-26T00:00:00+02:00',
        content_html: '<h4>About the role</h4><p>You have three years of SQL experience.</p>',
        _jobposting: {
          jobLocation: [{ address: { addressLocality: 'Amsterdam', addressCountry: 'NL', addressRegion: 'Netherlands' } }],
        },
      },
      {
        id: 'b', title: 'Support Engineer', url: 'https://example.teamtailor.com/jobs/2-support',
        content_html: '<p>Some duties.</p>',
        _jobposting: {
          jobLocation: [
            { address: { addressLocality: 'Zürich', addressCountry: 'CH' } },
            { address: { addressLocality: 'Ontario', addressCountry: 'CA', addressRegion: 'Canada' } },
          ],
        },
      },
      { id: 'c', title: 'No description', url: 'https://example.teamtailor.com/jobs/3', content_html: '' },
    ],
  });

  const jobs = parseFeed(company, body);
  assert.equal(jobs.length, 2, 'a posting with no description is dropped, as on every other board');
  assert.equal(jobs[0].title, 'Data Analyst');
  assert.equal(jobs[0].location, 'Amsterdam, Netherlands');
  assert.match(jobs[0].descriptionHtml, /three years of SQL/);
  assert.equal(jobs[0].postedAt, '2026-05-26T00:00:00+02:00');
  // Several locations arrive joined the way other boards send them, so one country rule reads all.
  assert.equal(jobs[1].location, 'Zürich, Switzerland; Ontario, Canada');
  assert.equal(countryFromLocation(jobs[1].location), 'switzerland');
});

test('a Teamtailor posting with no usable location falls back to the company country', () => {
  const company: AtsCompany = { slug: 'example', name: 'Example', platform: 'teamtailor', country: 'switzerland' };
  const body = JSON.stringify({ items: [{ id: 'a', title: 'Engineer', url: 'https://example.teamtailor.com/jobs/1', content_html: '<p>Work.</p>' }] });
  assert.equal(parseFeed(company, body)[0].location, 'Switzerland');
});

test('parses a Workable widget feed', () => {
  // Shape copied from live boards: the widget endpoint with details=true returns every posting
  // with its whole advertisement, and spells the country out rather than using a code.
  const company: AtsCompany = { slug: 'example', name: 'Example', platform: 'workable', country: 'switzerland' };
  const body = JSON.stringify({
    name: 'Example',
    jobs: [
      {
        title: 'Analog Electronics Engineer', shortcode: '0285F85DC7',
        url: 'https://apply.workable.com/j/0285F85DC7',
        country: 'Switzerland', city: 'Zürich', published_on: '2026-09-15',
        description: '<p>You have five years of experience designing analogue front ends.</p>',
      },
      {
        title: 'Data & AI Engineer', shortcode: 'X', url: 'https://apply.workable.com/j/X',
        country: 'Greece', city: 'Athens', description: '<p>Consultancy work.</p>',
      },
      { title: 'Empty', url: 'https://apply.workable.com/j/Y', country: 'Netherlands', city: 'Utrecht', description: '' },
    ],
  });

  const jobs = parseFeed(company, body);
  assert.equal(jobs.length, 2, 'a posting with no description is dropped');
  assert.equal(jobs[0].location, 'Zürich, Switzerland');
  assert.equal(countryFromLocation(jobs[0].location), 'switzerland');
  assert.match(jobs[0].descriptionHtml, /five years of experience/);
  assert.equal(jobs[0].postedAt, '2026-09-15');
  // A board is one company but its postings are worldwide; the country comes from the posting.
  assert.equal(countryFromLocation(jobs[1].location), 'unknown');
});

test('a Workable posting with no place falls back to the company country', () => {
  const company: AtsCompany = { slug: 'example', name: 'Example', platform: 'workable', country: 'netherlands' };
  const body = JSON.stringify({ jobs: [{ title: 'Engineer', url: 'https://apply.workable.com/j/Z', description: '<p>Work.</p>' }] });
  assert.equal(parseFeed(company, body)[0].location, 'Netherlands');
});

test('no employer board is configured twice', () => {
  const keys = atsCompanies.map((company) => `${company.platform}:${company.slug.toLowerCase()}`);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual(duplicates, []);
});

test('two concurrent board searches share one underlying collection', async () => {
  // #83: the ats-ch and ats-nl adapters start together under Promise.all while no finished
  // result is cached yet. The second caller must await the collection already in flight
  // instead of launching its own 282-board batch. (This test populates the 60-second result
  // cache, so it stays last and no other test calls searchAtsBoards.)
  const realFetch = globalThis.fetch;
  const calls = new Map<string, number>();
  try {
    globalThis.fetch = (async (url: string) => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      // Hold every board open briefly so both callers are guaranteed to overlap in flight.
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const [first, second] = await Promise.all([searchAtsBoards(), searchAtsBoards()]);
    assert.deepEqual(second, first, 'concurrent callers must see the same collection');
    assert.equal(calls.size, atsCompanies.length, 'every board is still collected');
    for (const [url, count] of calls) {
      assert.equal(count, 1, `duplicate collection for ${url}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
