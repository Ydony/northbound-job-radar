#!/usr/bin/env node

import { randomBytes } from 'node:crypto';

/**
 * Synthetic volume check for server-side paging and facets (T43, INT-05/#140).
 *
 * The unit suite already proves the catalogue queries over ~2,600 synthetic rows
 * (`tests/catalogue-query.test.ts`), but nothing exercised the live HTTP surface the
 * browser actually drives — default 40-row pages, server facets/counts, filters — at
 * real volume. This registers a throwaway account, imports 2,050 synthetic
 * advertisements through `POST /api/jobs`, and asserts, over HTTP:
 *
 * - the default read returns a 40-row page plus whole-collection aggregates
 *   (`catalogue.matching`/`total` >= 2,050), never the whole holding;
 * - aggregates are identical on page one and page three (the #140 regression:
 *   counts derived from held rows instead of the filtered set);
 * - every existing filter narrows server-side on page one (country, source,
 *   application, language, view, sort) and unknown values are refused, not
 *   silently narrowed;
 * - a cursor walk visits every filtered holding exactly once and terminates;
 * - no advertisement text travels (`description` never on the wire).
 *
 * Loopback only, by assertion. It writes to whatever database the local server
 * points at and cleans up after itself (workspace reset, then account deletion),
 * but it must never be aimed at anything real. Cleanup failures exit non-zero
 * instead of being swallowed: a failed workspace reset or account deletion is
 * reported, never ignored.
 *
 * Administrator guard: on an empty database the first registrant becomes the
 * installer administrator, and the last administrator cannot self-delete
 * (`DELETE /api/account` answers 409). Seeding 2,050 rows under such an
 * account and then silently failing to delete it would strand an admin whose
 * random password nobody knows. So right after registering, this reads the
 * account role from `GET /api/state` and aborts before seeding when it is
 * `admin` — register your real administrator first, or aim
 * `IKBENEENAPPEL_VERIFY_URL` at a throwaway database.
 *
 * Seeding lesson (previous attempt failed here): never insert thousands of rows
 * in one statement or one D1 batch (`Failed to execute statement`). One
 * `POST /api/jobs` per advertisement keeps every write a single small
 * statement; the imports run sequentially, which also stays clear of the
 * registration/auth rate limits. Expect a few minutes for 2,050 imports.
 *
 *   npm run dev                                    # in one terminal
 *   npm run verify:catalogue-volume
 */

const VOLUME = 2050;
const PAGE = 40;
const APPLIED = 30;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function session(baseUrl, origin) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, options = {}) {
      const headers = new Headers(options.headers);
      headers.set('Origin', origin);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0];
      return { response, data: await response.json().catch(() => null) };
    },
  };
}

async function expectStatus(result, status, label) {
  assert(result.response.status === status,
    `${label}: expected ${status}, received ${result.response.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

// ~600 characters of plain English operations prose: long enough for the manual
// import minimum (160), short enough to stay cheap, and identical in shape for
// every row so language verdicts never enter the assertions. Deterministic
// facet dimensions (country, source, application) carry the filter proofs.
function descriptionFor(index) {
  return `We are hiring an operations analyst to improve enterprise data quality, metadata,
master data controls, governance processes, reporting, stakeholder collaboration and
supply-chain data. This is a permanent role in an international team where all
meetings, documentation and day-to-day collaboration are conducted in English. You will
define standards, analyse quality issues, facilitate workshops with business
stakeholders, and deliver measurable improvements across several functions. Volume row ${index}.`;
}

async function main() {
  const baseUrl = process.env.IKBENEENAPPEL_VERIFY_URL ?? 'http://127.0.0.1:3000';
  const parsedBase = new URL(baseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsedBase.hostname)) {
    throw new Error('The volume verifier refuses to run against a non-local URL.');
  }
  const origin = parsedBase.origin;
  const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const password = `Local-only-${randomBytes(16).toString('base64url')}!`;
  const email = `volume-${runId}@example.test`;
  const client = session(baseUrl, origin);
  const importedIds = [];
  let accountDeleted = false;
  let accountRole = '';

  try {
    console.log('1/6 Registering a disposable account...');
    const registered = await client.request('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', email, password }),
    });
    const regData = await expectStatus(registered, 200, `register ${email}`);
    if (regData.verificationRequired) {
      assert(typeof regData.verificationToken === 'string' && regData.verificationToken.length > 0,
        'Local registration without a sender must hand back a verification token.');
      const confirmed = await client.request(`/api/auth/verify?token=${encodeURIComponent(regData.verificationToken)}`);
      await expectStatus(confirmed, 200, `verify ${email}`);
    }
    // On an empty database this disposable account is the installer
    // administrator, which cannot self-delete. Abort before seeding rather
    // than stranding it (with 2,050 rows) behind an unknown random password.
    const roleCheck = await client.request('/api/state?limit=1');
    const roleData = await expectStatus(roleCheck, 200, 'role check');
    accountRole = roleData?.account?.role ?? '';
    assert(accountRole, 'role check returned no account role');
    if (accountRole === 'admin') {
      throw new Error(
        `Refusing to seed: ${email} became the installer administrator (first registrant on an empty database, `
        + 'which cannot self-delete). Register your real administrator first, or aim IKBENEENAPPEL_VERIFY_URL '
        + `at a throwaway database. Leaving ${email} in place; nothing was seeded.`,
      );
    }

    console.log(`2/6 Importing ${VOLUME} synthetic advertisements (one request per row)...`);
    for (let index = 0; index < VOLUME; index += 1) {
      // Two hosts, two countries: the source and country facets each get two
      // deterministic values via the `.ch`/`.nl` rule in `sourceInfoForUrl`,
      // with no dependence on language-gate verdicts.
      const swiss = index % 2 === 0;
      const host = swiss ? 'example.ch' : 'example.nl';
      const result = await client.request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUrl: `https://${host}/jobs/volume-${runId}-${index}`,
          title: `Volume Operations Analyst ${String(index).padStart(4, '0')}`,
          company: 'Volume Check Company',
          location: swiss ? 'Zürich, Switzerland' : 'Amsterdam, Netherlands',
          postedAt: '2026-09-17',
          description: descriptionFor(index),
        }),
      });
      const data = await expectStatus(result, 200, `import job ${index}`);
      importedIds.push(data.job.id);
      if ((index + 1) % 250 === 0) console.log(`      ...${index + 1}/${VOLUME}`);
    }
    assert(importedIds.length === VOLUME, `expected ${VOLUME} imports, got ${importedIds.length}`);

    console.log('3/6 Marking 30 rows applied for the application facet...');
    for (let index = 0; index < APPLIED; index += 1) {
      const result = await client.request(`/api/jobs/${importedIds[index]}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationStatus: 'applied' }),
      });
      await expectStatus(result, 200, `mark applied ${index}`);
    }

    console.log('4/6 Reading the default page: 40 rows plus whole-collection aggregates...');
    const first = await expectStatus(await client.request('/api/state'), 200, 'default state read');
    assert(first.catalogue, 'default /api/state has no catalogue block: server-side paging is not serving');
    assert(first.jobs.length === PAGE, `default page holds ${first.jobs.length} rows, expected ${PAGE}`);
    assert(first.jobLimit === PAGE, `default jobLimit is ${first.jobLimit}, expected ${PAGE}`);
    assert(first.catalogue.matching >= VOLUME,
      `catalogue.matching is ${first.catalogue.matching}, expected >= ${VOLUME}`);
    assert(first.catalogue.total >= VOLUME,
      `catalogue.total is ${first.catalogue.total}, expected >= ${VOLUME}`);
    assert(first.matchingJobs === first.catalogue.matching, 'matchingJobs disagrees with catalogue.matching');
    assert(first.nextCursor, 'a 2,050-row holding must paginate past page one');
    for (const job of first.jobs) {
      assert(!('description' in job), `advertisement text on the wire for ${job.id}`);
      assert(job.sourceUrl.length > 0, `card ${job.id} lost its apply link`);
    }

    console.log('5/6 Proving aggregates ignore the loaded page and filters narrow server-side...');
    // Walk to page three, then compare the aggregates with page one (the #140 shape).
    const second = await expectStatus(
      await client.request(`/api/state?limit=40&cursor=${encodeURIComponent(first.nextCursor)}`),
      200, 'page two');
    assert(second.jobs.length === PAGE, `page two holds ${second.jobs.length} rows, expected ${PAGE}`);
    assert(second.nextCursor, 'page two must also continue');
    const third = await expectStatus(
      await client.request(`/api/state?limit=40&cursor=${encodeURIComponent(second.nextCursor)}`),
      200, 'page three');
    for (const key of ['total', 'matching', 'inView', 'folded']) {
      assert(first.catalogue[key] === third.catalogue[key],
        `catalogue.${key} moved between pages (${first.catalogue[key]} vs ${third.catalogue[key]})`);
    }
    assert(JSON.stringify(first.catalogue.facets) === JSON.stringify(third.catalogue.facets),
      'facets moved between pages');
    assert(JSON.stringify(first.catalogue.viewCounts) === JSON.stringify(third.catalogue.viewCounts),
      'view counts moved between pages');

    // Every filter narrows on page one; spot-check the rows, not just the counts.
    const swiss = await expectStatus(
      await client.request('/api/state?limit=40&country=switzerland&language=all'), 200, 'country filter');
    assert(swiss.jobs.length > 0 && swiss.jobs.length <= PAGE, 'country page has an impossible size');
    assert(swiss.jobs.every((job) => job.country === 'switzerland'), 'country filter leaked a row');
    assert(swiss.catalogue.matching < first.catalogue.matching, 'country filter did not narrow matching');
    const dutchSource = await expectStatus(
      await client.request('/api/state?limit=40&source=example.nl&language=all'), 200, 'source filter');
    assert(dutchSource.jobs.length > 0, 'source filter matched nothing');
    assert(dutchSource.jobs.every((job) => job.sourceKey === 'example.nl'), 'source filter leaked a row');
    const applied = await expectStatus(
      await client.request('/api/state?limit=40&application=applied&language=all'), 200, 'application filter');
    assert(applied.catalogue.matching === APPLIED,
      `application=applied matches ${applied.catalogue.matching}, expected ${APPLIED}`);
    assert(applied.jobs.every((job) => job.applicationStatus === 'applied'), 'application filter leaked a row');
    const pipeline = await expectStatus(
      await client.request('/api/state?limit=40&view=pipeline'), 200, 'pipeline view');
    assert(pipeline.catalogue.matching >= APPLIED, 'applied rows left the pipeline view');
    // Language narrows by the effective verdict (no corrections here, so the
    // stored verdict). The gate decides where 600-char English prose lands, so
    // assert row-level agreement rather than a distribution, plus that at least
    // one verdict bucket is populated.
    const passOnly = await expectStatus(
      await client.request('/api/state?limit=40&language=pass'), 200, 'language pass filter');
    const unknownOnly = await expectStatus(
      await client.request('/api/state?limit=40&language=unknown'), 200, 'language unknown filter');
    assert(passOnly.jobs.every((job) => job.languageStatus === 'pass'), 'language=pass leaked a row');
    assert(unknownOnly.jobs.every((job) => job.languageStatus === 'unknown'), 'language=unknown leaked a row');
    assert(passOnly.catalogue.matching + unknownOnly.catalogue.matching > 0,
      'no synthetic row landed in either language bucket');
    assert(passOnly.catalogue.matching <= first.catalogue.matching
      && unknownOnly.catalogue.matching <= first.catalogue.matching,
      'a language filter widened the set instead of narrowing it');
    const sorted = await expectStatus(
      await client.request('/api/state?limit=40&sort=posted&language=all'), 200, 'posted sort');
    assert(sorted.jobs.length === PAGE, 'sorted page has an impossible size');
    const refused = await client.request('/api/state?country=atlantis');
    assert(refused.response.status === 400, `unknown country answered ${refused.response.status}, expected 400`);
    const refusedLimit = await client.request('/api/state?limit=2001');
    assert(refusedLimit.response.status === 400, `limit=2001 answered ${refusedLimit.response.status}, expected 400`);

    // Facet values name real options and add up on an un-narrowed dimension.
    const countryFacet = first.catalogue.facets.country;
    const countrySum = countryFacet.values.reduce((sum, entry) => sum + entry.count, 0);
    assert(countrySum === countryFacet.all && countryFacet.all === first.catalogue.matching,
      'country facet values do not add up to matching');
    const sourceKeys = new Set(first.catalogue.facets.source.values.map((entry) => entry.key));
    assert(sourceKeys.has('example.ch') && sourceKeys.has('example.nl'),
      `source facet misses a synthetic host: ${[...sourceKeys].join(', ')}`);

    console.log('6/6 Walking every page: each filtered holding exactly once...');
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    for (;;) {
      const path = cursor
        ? `/api/state?limit=40&language=all&cursor=${encodeURIComponent(cursor)}`
        : '/api/state?limit=40&language=all';
      const page = await expectStatus(await client.request(path), 200, `walk page ${pages + 1}`);
      pages += 1;
      for (const job of page.jobs) {
        assert(!seen.has(job.id), `row ${job.id} repeated across pages`);
        seen.add(job.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      assert(pages < 100, 'paging did not terminate');
    }
    assert(seen.size === first.catalogue.matching,
      `walk visited ${seen.size} rows, catalogue.matching is ${first.catalogue.matching}`);
    console.log(`      walked ${pages} pages x 40 over ${seen.size} rows`);

    console.log(JSON.stringify({
      ok: true,
      imported: VOLUME,
      matching: first.catalogue.matching,
      pages,
      checks: [
        'default 40-row page with whole-collection aggregates',
        'page-independent aggregates and facets (the #140 regression)',
        'server-side country/source/application/language/view/sort filters',
        'unknown filter values refused',
        'full cursor walk without repeats or gaps',
        'no advertisement text on the wire',
      ],
    }, null, 2));
  } finally {
    // Cleanup failures are fatal, never swallowed: a verifier pointing at a
    // database it should not have touched must not report success. An account
    // that took the installer-administrator slot is deliberately left in
    // place (it cannot self-delete); the abort above already fails the run
    // with the explanation, so no delete is attempted for it here.
    if (importedIds.length) {
      const reset = await client.request('/api/workspace', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET' }),
      });
      if (reset.response.status !== 200) {
        throw new Error(
          `cleanup workspace reset failed: expected 200, received ${reset.response.status}: ${JSON.stringify(reset.data)}`,
        );
      }
    }
    if (client.cookie && !accountDeleted && accountRole !== 'admin') {
      const deleted = await client.request('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, confirm: 'DELETE' }),
      });
      if (deleted.response.status !== 200) {
        throw new Error(
          `cleanup account deletion failed: expected 200, received ${deleted.response.status}: ${JSON.stringify(deleted.data)}`,
        );
      }
      accountDeleted = true;
    }
  }
}

await main();
