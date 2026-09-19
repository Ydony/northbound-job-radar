import assert from 'node:assert/strict';
import test from 'node:test';
import { atsCompanies, BOARD_CONCURRENCY, fetchCompany, feedUrl, mapWithConcurrency,
  parseFeed, type AtsCompany } from '../lib/ats-feeds';
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
    const jobs = await fetchCompany({ slug: 'slow', name: 'Slow', platform: 'greenhouse', country: 'netherlands' }, 50);
    assert.deepEqual(jobs, []);
    assert.ok(Date.now() - started < 1_000, 'the timeout did not cut the request short');
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
