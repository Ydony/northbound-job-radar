import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLanguage } from '../lib/analysis';
import { EURES_PAGE_SIZE, euresJobToParsedJob, euresSortFor, MAX_EURES_PAGES_PER_TERM, searchEures } from '../lib/eures';
import { stripHtml } from '../lib/jobsch';

// A real-shaped EURES record: the portal shows "Working languages: Dutch" for this, and the
// advertisement never once asks for Dutch.
const dutchFlaggedEnglishJob = {
  id: 'abc123',
  title: 'Data Analyst Operations',
  description: [
    '<p>We are looking for a data analyst to join our operations team in Amsterdam.</p>',
    '<ul><li>Analyse operational data and build reporting</li>',
    '<li>Work with stakeholders across the business</li>',
    '<li>Experience with SQL and Power BI</li></ul>',
    '<p>You will report to the head of operations. The working language of the team is English,',
    'and all documentation and meetings are in English. We offer a permanent contract, flexible',
    'hours and a training budget. Applications are reviewed weekly and we respond to every',
    'candidate within ten working days. Our customers are international businesses and the role',
    'involves regular contact with them across several countries in Europe and beyond.</p>',
    // Long enough to clear MIN_CHARS_TO_CONFIRM_ENGLISH. A shorter fixture returns `unknown`,
    // which is correct behaviour but would test the length gate rather than the point at issue.
    '<p>The operations team owns the reporting that the business runs on, from daily dashboards',
    'through to the monthly review pack. You will own a portion of that directly and be expected',
    'to improve it rather than only maintain it. We care more about clear thinking and careful',
    'work than about any particular tool, and we will support you in learning whatever the role',
    'turns out to need. The company has grown steadily for eight years and the team has grown',
    'with it, so there is room to take on more responsibility as you go.</p>',
  ].join(' '),
  creationDate: 1786800601812,
  employer: { name: 'Example BV' },
  locationMap: { NL: ['NL32B'] },
  availableLanguages: ['nl'],
};

test('carries the advertisement language through without letting it decide anything', () => {
  const parsed = euresJobToParsedJob(dutchFlaggedEnglishJob, 'Netherlands');
  assert.ok(parsed);
  // Kept for display and debugging...
  assert.deepEqual(parsed.adLanguages, ['nl']);

  // ...but the verdict comes from the advertisement, which never asks for Dutch. Trusting the
  // portal's "Working languages: Dutch" instead would discard 44% of the Netherlands results,
  // measured against 50 live listings - including full-length ads that are genuine matches.
  const verdict = analyzeLanguage(stripHtml(parsed.descriptionHtml), parsed.title);
  assert.equal(verdict.status, 'pass');
});

test('maps the EURES record onto the shared job shape', () => {
  const parsed = euresJobToParsedJob(dutchFlaggedEnglishJob, 'Netherlands');
  assert.ok(parsed);
  assert.equal(parsed.title, 'Data Analyst Operations');
  assert.equal(parsed.company, 'Example BV');
  // The NUTS code is resolved to its name at ingest: NL32B is Groot-Amsterdam. Stored raw it
  // would surface as "NL32B" on the card and in the location facet, which helps nobody.
  assert.equal(parsed.location, 'Groot-Amsterdam');
  assert.match(parsed.sourceUrl, /europa\.eu\/eures\/portal\/jv-se\/jv-details\/abc123/);
  assert.equal(parsed.postedAt.slice(0, 4), '2026');
});

test('refuses a record with no usable advertisement', () => {
  assert.equal(euresJobToParsedJob({ id: 'x', title: '', description: 'body' }, 'Netherlands'), null);
  assert.equal(euresJobToParsedJob({ id: 'x', title: 'Role', description: '' }, 'Netherlands'), null);
});

test('never confirms English on a Netherlands advertisement cut off with an ellipsis', () => {
  // Shape of the measured NL truncation: ~2,000 characters ending in "...", usually before the
  // requirements. The requirement after the cut is never in the checked text, so this is
  // incomplete evidence (unknown), not a pass — even though the visible text is English.
  const truncated = {
    ...dutchFlaggedEnglishJob,
    description: `${dutchFlaggedEnglishJob.description}...`,
  };
  const parsed = euresJobToParsedJob(truncated, 'Netherlands');
  assert.ok(parsed);
  const verdict = analyzeLanguage(stripHtml(parsed.descriptionHtml), parsed.title);
  assert.equal(verdict.status, 'unknown');
  assert.match(verdict.summary, /cut off/i);
});

test('EURES paging limits stay explicit and bounded', () => {
  assert.equal(EURES_PAGE_SIZE, 50);
  // Raised from 2 on the same measurement that moved Job-Room (#95/#96): BEST_MATCH mixes
  // dates across months on every page while totals run to 2,192 (CH) and 12,306 (NL) for a
  // single term, so fresh advertisements sat past the 100 being read and were never found.
  assert.equal(MAX_EURES_PAGES_PER_TERM, 6);
});

test('Switzerland searches newest-first, the Netherlands by relevance', () => {
  // Measured 2026-09-20 across three terms, not assumed: MOST_RECENT puts every fresh CH
  // advertisement on page 1, while NL is not date-ordered under either value and BEST_MATCH
  // surfaces roughly twice as many fresh NL advertisements per page.
  assert.equal(euresSortFor('switzerland'), 'MOST_RECENT');
  assert.equal(euresSortFor('netherlands'), 'BEST_MATCH');
});

function euresRecord(id: string) {
  return {
    id,
    title: `Role ${id}`,
    description: '<p>A complete advertisement.</p>',
    creationDate: 1786800601812,
    employer: { name: 'Example BV' },
    locationMap: { NL: ['NL32B'] },
  };
}

async function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function sortsSeen(calls: string[]) {
  return calls.map((body) => (JSON.parse(body) as { sortSearch: string }).sortSearch);
}

test('each country asks for its own ordering', async () => {
  for (const [country, expected] of [['switzerland', 'MOST_RECENT'], ['netherlands', 'BEST_MATCH']] as const) {
    const bodies: string[] = [];
    await withFetch(async (_url, init) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ jvs: [] }), { status: 200 });
    }, async () => {
      await searchEures(['analyst'], country, 1);
    });
    assert.deepEqual(sortsSeen(bodies), [expected]);
  }
});

test('a rejected undocumented ordering falls back to relevance rather than failing', async () => {
  const bodies: string[] = [];
  await withFetch(async (_url, init) => {
    bodies.push(String(init?.body ?? ''));
    if (bodies.length === 1) return new Response('malformed', { status: 400 });
    return new Response(JSON.stringify({ jvs: [euresRecord('fallback-1')] }), { status: 200 });
  }, async () => {
    const jobs = await searchEures(['analyst'], 'switzerland', 1);
    assert.equal(jobs.length, 1);
  });
  assert.deepEqual(sortsSeen(bodies), ['MOST_RECENT', 'BEST_MATCH']);
});

test('a refused search still fails instead of returning nothing', async () => {
  await withFetch(async () => new Response('denied', { status: 403 }), async () => {
    await assert.rejects(searchEures(['analyst'], 'netherlands', 1), /EURES request failed \(403\)/);
  });
});

test('paging stops at the first short page', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    const size = calls === 1 ? EURES_PAGE_SIZE : 3;
    return new Response(
      JSON.stringify({ jvs: Array.from({ length: size }, (_, i) => euresRecord(`p${calls}-${i}`)) }),
      { status: 200 },
    );
  }, async () => {
    const jobs = await searchEures(['analyst'], 'netherlands', MAX_EURES_PAGES_PER_TERM);
    assert.equal(jobs.length, EURES_PAGE_SIZE + 3);
  });
  assert.equal(calls, 2);
});

test('a full page keeps reading up to the per-term cap', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ jvs: Array.from({ length: EURES_PAGE_SIZE }, (_, i) => euresRecord(`c${calls}-${i}`)) }),
      { status: 200 },
    );
  }, async () => {
    const jobs = await searchEures(['analyst'], 'netherlands');
    assert.equal(jobs.length, EURES_PAGE_SIZE * MAX_EURES_PAGES_PER_TERM);
  });
  assert.equal(calls, MAX_EURES_PAGES_PER_TERM);
});
