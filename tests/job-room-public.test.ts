import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advertisementToParsedJob,
  JOB_ROOM_DETAIL_DELAY_MS,
  JOB_ROOM_PAGE_SIZE,
  MAX_JOB_ROOM_DETAIL_FETCHES,
  MAX_PAGES_PER_TERM,
  searchJobRoom,
  type JobRoomAdvertisement,
} from '../lib/job-room';

/**
 * INT-08 (#167): public-traffic validation for the Job-Room adapter.
 *
 * Every test here runs against recorded response shapes with `fetch` stubbed —
 * no live calls. The shapes mirror the real API: search answers an array of
 * `{ jobAdvertisement }` wrappers, detail answers `{ jobAdvertisement }` (or the
 * advertisement itself), dates nest under `publication`, and descriptions carry
 * a `languageIsoCode`. A bounded live probe on 2026-09-24 was answered with a
 * WAF block page (HTTP 400 "Unauthorized Request Blocked"), so these fixtures
 * are code-recorded rather than freshly captured; the adapter stops on any such
 * block instead of retrying.
 */

const LONG_TEXT = 'Full advertisement text with the requirements section near the end. '.repeat(80).trim();
const SHORT_TEXT = 'Short preview without the requirements section. '.repeat(5).trim();

function advertisement(
  id: string,
  description: string,
  startDate: string,
  languageIsoCode = 'en',
): JobRoomAdvertisement {
  return {
    id,
    publication: { startDate, endDate: '2026-12-31' },
    status: 'PUBLISHED_PUBLIC',
    jobContent: {
      externalUrl: null,
      jobDescriptions: [
        { languageIsoCode: 'de', title: `<em>Datenanalyst</em> ${id}`, description: 'Kurze deutsche Vorschau.' },
        { languageIsoCode, title: `Data Analyst ${id}`, description },
      ],
      company: { name: 'Example AG' },
      location: { city: 'Bern', postalCode: '3000', cantonCode: 'BE' },
      languageSkills: [{ languageIsoCode: 'en', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' }],
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Stub fetch with a queue of search pages (arrays of advertisements) and a map
 * of detail responses by id. Counts every request so paging and detail caps are
 * asserted, not assumed.
 */
function stubJobRoom(pages: JobRoomAdvertisement[][], details: Map<string, JobRoomAdvertisement>) {
  const calls = { searches: [] as string[], details: [] as string[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/_search')) {
      calls.searches.push(url);
      const page = Number(new URL(url).searchParams.get('page') ?? '0');
      const items = pages[Math.min(page, pages.length - 1)] ?? [];
      return jsonResponse(items.map((jobAdvertisement) => ({ jobAdvertisement })));
    }
    const id = decodeURIComponent(url.split('/').pop() ?? '');
    calls.details.push(id);
    const found = details.get(id);
    return found ? jsonResponse({ jobAdvertisement: found }) : new Response('gone', { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function previewPage(ids: string[], startDate: string): JobRoomAdvertisement[] {
  return ids.map((id) => advertisement(id, SHORT_TEXT, startDate));
}

test('field mapping matches the recorded API shape', () => {
  const parsed = advertisementToParsedJob(advertisement('abc-123', LONG_TEXT, '2026-09-10'));
  assert.ok(parsed);
  // The English description wins over the German one, and search highlighting is stripped.
  assert.equal(parsed.title, 'Data Analyst abc-123');
  assert.equal(parsed.descriptionHtml, LONG_TEXT);
  assert.equal(parsed.company, 'Example AG');
  assert.equal(parsed.location, 'Bern 3000 BE');
  assert.equal(parsed.sourceUrl, 'https://www.job-room.ch/job-search/abc-123');
  // Dates live nested under publication, not at the top level.
  assert.equal(parsed.postedAt, '2026-09-10');
  assert.equal(parsed.expiresAt, '2026-12-31');
  assert.equal(parsed.languageSkills.length, 1);
});

test('paging stops at the first short page', async () => {
  const full = previewPage(Array.from({ length: JOB_ROOM_PAGE_SIZE }, (_, i) => `full-${i}`), '2026-09-10');
  const short = previewPage(['tail-1', 'tail-2', 'tail-3'], '2026-09-11');
  const stub = stubJobRoom([full, short], new Map());
  try {
    const jobs = await searchJobRoom(['analyst'], undefined, { fullText: false });
    assert.equal(stub.calls.searches.length, 2);
    assert.equal(jobs.length, JOB_ROOM_PAGE_SIZE + 3);
  } finally {
    stub.restore();
  }
});

test('paging never exceeds the per-term page cap', async () => {
  // Every page full: without a cap this would page forever. Each page carries
  // distinct ids so nothing is deduplicated away.
  const pages = Array.from({ length: MAX_PAGES_PER_TERM + 4 }, (_, page) =>
    previewPage(Array.from({ length: JOB_ROOM_PAGE_SIZE }, (_, i) => `p${page}-${i}`), '2026-09-10'));
  const stub = stubJobRoom(pages, new Map());
  try {
    const jobs = await searchJobRoom(['analyst'], undefined, { fullText: false });
    assert.equal(stub.calls.searches.length, MAX_PAGES_PER_TERM);
    assert.equal(jobs.length, MAX_PAGES_PER_TERM * JOB_ROOM_PAGE_SIZE);
  } finally {
    stub.restore();
  }
});

test('advertisements repeated across pages are stored once', async () => {
  // Page 0 must be full, or paging stops before page 1 is ever read.
  const first = [
    ...previewPage(Array.from({ length: JOB_ROOM_PAGE_SIZE - 1 }, (_, i) => `seen-${i}`), '2026-09-10'),
    ...previewPage(['dup'], '2026-09-10'),
  ];
  const stub = stubJobRoom([first, previewPage(['dup', 'c'], '2026-09-11')], new Map());
  try {
    const jobs = await searchJobRoom(['analyst'], undefined, { fullText: false });
    assert.equal(stub.calls.searches.length, 2);
    assert.equal(jobs.length, JOB_ROOM_PAGE_SIZE + 1);
    assert.equal(new Set(jobs.map((job) => job.sourceUrl)).size, jobs.length);
  } finally {
    stub.restore();
  }
});

test('the detail pass upgrades the newest short previews within its cap', async () => {
  const ids = ['oldest', 'mid-old', 'mid', 'mid-new', 'newest'];
  const dates = ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];
  const stub = stubJobRoom(
    [ids.map((id, i) => advertisement(id, SHORT_TEXT, dates[i]))],
    new Map(ids.map((id, i) => [id, advertisement(id, LONG_TEXT, dates[i])])),
  );
  try {
    const jobs = await searchJobRoom(['analyst'], undefined, { fullText: true, maxDetails: 3, delayMs: 0 });
    assert.equal(stub.calls.details.length, 3);
    const byTitle = new Map(jobs.map((job) => [job.title, job.descriptionHtml]));
    // Newest first: the budget goes to the advertisements still worth applying for.
    assert.equal(byTitle.get('Data Analyst newest'), LONG_TEXT);
    assert.equal(byTitle.get('Data Analyst mid-new'), LONG_TEXT);
    assert.equal(byTitle.get('Data Analyst mid'), LONG_TEXT);
    assert.equal(byTitle.get('Data Analyst mid-old'), SHORT_TEXT);
    assert.equal(byTitle.get('Data Analyst oldest'), SHORT_TEXT);
  } finally {
    stub.restore();
  }
});

test('the worst-case public volume is bounded and matches the registered basis', () => {
  // Per role keyword: at most 6 pages of 100 previews, then at most 200 detail
  // reads at a fixed 400ms interval — about 80 seconds, all of it paced.
  assert.equal(MAX_PAGES_PER_TERM * JOB_ROOM_PAGE_SIZE, 600);
  assert.equal((MAX_JOB_ROOM_DETAIL_FETCHES * JOB_ROOM_DETAIL_DELAY_MS) / 1000, 80);
});
