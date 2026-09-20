import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { collectIndeed, indeedStatus } from '../lib/indeed/collection';
import { normalizeIndeed, languageForIndeed } from '../lib/indeed/normalize';
import { indeedSql, isLoopbackRequest } from '../lib/indeed/access';
import { adminOnlySourceKeys } from '../lib/job-adapters';
import { canonicalJobUrl, sourceJobIdFromUrl } from '../lib/job-identity';
import { normalizeStoredJobs, rescoreAllJobs, ensureCurrentJobClusters, upsertJob } from '../lib/server-data';
import { stripHtml } from '../lib/jobsch';
import type { IndeedRecord } from '../lib/indeed/contracts';

const config = { access: { enabled: true, localExecution: true, administrator: true, appIdentityExperimentApproved: true },
  credentials: { apiKey: 'a'.repeat(64), userAgent: 'Synthetic fixture', appInfo: 'synthetic=1' } };
const description = '<p>We are looking for a data analyst to work with our international team. You will analyze data and write reports. All meetings and documentation are in English.</p>'.repeat(9);
const record: IndeedRecord = { key: 'synthetic', title: 'Data &amp; Reporting Analyst', employer: 'Example', city: 'Amsterdam', country: 'NL',
  postedAtMs: null, descriptionHtml: `${description}<ul><li>SQL experience</li><li>Dutch is required</li></ul>`,
  descriptionEvidence: 'api-description-field', completeness: 'unknown' };

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
    compatibilityDate: '2026-05-15', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const base = runtimeMigrations.find(m => m.version === 7)!.statements[0].replace('CREATE TABLE jobs_rebuilt', 'CREATE TABLE jobs');
  await db.prepare(base).run();
  for (const version of [13, 14, 17, 19]) {
    await db.batch(runtimeMigrations.find(m => m.version === version)!.statements.map(sql => db.prepare(sql)));
  }
  await db.prepare(`CREATE TABLE language_feedback (job_id TEXT PRIMARY KEY, user_id TEXT, verdict TEXT,
    corrected_status TEXT, reason TEXT, updated_at TEXT)`).run();
  await db.prepare(`CREATE TABLE dismissed_jobs (id TEXT, user_id TEXT, source_key TEXT, source_job_id TEXT,
    canonical_url TEXT, identity_fingerprint TEXT)`).run();
  return { db, dispose: () => mf.dispose() };
}

test('Indeed normalization preserves blocks, requirements, country, dates and identity without claiming completeness', () => {
  const normalized = normalizeIndeed(record, 'NL')!;
  assert.equal(normalized.title, 'Data & Reporting Analyst');
  assert.equal(normalized.postedAt, '');
  assert.match(stripHtml(normalized.descriptionHtml), /\n• SQL experience\n• Dutch is required/);
  assert.equal(languageForIndeed(stripHtml(normalized.descriptionHtml), normalized.title).status, 'blocked');
  assert.equal(languageForIndeed(stripHtml(description), 'Data Analyst').status, 'unknown');
  assert.equal(languageForIndeed(stripHtml(description + '<p>Dutch is a plus.</p>'), 'Analyst').status, 'unknown');
  assert.equal(normalizeIndeed({ ...record, country: 'unknown' }, 'NL'), null);
  assert.equal(normalizeIndeed(record, 'CH'), null);
  assert.equal(normalizeIndeed({ ...record, key: '//evil.test' }, 'NL'), null);
  assert.equal(normalizeIndeed({ ...record, title: '&#999999999999;' }, 'NL'), null);
  const ch = normalizeIndeed({ ...record, country: 'CH', city: 'Zürich', postedAtMs: 1780000000000 }, 'CH')!;
  assert.equal(ch.postedAt, '2026-05-28T20:26:40.000Z');
  assert.match(ch.sourceUrl, /^https:\/\/ch\.indeed\.com\/viewjob\?jk=synthetic$/);
  assert.equal(sourceJobIdFromUrl(normalized.sourceUrl), 'synthetic');
  assert.equal(canonicalJobUrl(normalized.sourceUrl + '&utm_source=fixture'), normalized.sourceUrl);
  assert.ok(adminOnlySourceKeys().has('indeed.com'));
  assert.equal(isLoopbackRequest(new Request('https://public.example/')), false);
});

test('Indeed collection shares four requests across countries, and persists cooldown across clients', async () => {
  const { db, dispose } = await fixture();
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const country = new Headers(init!.headers).get('indeed-co');
    calls++;
    return Response.json({ data: { jobSearch: { results: [{ job: { key: `job-${calls}`, title: 'Data Analyst',
      location: { countryCode: country, city: country === 'NL' ? 'Amsterdam' : 'Zürich' },
      employer: { name: 'Example' }, description: { html: description }, datePublished: 1780000000000 } }],
      pageInfo: { nextCursor: 'more' } } } });
  };
  try {
    const result = await collectIndeed(db, config, ['data analyst', 'master data', 'supply chain'], undefined, fetcher);
    assert.equal(calls, 4);
    assert.equal(result.NL.jobs.length, 2);
    assert.equal(result.CH.jobs.length, 2);
    assert.equal(result.NL.status, 'partial');
    assert.deepEqual(result.NL.roles, ['data analyst', 'master data']);
    assert.equal((await indeedStatus(db, config)).state, 'cooldown');
    assert.equal((await collectIndeed(db, config, ['analyst'], undefined, fetcher)).NL.requests, 0);
    assert.equal(calls, 4);
    assert.equal(JSON.stringify(result).includes(config.credentials.apiKey), false);
  } finally { await dispose(); }
});

test('Indeed refusal, malformed challenge and 429 stop both countries durably; default/remote/user gates do not fetch', async () => {
  for (const status of [403, 429, 200]) {
    const { db, dispose } = await fixture();
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return new Response('<html>not data</html>', { status,
      headers: { 'retry-after': '900', 'content-type': 'text/html' } }); };
    try {
      for (const access of [{ ...config.access, enabled: false }, { ...config.access, administrator: false },
        { ...config.access, localExecution: false }, { ...config.access, appIdentityExperimentApproved: false }]) {
        await collectIndeed(db, { ...config, access }, ['analyst'], undefined, fetcher);
      }
      assert.equal(calls, 0);
      await collectIndeed(db, config, ['analyst'], undefined, fetcher);
      assert.equal(calls, 1);
      const state = await indeedStatus(db, config);
      assert.equal(state.state, status === 429 ? 'cooldown' : 'refused');
      if (status === 429) assert.ok(state.retryAfterSeconds > 800);
      await collectIndeed(db, config, ['analyst'], undefined, fetcher);
      assert.equal(calls, 1);
    } finally { await dispose(); }
  }
});

test('Indeed never merges/enriches public copies and rescoring never promotes unknown descriptions; dismissal and accounts survive', async () => {
  const { db, dispose } = await fixture();
  const input = { sourceUrl: 'https://example.test/job/one', title: 'Data Analyst', company: 'Example',
    location: 'Amsterdam, Netherlands', description: stripHtml(description), postedAt: '2026-09-01',
    languageStatus: 'unknown' as const, languageSummary: 'Fixture', languageSignals: [],
    fitScoreA: 0, fitScoreB: 0, bestCvSlot: '' as const, matchedKeywords: [], missingKeywords: [] };
  try {
    const publicJob = await upsertJob(db, 'alice', input);
    const privateInput = { ...input, sourceUrl: 'https://nl.indeed.com/viewjob?jk=synthetic' };
    const privateJob = await upsertJob(db, 'alice', privateInput);
    assert.notEqual(privateJob.job.id, publicJob.job.id);
    assert.equal(privateJob.wasDuplicate, false);
    await db.prepare("UPDATE jobs SET is_saved = 1, application_status = 'applied', visibility_status = 'dismissed' WHERE id = ?")
      .bind(privateJob.job.id).run();
    await db.prepare('INSERT INTO dismissed_jobs VALUES (?, ?, ?, ?, ?, ?)').bind(privateJob.job.id, 'alice', 'indeed-nl',
      'synthetic', privateInput.sourceUrl, privateJob.job.identityFingerprint).run();
    const bobJob = await upsertJob(db, 'bob', privateInput);
    assert.notEqual(bobJob.job.id, privateJob.job.id);
    await normalizeStoredJobs(db, 'alice');
    await rescoreAllJobs(db, 'alice', []);
    await ensureCurrentJobClusters(db, 'alice');
    const repeated = await upsertJob(db, 'alice', privateInput);
    assert.equal(repeated.wasDismissed, true);
    assert.equal(repeated.job.isSaved, true);
    assert.equal(repeated.job.applicationStatus, 'applied');
    assert.equal(repeated.job.duplicateOf, '');
    assert.equal(repeated.job.languageStatus, 'unknown');
    const visible = await db.prepare(`SELECT id FROM jobs WHERE user_id = ? AND NOT ${indeedSql()}`).bind('alice').all<{ id: string }>();
    assert.deepEqual(visible.results.map(row => row.id), [publicJob.job.id]);
    await db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').bind(privateJob.job.id, 'alice').run();
    assert.equal((await upsertJob(db, 'alice', privateInput)).wasDismissed, true);
    assert.equal((await db.prepare('SELECT visibility_status FROM jobs WHERE id = ?').bind(bobJob.job.id).first<{ visibility_status: string }>())?.visibility_status, 'active');
  } finally { await dispose(); }
});
