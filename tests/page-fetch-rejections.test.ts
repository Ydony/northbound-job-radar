import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { isRejectedUrl, loadRejectedListings, rejectionRolesKey, rememberRejection } from '../lib/rejected-listings';

// #93: four permanently-unimportable listings at the head of a page-fetching source starved
// everything behind them, because a rejected URL was written nowhere. Real D1 SQL
// throughout, so a malformed migration, a missing owner predicate, or an UPSERT the
// database rejects fails here instead of passing against a mock.

const UUID = '12345678-1234-1234-1234-123456789012';
const OTHER_UUID = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';

function jobsCh(uuid: string) {
  return `https://www.jobs.ch/en/vacancies/detail/${uuid}/`;
}

async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  const migration = runtimeMigrations.find((entry) => entry.version === 24)!;
  await db.batch(migration.statements.map((sql) => db.prepare(sql)));
  return { db, dispose: () => runtime.dispose() };
}

test('migration 24 creates the rejected-listings table and applies twice cleanly', async () => {
  const { db, dispose } = await fixture();
  try {
    // IF NOT EXISTS / IF NOT EXISTS indexes: re-running must not fail on existing databases.
    const migration = runtimeMigrations.find((entry) => entry.version === 24)!;
    await db.batch(migration.statements.map((sql) => db.prepare(sql)));
    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rejected_listings'",
    ).all<{ name: string }>();
    assert.equal(tables.results.length, 1);
    const indexes = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rejected_listings'",
    ).all<{ name: string }>();
    const names = indexes.results.map((row) => row.name).sort();
    assert.ok(names.includes('rejected_user_canonical_idx'), `missing unique owner index: ${names}`);
    assert.ok(names.includes('rejected_user_source_identity_idx'), `missing identity index: ${names}`);
  } finally { await dispose(); }
});

test('a remembered rejection matches the same listing under a rewritten URL', async () => {
  const { db, dispose } = await fixture();
  try {
    const roles = rejectionRolesKey(['Data Analyst']);
    await rememberRejection(db, 'alice', jobsCh(UUID), 'wrong-country', roles);
    const rejected = await loadRejectedListings(db, 'alice');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, 'wrong-country');
    // Tracking parameters and the trailing slash are canonicalized away.
    assert.ok(isRejectedUrl(`${jobsCh(UUID)}?utm_source=x#top`, rejected, roles));
    assert.ok(!isRejectedUrl(jobsCh(OTHER_UUID), rejected, roles));
  } finally { await dispose(); }
});

test('a globally stable JobCloud id counts across boards, a slug does not', async () => {
  const { db, dispose } = await fixture();
  try {
    const roles = rejectionRolesKey(['Data Analyst']);
    await rememberRejection(db, 'alice', jobsCh(UUID), 'too-short', roles);
    const rejected = await loadRejectedListings(db, 'alice');
    // The same underlying posting on a sister board needs no second fetch.
    assert.ok(isRejectedUrl(`https://www.jobup.ch/en/jobs/detail/${UUID}/`, rejected, roles));
    // An IamExpat slug is only stable on its own host.
    await rememberRejection(db, 'alice',
      'https://www.iamexpat.nl/career/jobs-netherlands/data-analyst-amsterdam-99',
      'too-short', roles);
    const both = await loadRejectedListings(db, 'alice');
    assert.ok(isRejectedUrl(
      'https://www.iamexpat.nl/career/jobs-netherlands/data-analyst-amsterdam-99', both, roles));
    assert.ok(!isRejectedUrl(
      'https://undutchables.nl/vacancies/data-analyst-amsterdam-99', both, roles));
  } finally { await dispose(); }
});

test('rejections are scoped per owner', async () => {
  const { db, dispose } = await fixture();
  try {
    const roles = rejectionRolesKey(['Data Analyst']);
    await rememberRejection(db, 'alice', jobsCh(UUID), 'wrong-country', roles);
    assert.equal((await loadRejectedListings(db, 'bob')).length, 0);
    const alice = await loadRejectedListings(db, 'alice');
    assert.ok(!isRejectedUrl(jobsCh(UUID), await loadRejectedListings(db, 'bob'), roles));
    assert.ok(isRejectedUrl(jobsCh(UUID), alice, roles));
  } finally { await dispose(); }
});

test('a role mismatch holds only while the searched roles do', async () => {
  const { db, dispose } = await fixture();
  try {
    const analyst = rejectionRolesKey(['Data Analyst']);
    const engineer = rejectionRolesKey(['Data Engineer']);
    await rememberRejection(db, 'alice', jobsCh(UUID), 'role-mismatch', analyst);
    const rejected = await loadRejectedListings(db, 'alice');
    assert.ok(isRejectedUrl(jobsCh(UUID), rejected, analyst));
    // A new search direction reconsiders the listing instead of hiding it forever.
    assert.ok(!isRejectedUrl(jobsCh(UUID), rejected, engineer));
    // Every other reason is listing-intrinsic and holds regardless of roles.
    await rememberRejection(db, 'alice', jobsCh(OTHER_UUID), 'wrong-country', analyst);
    const both = await loadRejectedListings(db, 'alice');
    assert.ok(isRejectedUrl(jobsCh(OTHER_UUID), both, engineer));
  } finally { await dispose(); }
});

test('re-rejecting under new roles carries the latest roles', async () => {
  const { db, dispose } = await fixture();
  try {
    const analyst = rejectionRolesKey(['Data Analyst']);
    const engineer = rejectionRolesKey(['Data Engineer']);
    await rememberRejection(db, 'alice', jobsCh(UUID), 'role-mismatch', analyst);
    // The roles changed, the listing was reconsidered, and it mismatches again: the row must
    // move to the new roles, not stay pinned to the old ones via INSERT OR IGNORE.
    await rememberRejection(db, 'alice', jobsCh(UUID), 'role-mismatch', engineer);
    const rejected = await loadRejectedListings(db, 'alice');
    assert.equal(rejected.length, 1);
    assert.ok(isRejectedUrl(jobsCh(UUID), rejected, engineer));
    assert.ok(!isRejectedUrl(jobsCh(UUID), rejected, analyst));
  } finally { await dispose(); }
});

test('the roles key does not depend on role order', () => {
  assert.equal(rejectionRolesKey(['b', 'a']), rejectionRolesKey(['a', 'b']));
});

test('four remembered head-of-queue rejections no longer starve what follows', async () => {
  // The defect, reduced to the route's own filtering: the same first four sliced off the top
  // of every run. With the rejections remembered, the slice starts past them.
  const { db, dispose } = await fixture();
  try {
    const roles = rejectionRolesKey(['Data Analyst']);
    const head = [UUID, OTHER_UUID, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
    for (const uuid of head) {
      await rememberRejection(db, 'alice', jobsCh(uuid), 'wrong-country', roles);
    }
    const rejected = await loadRejectedListings(db, 'alice');
    const candidates = [
      ...head.map(jobsCh),
      jobsCh('cccccccc-cccc-cccc-cccc-cccccccccccc'),
      jobsCh('dddddddd-dddd-dddd-dddd-dddddddddddd'),
      jobsCh('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
      jobsCh('ffffffff-ffff-ffff-ffff-ffffffffffff'),
      jobsCh('99999999-9999-9999-9999-999999999999'),
    ];
    const fresh = candidates.filter((url) => !isRejectedUrl(url, rejected, roles));
    assert.equal(fresh.length, 5);
    // The per-run cap of four now spends itself on unseen listings, not the dead head.
    assert.deepEqual(fresh.slice(0, 4), candidates.slice(4, 8));
  } finally { await dispose(); }
});

test('a transient fetch failure is never remembered, only a judged listing is', async () => {
  // The route cannot be imported here (it needs the worker runtime), so this pins the
  // contract the route implements: the catch around fetchDetail records nothing, and every
  // rememberRejection call in the route sits behind a page-fetching guard, never in bulk.
  const source = await readFile(new URL('../app/api/scrape/route.ts', import.meta.url), 'utf8');
  const fetchCall = source.indexOf('parsed = await adapter.fetchDetail!(url);');
  assert.ok(fetchCall > 0, 'the detail fetch moved');
  const catchBlock = source.slice(source.indexOf('} catch {', fetchCall), source.indexOf('}', source.indexOf('} catch {', fetchCall)) + 1);
  assert.doesNotMatch(catchBlock, /rememberRejection|rejected\.push/,
    'a request that never completed must stay retryable, not remembered');
  const remembers = [...source.matchAll(/rememberRejection\(db, user\.id, url, (?:'([a-z-]+)'|(reason))/g)]
    .map((match) => match[1] ?? match[2]).sort();
  assert.deepEqual(remembers,
    ['reason', 'unparseable', 'unsafe-url'].sort(),
    'only judged listings are remembered: unparseable pages, unsafe links, and one classified reason');
  // The classified reason covers exactly the three filter verdicts, in filter order.
  assert.match(source, /const reason: RejectionReason = description\.length < 160 \? 'too-short'\s*\n?\s*: parsedCountry !== adapter\.country \? 'wrong-country' : 'role-mismatch';/,
    'the filter branch must classify too-short, wrong-country and role-mismatch');
  for (const match of source.matchAll(/rejected\.push\(await rememberRejection[^;]+;/g)) {
    const at = match.index ?? 0;
    assert.ok(source.lastIndexOf('if (!isBulk)', at) > source.lastIndexOf('for (const [index, url]', at),
      'bulk sources filter before the cap and must never write rejections');
  }
});
