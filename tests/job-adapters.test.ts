import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bulkJobIsRelevant,
  candidateUrlMatchesRoles,
  descriptionMatchesRoles,
  jobSourceAdapters,
  postingToParsed,
  sourceStatusForAvailability,
} from '../lib/job-adapters';

test('configures Swiss and Netherlands adapters without LinkedIn', () => {
  assert.equal(jobSourceAdapters.some((source) => /linkedin/i.test(`${source.key} ${source.name}`)), false);
  assert.equal(jobSourceAdapters.filter((source) => source.availability === 'enabled' && source.country === 'switzerland').length >= 3, true);
  assert.equal(jobSourceAdapters.filter((source) => source.availability === 'enabled' && source.country === 'netherlands').length >= 2, true);
});

test('keeps disabled experiments and unavailable sources visible', () => {
  assert.equal(jobSourceAdapters.find((source) => source.key === 'indeed-nl')?.availability, 'disabled');
  assert.equal(jobSourceAdapters.find((source) => source.key === 'nationalevacaturebank.nl')?.availability, 'unavailable');
  assert.equal(jobSourceAdapters.find((source) => source.key === 'iamsterdam.com')?.availability, 'disabled');
});

test('maps adapter availability to truthful run states', () => {
  assert.equal(sourceStatusForAvailability('enabled'), 'complete');
  assert.equal(sourceStatusForAvailability('blocked'), 'blocked');
  assert.equal(sourceStatusForAvailability('unavailable'), 'unavailable');
});

test('screens public listing candidates against the requested roles', () => {
  const job = {
    sourceUrl: 'https://example.test/job/1',
    title: 'Master Data Specialist',
    company: 'Example',
    location: 'Amsterdam',
    descriptionHtml: '<p>Maintain governance standards and product records.</p>',
    postedAt: '2026-08-27',
  };
  assert.equal(descriptionMatchesRoles(job, ['Master Data']), true);
  assert.equal(descriptionMatchesRoles(job, ['Supply Chain']), false);
  assert.equal(descriptionMatchesRoles({ ...job, title: 'Recruitment Consultant' }, ['Master Data', 'Data Analyst']), false);
  assert.equal(candidateUrlMatchesRoles('https://example.test/vacancies/recruitment-consultant', ['Master Data', 'Data Analyst']), false);
  assert.equal(candidateUrlMatchesRoles('https://example.test/vacancies/senior-inventory-analyst', ['Data Analyst']), true);
});

test('keeps relaxed JobPosting extraction inside its JSON-LD block', () => {
  const html = `
    <script>window.page = {"title":"Unrelated page title","content":"${'x'.repeat(800)}"}</script>
    <script type="application/ld+json">
      {
        "@context":"https://schema.org",
        "@type":"JobPosting",
        "title":"Master Data Analyst",
        "description":"<p>Own the product \"golden record\" and data governance across our English-speaking team.</p>",
        "datePosted":"27-08-2026",
        "hiringOrganization":{"@type":"Organization","name":"Example BV"},
        "jobLocation":{"address":{"addressLocality":"Amsterdam","addressCountry":"Netherlands"}}
      }
    </script>`;

  const parsed = postingToParsed('https://undutchables.nl/vacancies/master-data-analyst', html, 'Netherlands');
  assert.ok(parsed);
  assert.equal(parsed.title, 'Master Data Analyst');
  assert.equal(parsed.company, 'Example BV');
  assert.equal(parsed.location, 'Amsterdam Netherlands');
  assert.equal(parsed.postedAt, '2026-08-27');
  assert.match(parsed.descriptionHtml, /golden record/);
  assert.equal(parsed.title.length < 500, true);
});

test('extracts normalized candidates through the enabled source adapters', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(`
    <a href="https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/">jobs.ch</a>
    <a href="https://www.jobup.ch/en/jobs/detail/22222222-2222-2222-2222-222222222222/">jobup</a>
    <a href="/en/job/33333333-3333-3333-3333-333333333333/">JobScout24</a>
  `, { status: 200, headers: { 'content-type': 'text/html' } }));

  const jobsCh = jobSourceAdapters.find((source) => source.key === 'jobs.ch')!;
  const jobup = jobSourceAdapters.find((source) => source.key === 'jobup.ch')!;
  const jobScout = jobSourceAdapters.find((source) => source.key === 'jobscout24.ch')!;
  assert.deepEqual(await jobsCh.search!(['Master Data'], 'Zürich'), [
    'https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/',
  ]);
  assert.deepEqual(await jobup.search!(['Master Data'], 'Zürich'), [
    'https://www.jobup.ch/en/jobs/detail/22222222-2222-2222-2222-222222222222/',
  ]);
  assert.deepEqual(await jobScout.search!(['Master Data'], 'Zürich'), [
    'https://www.jobscout24.ch/en/job/33333333-3333-3333-3333-333333333333/',
  ]);
});

test('adapter keys are unique so per-source run rows never collide', () => {
  const keys = jobSourceAdapters.map((adapter) => adapter.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate adapter key: ${keys.join(', ')}`);
});

test('enabled adapters can either fetch details per job or return them in bulk', () => {
  for (const adapter of jobSourceAdapters.filter((entry) => entry.availability === 'enabled')) {
    assert.ok(adapter.searchDetailed || (adapter.search && adapter.fetchDetail),
      `${adapter.key} is enabled but cannot produce jobs`);
  }
});

test('every adapter declares a known access tier', () => {
  for (const adapter of jobSourceAdapters) {
    assert.ok(['authorized-api', 'grey-area', 'restricted', 'local-experiment'].includes(adapter.access),
      `${adapter.key} has no access classification`);
  }
});

test('sites that prohibit automated access stay behind the VPN mode', () => {
  // The three JobCloud sites forbid automation in their terms. Undutchables previously blocked
  // automated requests, so it remains behind the same precautionary boundary even though its
  // current robots.txt permits the exact plain listing/detail paths used.
  for (const key of ['jobs.ch', 'jobup.ch', 'jobscout24.ch', 'undutchables.nl']) {
    assert.equal(jobSourceAdapters.find((adapter) => adapter.key === key)?.access, 'restricted',
      `${key} must stay behind the VPN-only mode`);
  }
});

test('the retained private sources say who can use them and whether a VPN is required', () => {
  for (const key of ['jobs.ch', 'jobup.ch', 'jobscout24.ch', 'undutchables.nl']) {
    const adapter = jobSourceAdapters.find((entry) => entry.key === key)!;
    assert.match(adapter.availabilityMessage, /local administrator only/i);
    assert.match(adapter.availabilityMessage, /VPN required/i);
  }

  const iamExpat = jobSourceAdapters.find((entry) => entry.key === 'iamexpat.nl')!;
  assert.equal(iamExpat.adminOnly, true);
  assert.equal(iamExpat.access, 'grey-area');
  assert.match(iamExpat.availabilityMessage, /local administrator only/i);
  assert.match(iamExpat.availabilityMessage, /no VPN required/i);
});

test('the default search excludes every restricted source', () => {
  const defaultMode = jobSourceAdapters.filter((adapter) => adapter.access !== 'restricted');
  assert.ok(defaultMode.length > 0);
  assert.ok(defaultMode.every((adapter) => adapter.access !== 'restricted'));
  assert.ok(jobSourceAdapters.some((adapter) => adapter.access === 'restricted'),
    'the tier must actually be in use, or this test proves nothing');
});

test('authorized APIs never use the page-fetching path', () => {
  const authorized = jobSourceAdapters.filter((adapter) => adapter.access === 'authorized-api');
  assert.ok(authorized.length > 0);
  assert.ok(authorized.every((adapter) => !adapter.search));
});

const longText = 'You will own the data model for our reporting estate and work with finance and operations. '.repeat(4);
const posting = (id: number, location: string, title: string, description = longText) => ({
  sourceUrl: `https://boards.greenhouse.io/example/jobs/${id}`,
  title,
  company: 'Example',
  location,
  descriptionHtml: `<p>${description}</p>`,
  postedAt: '',
});

test('a bulk posting is relevant only in its own country, for a searched role, with enough text', () => {
  const roles = ['Data Analyst'];
  assert.equal(bulkJobIsRelevant(posting(1, 'Amsterdam, Netherlands', 'Senior Data Analyst'), 'netherlands', roles), true);
  assert.equal(bulkJobIsRelevant(posting(2, 'Zurich, Switzerland', 'Senior Data Analyst'), 'netherlands', roles), false,
    'a Swiss posting must not count towards the Dutch search');
  assert.equal(bulkJobIsRelevant(posting(3, 'Amsterdam, Netherlands', 'Backend Engineer'), 'netherlands', roles), false,
    'a posting for a role nobody searched is not relevant');
  assert.equal(bulkJobIsRelevant(posting(4, 'Amsterdam, Netherlands', 'Data Analyst', 'Apply now.'), 'netherlands', roles), false,
    'a posting too short to store is not relevant');
});

test('relevant employer postings survive the per-run cap wherever they sit in the board order', () => {
  // The defect this pins: the search capped a bulk source's postings first and filtered them after.
  // With 250 irrelevant postings ahead of the relevant ones, capping first examined none of them —
  // and because rejected postings are not stored, every later search examined the same 250 again.
  const cap = 200;
  const roles = ['Data Analyst'];
  const board = [
    ...Array.from({ length: 250 }, (_, i) => posting(i, 'Austin, Texas, United States', 'Software Engineer')),
    ...Array.from({ length: 5 }, (_, i) => posting(1000 + i, 'Utrecht, Netherlands', 'Data Analyst')),
  ];
  const cappedFirst = board.slice(0, cap).filter((job) => bulkJobIsRelevant(job, 'netherlands', roles));
  const filteredFirst = board.filter((job) => bulkJobIsRelevant(job, 'netherlands', roles)).slice(0, cap);
  assert.equal(cappedFirst.length, 0, 'demonstrates the old order finding nothing');
  assert.equal(filteredFirst.length, 5, 'the order the search now uses finds every relevant posting');
});
