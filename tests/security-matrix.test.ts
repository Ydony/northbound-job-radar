import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { defaultSearchCriteria } from '../lib/criteria';
import { createIndeedClient } from '../lib/indeed/client';
import type { IndeedAccess, IndeedSearchInput } from '../lib/indeed/contracts';
import { adminOnlySourceKeys, isHiddenSourceForRole } from '../lib/job-adapters';
import { isSafeManualJobUrl } from '../lib/job-sources';
import { queryCollectionTotals, queryJobsPage, upsertJob } from '../lib/server-data';

/**
 * T36 (F12): one matrix exercising the account/role split together with the
 * injection cases — XSS, SQL and SSRF including redirects and private-address
 * rejection — against real D1 SQL with synthetic fixtures only.
 *
 * What lives where, so this file does not re-pin what siblings already own:
 * - password hashing, session tampering/expiry/revocation, cookie flags and
 *   origin refusal: tests/auth.test.ts (helpers) + lib/guard.ts (wiring, pinned §A4).
 * - per-surface ordinary/admin shaping: tests/public-admin-isolation.test.ts.
 * - javascript:/data:/apply-link refusal: tests/source-access.test.ts.
 * - security headers/CSP: tests/security-headers.test.ts.
 * - page-fetch unsafe-url remembering: tests/page-fetch-rejections.test.ts.
 * - Indeed redirect refusal: tests/indeed-client.test.ts (re-exercised §D2
 *   against a metadata-address redirect target).
 */

// ---------------------------------------------------------------------------
// Fixture: post-tenancy jobs table, like tests/public-admin-isolation.test.ts.
// ---------------------------------------------------------------------------

async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  const base = runtimeMigrations.find((entry) => entry.version === 7)!.statements[0]
    .replace('CREATE TABLE jobs_rebuilt', 'CREATE TABLE jobs');
  await db.prepare(base).run();
  for (const version of [13, 14, 16, 17, 20, 21, 22, 23]) {
    const migration = runtimeMigrations.find((entry) => entry.version === version)!;
    await db.batch(migration.statements.map((sql) => db.prepare(sql)));
  }
  await db.prepare(`CREATE TABLE dismissed_jobs (id TEXT, user_id TEXT, source_key TEXT,
    source_job_id TEXT, canonical_url TEXT, identity_fingerprint TEXT)`).run();
  await db.prepare(`CREATE TABLE language_feedback (job_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT '',
    corrected_status TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '', detected_status TEXT NOT NULL DEFAULT '',
    detected_summary TEXT NOT NULL DEFAULT '', detected_signals TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '')`).run();
  return { db, dispose: () => runtime.dispose() };
}

const LONG_ENOUGH = 'A permanent analyst role in Zurich. English is the working language. '.repeat(8);

async function seedJob(db: D1Database, userId: string, sourceUrl: string, title: string, description = LONG_ENOUGH) {
  const result = await upsertJob(db, userId, {
    sourceUrl, title, company: 'Acme', location: 'Zurich', description,
    languageStatus: 'pass', languageSummary: 'Synthetic verdict', languageSignals: [],
  });
  return result.job;
}

async function pageIds(db: D1Database, userId: string, hidden: string[]) {
  const page = await queryJobsPage(db, userId, {
    hiddenSourceKeys: hidden, hideIndeedRecords: true,
    criteria: defaultSearchCriteria, cursor: null, limit: 50,
  });
  return page;
}

// ---------------------------------------------------------------------------
// A. Account/role matrix: anonymous, ordinary, second fresh account, admin.
// ---------------------------------------------------------------------------

test('A1: a second fresh account sees only its own rows, never another account', async () => {
  const { db, dispose } = await fixture();
  try {
    await seedJob(db, 'alice', 'https://europa.eu/eures/job/alice-1', 'Data Analyst alice one');
    await seedJob(db, 'bob', 'https://europa.eu/eures/job/bob-1', 'Data Analyst bob one');
    const hidden = [...adminOnlySourceKeys()];
    const bobPage = await pageIds(db, 'bob', hidden);
    assert.deepEqual(bobPage.rows.map((row) => row.title), ['Data Analyst bob one']);
    assert.equal(bobPage.total, 1);
    const alicePage = await pageIds(db, 'alice', hidden);
    assert.deepEqual(alicePage.rows.map((row) => row.title), ['Data Analyst alice one']);
    const bobTotals = await queryCollectionTotals(db, 'bob', hidden, true);
    assert.equal(bobTotals.total, 1);
  } finally { await dispose(); }
});

test('A2: ordinary accounts lose admin rows and their counts; administrators keep them', async () => {
  const { db, dispose } = await fixture();
  try {
    const adminUrl = 'https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/';
    await seedJob(db, 'alice', 'https://europa.eu/eures/job/alice-pub', 'Data Analyst public');
    await seedJob(db, 'alice', adminUrl, 'Data Analyst historic admin');
    const hidden = [...adminOnlySourceKeys()];
    const ordinary = await pageIds(db, 'alice', hidden);
    assert.deepEqual(ordinary.rows.map((row) => row.title), ['Data Analyst public']);
    assert.equal(ordinary.total, 1, 'the stored admin row must not count toward the ordinary total');
    const admin = await pageIds(db, 'alice', []);
    assert.equal(admin.total, 2, 'the administrator view must keep every row');
    const ordinaryTotals = await queryCollectionTotals(db, 'alice', hidden, true);
    assert.equal(ordinaryTotals.total, 1);
    // upsertJob derives the stored key from the URL (sourceInfoForUrl): the point
    // here is that the only counted source is the public one, never the admin URL.
    assert.deepEqual(ordinaryTotals.bySource.map((entry) => entry.sourceKey), ['eures']);
  } finally { await dispose(); }
});

test('A3: ordinary accounts cannot import admin-source URLs; administrators can', async () => {
  const adminUrl = 'https://www.jobs.ch/en/vacancies/detail/11111111-1111-1111-1111-111111111111/';
  assert.equal(isHiddenSourceForRole('jobs.ch', adminUrl, false), true);
  assert.equal(isHiddenSourceForRole('jobs.ch', adminUrl, true), false);
  assert.equal(isHiddenSourceForRole('eures-ch', 'https://europa.eu/eures/job/x', false), false);
  // The manual-import route enforces the same gate and names no source in refusal.
  const route = await readFile(new URL('../app/api/jobs/route.ts', import.meta.url), 'utf8');
  assert.match(route, /isHiddenSourceForRole\(sourceInfoForUrl\(sourceUrl\)\.key, sourceUrl, user\.role === 'admin'\)/);
  assert.match(route, /error: 'This source is not available\.'/);
  assert.match(route, /status: 403/);
});

test('A4: anonymous requests are refused before any data, admin routes need the role', async () => {
  const root = new URL('..', import.meta.url);
  const read = (path: string) => readFile(new URL(path, root), 'utf8');
  const [jobs, scrape, state, feedback, guard] = await Promise.all([
    read('app/api/jobs/route.ts'), read('app/api/scrape/route.ts'), read('app/api/state/route.ts'),
    read('app/api/feedback/route.ts'), read('lib/guard.ts'),
  ]);
  for (const [label, source] of [['jobs', jobs], ['scrape', scrape], ['state', state], ['feedback', feedback]]) {
    assert.match(source as string, /requireSession\(/, `${label} must gate on the session guard`);
  }
  // Closed by default: no session means 401, never data; a missing secret refuses to serve.
  assert.match(guard, /error: 'Sign in to continue\.'[\s\S]*status: 401/);
  assert.match(guard, /status: 503/);
  // Cross-origin state changes and admin-only routes are refused server-side.
  assert.match(guard, /isSameOrigin\(request\)/);
  assert.match(guard, /Cross-origin request refused/);
  assert.match(guard, /options\.adminOnly && user\.role !== 'admin'/);
  assert.match(guard, /Administrator access required/);
  const adminRoute = await read('app/api/admin/route.ts');
  assert.match(adminRoute, /adminOnly: true/);
});

// ---------------------------------------------------------------------------
// B. XSS: untrusted advertisement text stays inert data end to end.
// ---------------------------------------------------------------------------

test('B1: stored script and event-handler payloads round-trip as inert text', async () => {
  const { db, dispose } = await fixture();
  try {
    const title = '<script>alert(document.cookie)</script>';
    const description = `<p>English role.</p><img src=x onerror=alert(1)> ${'plain text. '.repeat(40)}`;
    const stored = await seedJob(db, 'alice', 'https://careers.example.com/job/xss-1', title, description);
    assert.equal(stored.title, title, 'the server must store text, never interpret it');
    const reread = await db.prepare('SELECT description FROM jobs WHERE id = ? AND user_id = ?')
      .bind(stored.id, 'alice').first<{ description: string }>();
    assert.equal(reread?.description, description);
    const page = await pageIds(db, 'alice', []);
    assert.equal(page.rows[0].title, title);
    // JSON transport keeps the payload as string data: no execution context survives.
    const wire = JSON.stringify(page.rows[0]);
    assert.ok(wire.includes('<script>'));
    assert.doesNotMatch(wire, /<script>alert\(1\)<\/script>/);
  } finally { await dispose(); }
});

async function sourceFiles(root: URL, dir: string, suffixes: string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
      const next = `${relative}${entry.name}${entry.isDirectory() ? '/' : ''}`;
      if (entry.isDirectory()) await walk(next);
      else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) found.push(next);
    }
  };
  await walk(dir);
  return found;
}

test('B2: no script-execution sink exists in app or lib output paths', async () => {
  const root = new URL('../', import.meta.url);
  const files = [
    ...(await sourceFiles(root, 'app/', ['.ts', '.tsx'])),
    ...(await sourceFiles(root, 'lib/', ['.ts'])),
  ];
  assert.ok(files.length > 10, 'the walk must actually cover the render and data paths');
  const sink = /dangerouslySetInnerHTML|\.innerHTML\s*=|[^_a-zA-Z]eval\(|new Function\(/;
  const offenders: string[] = [];
  for (const file of files) {
    const content = await readFile(new URL(file, root), 'utf8');
    if (sink.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'untrusted content may only reach the DOM through JSX escaping');
});

// ---------------------------------------------------------------------------
// C. SQL injection: metacharacters are data through the write and read paths.
// ---------------------------------------------------------------------------

test('C1: SQL metacharacters in stored fields never escape their statement', async () => {
  const { db, dispose } = await fixture();
  try {
    await seedJob(db, 'alice', 'https://careers.example.com/job/legit', 'Data Analyst legit');
    await seedJob(db, 'alice', 'https://careers.example.com/job/sqli-1', `' OR '1'='1`);
    await seedJob(db, 'alice', 'https://careers.example.com/job/sqli-2', `'; DROP TABLE jobs; --`);
    await seedJob(db, 'alice', 'https://careers.example.com/job/sqli-3', `" UNION SELECT password FROM users --`);
    const page = await pageIds(db, 'alice', []);
    assert.equal(page.total, 4, 'the jobs table must be intact with all four rows');
    // A hostile keyword is a literal LIKE match, not code: as code `' OR '1'='1`
    // would match every row; as data it matches exactly the one row containing
    // that literal text — and errors nothing.
    const hostile = {
      ...defaultSearchCriteria,
      requiredKeywords: [`' OR '1'='1`],
    };
    const hostilePage = await queryJobsPage(db, 'alice', {
      hiddenSourceKeys: [], hideIndeedRecords: false, criteria: hostile, cursor: null, limit: 50,
    });
    assert.equal(hostilePage.matching, 1);
    assert.deepEqual(hostilePage.rows.map((row) => row.title), [`' OR '1'='1`]);
    const totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 4);
    // The hostile rows are still exactly what was written.
    const titles = page.rows.map((row) => row.title).sort();
    assert.ok(titles.includes(`' OR '1'='1`));
    assert.ok(titles.includes(`'; DROP TABLE jobs; --`));
  } finally { await dispose(); }
});

// ---------------------------------------------------------------------------
// D. SSRF: private/loopback/link-local/metadata destinations refused; no
// redirect is ever followed toward them.
// ---------------------------------------------------------------------------

test('D1: private, loopback, link-local, metadata and encoded-IP hosts are refused', () => {
  assert.equal(isSafeManualJobUrl('https://careers.example.com/job/1'), true);
  assert.equal(isSafeManualJobUrl('https://nl.indeed.com/viewjob?jk=example'), true);
  const refused = [
    // Scheme, credentials and script URLs.
    'http://careers.example.com/job/1',
    'https://user:secret@example.com/job/1',
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    // Local names.
    'https://localhost/job/1',
    'https://x.localhost/job/1',
    'https://intranet.local/job/1',
    'https://singlelabel/job/1',
    // IPv4: loopback, private ranges, link-local, wildcard, metadata service.
    'https://127.0.0.1/job/1',
    'https://10.0.0.5/job/1',
    'https://172.16.0.9/job/1',
    'https://192.168.1.20/job/1',
    'https://169.254.169.254/latest/meta-data/iam/',
    'https://0.0.0.0/job/1',
    // Encoded-IP forms: the URL parser normalizes these to the dotted quad,
    // which the IPv4 rule refuses; pinned here so a parser change is caught.
    'https://0x7f.0.0.1/job/1',
    'https://0177.0.0.1/job/1',
    'https://2130706433/job/1',
    'https://0x7f000001/job/1',
    'https://1.2.3.4.5/job/1',
    // IPv6 loopback and mapped forms.
    'https://[::1]/job/1',
    'https://[0:0:0:0:0:ffff:127.0.0.1]/job/1',
    // Cloud metadata names (resolvable only inside the hosting cloud).
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://metadata.google/job/1',
  ];
  for (const url of refused) assert.equal(isSafeManualJobUrl(url), false, `${url} must be refused`);
});

test('D2: a redirect — including one toward a metadata address — is refused, never followed', async () => {
  const access: IndeedAccess = {
    enabled: true, localExecution: true, administrator: true, appIdentityExperimentApproved: true,
  };
  const credentials = { apiKey: 'a'.repeat(64), userAgent: 'Synthetic local test', appInfo: 'synthetic=fixture' };
  const input: IndeedSearchInput = { country: 'NL', keywords: 'data analyst', location: 'Amsterdam', pageSize: 1, maxJobs: 2 };
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  };
  const result = await createIndeedClient({ access, credentials }, fetcher).search(input);
  assert.equal(result.reason, 'redirect_refused');
  assert.equal(result.outcome, 'failed');
  assert.equal(calls.length, 1, 'no second request may chase the redirect target');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
});

test('D3: the manual import path never fetches, and the search path quarantines unsafe links', async () => {
  const root = new URL('..', import.meta.url);
  const jobsRoute = await readFile(new URL('app/api/jobs/route.ts', root), 'utf8');
  assert.doesNotMatch(jobsRoute, /fetch\(/, 'manual imports validate but never fetch server-side');
  assert.match(jobsRoute, /isSafeManualJobUrl\(sourceUrl\)/);
  const scrapeRoute = await readFile(new URL('app/api/scrape/route.ts', root), 'utf8');
  assert.match(scrapeRoute, /isSafeManualJobUrl\(parsed\.sourceUrl\)/);
  assert.match(scrapeRoute, /'unsafe-url'/);
});
