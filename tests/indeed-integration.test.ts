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
  for (const version of [13, 14, 17, 19, 21, 23]) {
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
  // An Indeed advertisement reaches the same verdicts as any other source. This used to be
  // forced to `unknown` whatever it said, so the gate could reject a job on this text but never
  // accept one, and no Indeed job could reach the matches list.
  assert.equal(languageForIndeed(stripHtml(description), 'Data Analyst').status, 'pass');
  assert.equal(languageForIndeed(stripHtml(description + '<p>Dutch is a plus.</p>'), 'Analyst').status, 'review');
  // Completeness is still withheld where it is genuinely in doubt: the shared gate's two cases,
  // plus the teaser that ends in a link rather than an ellipsis.
  assert.equal(languageForIndeed(stripHtml(description + '<p>Read more</p>'), 'Analyst').status, 'unknown');
  assert.equal(languageForIndeed(stripHtml(description) + '...', 'Analyst').status, 'unknown');
  assert.equal(languageForIndeed('Short advertisement text.', 'Analyst').status, 'unknown');
  // "read more" is ordinary copy in the body of an advertisement; only the tail is a truncation.
  assert.equal(languageForIndeed(stripHtml('<p>Read more about our benefits.</p>' + description), 'Analyst').status, 'pass');
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

test('Indeed sends no requests for a country switched off in search criteria', async () => {
  const { db, dispose } = await fixture();
  const requested: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    requested.push(new Headers(init!.headers).get('indeed-co')!);
    return Response.json({ data: { jobSearch: { results: [], pageInfo: { nextCursor: null } } } });
  };
  try {
    const none = await collectIndeed(db, config, ['analyst'], undefined, fetcher, []);
    assert.equal(none.NL.status, 'disabled');
    assert.equal(requested.length, 0);
    const result = await collectIndeed(db, config, ['analyst'], undefined, fetcher, ['NL']);
    assert.deepEqual(requested, ['NL']);
    assert.equal(result.NL.status, 'complete');
    assert.equal(result.CH.status, 'disabled');
    assert.equal(result.CH.requests, 0);
    assert.deepEqual(result.CH.roles, []);
  } finally { await dispose(); }
});

test('Indeed concurrent callers share a durable lease and cancellation releases it', async () => {
  const { db, dispose } = await fixture();
  const controller = new AbortController();
  let calls = 0;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    started();
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  try {
    const first = collectIndeed(db, config, ['analyst'], controller.signal, fetcher);
    await waiting;
    assert.equal((await indeedStatus(db, config)).state, 'busy');
    const second = await collectIndeed(db, config, ['analyst'], undefined, fetcher);
    assert.equal(second.NL.requests, 0);
    controller.abort();
    const result = await first;
    assert.equal(calls, 1);
    assert.equal(result.NL.status, 'failed');
    assert.match(result.NL.message, /cancelled/);
    assert.equal(result.CH.requests, 0);
    assert.equal((await indeedStatus(db, config)).state, 'cooldown');
    const row = await db.prepare("SELECT lease_token, lease_until FROM indeed_control WHERE id = 'indeed'")
      .first<{ lease_token: string; lease_until: number }>();
    assert.equal(row?.lease_token, '');
    assert.equal(row?.lease_until, 0);
  } finally { controller.abort(); await dispose(); }
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
