import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { adminOnlySourceKeys, jobSourceAdapters } from '../lib/job-adapters';
import { INDEED_SOURCE_KEYS } from '../lib/indeed/access';
import { NORMALIZATION_VERSION, normalizeStoredJobs } from '../lib/server-data';

/**
 * Checks for the judgement calls made on 2026-09-20 while the owner was away (#81).
 *
 * These are not a second opinion - a test cannot tell anyone whether a decision was wise. They
 * are the narrower thing that is actually worth having: each one fails if a specific claim made
 * in a commit message or an issue comment was untrue. Where a claim could not be reduced to a
 * check, it is named here as still resting on judgement rather than quietly dropped.
 *
 * Still resting on judgement, and deliberately not dressed up as verified:
 *   - closing PR #77 unmerged rather than waiting for the owner (the content is checked below,
 *     but whether it was the lead's call to make is not a testable question);
 *   - merging the Indeed draft after codex-lead ran out of credits;
 *   - reporting #87 as a defect and then dismissing it, which the check below only partly covers.
 */

const pad = ('We are a product company building payment infrastructure for merchants across Europe. '
  + 'You will design, build and ship services with a small team, own them in production, and work '
  + 'closely with product and design. We offer a competitive salary, a learning budget and a hybrid '
  + 'schedule. The team is distributed across three offices and meets twice a year. ').repeat(7);

async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-05-15',
    d1Databases: ['DB'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  await db.prepare(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'unknown',
    description TEXT NOT NULL,
    language_status TEXT NOT NULL DEFAULT 'unknown',
    language_summary TEXT NOT NULL DEFAULT '',
    language_signals TEXT NOT NULL DEFAULT '[]',
    search_text TEXT NOT NULL DEFAULT '',
    normalized_version INTEGER NOT NULL DEFAULT 0,
    cluster_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '2026-09-01'
  )`).run();
  return { db, dispose: () => runtime.dispose() };
}

/**
 * The claim: bumping NORMALIZATION_VERSION re-screens stored rows rather than leaving them on a
 * verdict the old rules produced. It was made three times in one day (7, 8, 9) and never checked.
 *
 * "No travel. German is required." is the exhibit, because it is the exact advertisement that
 * passed as English under the version-7 rules and blocks under the version-9 rules. A row stored
 * with the old verdict must come out blocked. If a bump does not re-screen, this fails.
 */
test('a version bump re-screens a stored row, it does not just relabel it', async () => {
  const { db, dispose } = await fixture();
  try {
    await db.prepare(`INSERT INTO jobs (id, user_id, source_url, title, description, language_status, normalized_version)
      VALUES ('stale', 'alice', 'https://boards.greenhouse.io/example/jobs/1', 'Platform Engineer', ?, 'pass', ?)`)
      .bind(`${pad} No travel. German is required.`, NORMALIZATION_VERSION - 1).run();

    const rewritten = await normalizeStoredJobs(db, 'alice');
    assert.equal(rewritten, 1, 'a row below the current version must be picked up');

    const row = await db.prepare('SELECT language_status, normalized_version FROM jobs WHERE id = ?')
      .bind('stale').first<{ language_status: string; normalized_version: number }>();
    assert.equal(row!.language_status, 'blocked',
      'the stored pass must be replaced by the verdict the current rules produce');
    assert.equal(row!.normalized_version, NORMALIZATION_VERSION);
  } finally {
    await dispose();
  }
});

test('a row already at the current version is left alone', async () => {
  // The other half of the claim: it is the bump that does the work, not an unconditional rewrite
  // of every row on every read.
  const { db, dispose } = await fixture();
  try {
    await db.prepare(`INSERT INTO jobs (id, user_id, source_url, title, description, language_status, normalized_version)
      VALUES ('current', 'alice', 'https://boards.greenhouse.io/example/jobs/2', 'Platform Engineer', ?, 'pass', ?)`)
      .bind(`${pad} No travel. German is required.`, NORMALIZATION_VERSION).run();

    assert.equal(await normalizeStoredJobs(db, 'alice'), 0);
    const row = await db.prepare('SELECT language_status FROM jobs WHERE id = ?').bind('current')
      .first<{ language_status: string }>();
    assert.equal(row!.language_status, 'pass', 'an up-to-date row must not be rewritten');
  } finally {
    await dispose();
  }
});

/**
 * The claim when PR #77 was closed unmerged: "this branch is already on local master, nothing was
 * lost." Whether closing it was the lead's call to make is a judgement question. Whether anything
 * was lost is not, so that part is checked.
 */
test('the documentation from the PR that was closed unmerged is on master', async () => {
  const policy = await readFile(new URL('../docs/SOURCE_POLICY.md', import.meta.url), 'utf8');
  assert.match(policy, /Why employer boards carry the public tier/,
    'the section the closed PR added must be present');
  assert.match(policy, /Workday is excluded from the public tier/);
  assert.match(policy, /Workable/, 'the platform the lead added on the workers behalf must be listed');
  const mvp = await readFile(new URL('../docs/MVP.md', import.meta.url), 'utf8');
  assert.match(mvp, /96% English-confirmed/, 'the measured comparison must be present');
});

/**
 * The claim when the Indeed draft was merged: it changes behaviour for nobody, because it ships
 * disabled and administrator-only. That is exactly the kind of claim that quietly stops being
 * true, so it is pinned rather than trusted.
 */
test('Indeed is still shipped disabled and administrator-only', () => {
  const indeed = jobSourceAdapters.filter((adapter) => adapter.experimentalIndeed);
  assert.equal(indeed.length, 2, 'one adapter per country');
  for (const adapter of indeed) {
    assert.equal(adapter.availability, 'disabled', `${adapter.key} must not be enabled`);
    assert.equal(adapter.adminOnly, true, `${adapter.key} must stay administrator-only`);
  }
});

test('every Indeed host alias is hidden from an ordinary account', () => {
  // The defect this guards against has happened here before: 218 Careerjet rows were visible
  // because they were stored under jobviewtrack.com while the hidden list named careerjet-ch.
  const hidden = adminOnlySourceKeys();
  const exposed = INDEED_SOURCE_KEYS.filter((key) => !hidden.has(key));
  assert.deepEqual(exposed, [], 'these Indeed aliases would reach an ordinary account');
});

/**
 * The claim that closed #87: pdf.js is pointed at a same-origin worker URL, not a blob, so
 * `worker-src 'self'` does not break PDF CV parsing when CV matching is switched back on.
 *
 * This is the weakest check here, and worth saying so: it reads the source rather than running
 * the parser, because the parser needs a browser. It fails if someone switches to a blob worker,
 * which is the change that would make the dismissal wrong.
 */
test('pdf.js uses a same-origin worker, so worker-src stays closed', async () => {
  const source = await readFile(new URL('../app/job-radar.tsx', import.meta.url), 'utf8');
  assert.match(source, /pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url/,
    'the worker must be imported as a URL, not constructed');

  // Narrowed after the first version of this check failed on `URL.createObjectURL(new Blob(...))`
  // in downloadText. That is the CSV/JSON export handing a file to an <a download>, which
  // worker-src does not govern at all - a false positive in the check, not a defect in the code.
  // What would actually reopen #87 is a worker built from a blob, so that is what is asserted.
  assert.doesNotMatch(source, /workerSrc\s*=\s*URL\.createObjectURL/,
    'pointing pdf.js at a blob would be refused by worker-src and would reopen #87');
  assert.doesNotMatch(source, /new Worker\(/,
    'a hand-constructed worker needs its source checked against worker-src before it is added');
});

/**
 * The subtlety the whole nonce change rests on: the policy must be set on the REQUEST headers,
 * because that is where the renderer reads the nonce from. Setting it only on the response
 * produces a page that renders and does nothing - and no test outside a browser would notice.
 */
test('the CSP nonce is put where the renderer reads it', async () => {
  const middleware = await readFile(new URL('../middleware.ts', import.meta.url), 'utf8');
  assert.match(middleware, /requestHeaders\.set\('content-security-policy', csp\)/,
    'the nonce must reach the renderer through the request headers');
  assert.match(middleware, /NextResponse\.next\(\{ request: \{ headers: requestHeaders \} \}\)/);
  assert.match(middleware, /response\.headers\.set\('content-security-policy', csp\)/,
    'and the browser still needs it on the response');
});
