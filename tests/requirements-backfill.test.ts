import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { runtimeMigrations } from '../db/migrations';
import { extractRequirements } from '../lib/requirements';
import {
  backfillFlattenedDescriptions,
  MIN_STRUCTURE_BACKFILL_CHARS,
  STRUCTURE_BACKFILL_VERSION,
} from '../lib/requirements-backfill';
import type { ParsedJob } from '../lib/jobsch';

/**
 * #17: restore list structure to employer-board jobs stored before ingest kept markup.
 *
 * Real D1 so the eligibility SQL is what gets tested, and an injected board loader so nothing
 * here touches the network.
 */
const BOARD_URL = 'https://boards.greenhouse.io/example/jobs/1';

/**
 * A flattened advertisement: every line break gone, and comfortably past the length floor, so
 * the test exercises a genuinely flattened ad rather than a capped preview.
 */
// Parenthesised so the repeat applies to the whole sentence, not just its last fragment.
const padding = (`The team works in English across engineering, product and legal, and the role `
  + `reports to the head of data. We value people who explain their reasoning and who can say `
  + `when something is not yet understood. `).repeat(4);
const flattened = `About the role We are hiring a Data Governance Analyst for our Amsterdam office. `
  + `You will own the data catalogue and work with engineering and legal. ${padding} What we are looking for `
  + `Five years of experience in data governance. A degree in information management or similar. `
  + `Fluent English, written and spoken, for a fully English-speaking team. `
  + `Experience with SAP master data at enterprise scale. Comfortable presenting to stakeholders. `
  + `What we offer A competitive salary, a learning budget and a hybrid schedule.`;

/** The same advertisement as the board actually serves it. */
const boardHtml = `<p>About the role</p><p>We are hiring a Data Governance Analyst for our `
  + `Amsterdam office. You will own the data catalogue and work with engineering and legal.</p>`
  + `<p>${padding}</p>`
  + `<h3>What we are looking for</h3><ul>`
  + `<li>Five years of experience in data governance.</li>`
  + `<li>A degree in information management or similar.</li>`
  + `<li>Fluent English, written and spoken, for a fully English-speaking team.</li>`
  + `<li>Experience with SAP master data at enterprise scale.</li>`
  + `<li>Comfortable presenting to stakeholders across the business.</li>`
  + `</ul><h3>What we offer</h3><p>A competitive salary, a learning budget and a hybrid schedule.</p>`;

function boardJob(overrides: Partial<ParsedJob> = {}): ParsedJob {
  return {
    sourceUrl: BOARD_URL,
    title: 'Data Governance Analyst',
    company: 'Example',
    location: 'Amsterdam, Netherlands',
    descriptionHtml: boardHtml,
    postedAt: '2026-09-01',
    ...overrides,
  } as ParsedJob;
}

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
    canonical_url TEXT NOT NULL DEFAULT '',
    source_key TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    language_status TEXT NOT NULL DEFAULT 'unknown',
    language_summary TEXT NOT NULL DEFAULT '',
    language_signals TEXT NOT NULL DEFAULT '[]',
    fit_score_a INTEGER NOT NULL DEFAULT 0,
    fit_score_b INTEGER NOT NULL DEFAULT 0,
    best_cv_slot TEXT NOT NULL DEFAULT '',
    matched_keywords TEXT NOT NULL DEFAULT '[]',
    missing_keywords TEXT NOT NULL DEFAULT '[]',
    workplace_type TEXT NOT NULL DEFAULT 'unknown',
    is_saved INTEGER NOT NULL DEFAULT 0,
    application_status TEXT NOT NULL DEFAULT 'not_applied',
    visibility_status TEXT NOT NULL DEFAULT 'active',
    normalized_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '2026-09-01'
  )`).run();
  await db.prepare("CREATE TABLE cvs (user_id TEXT, slot TEXT, cv_text TEXT, derived_role TEXT)").run();
  await db.prepare("CREATE TABLE search_settings (user_id TEXT, role_override_a TEXT DEFAULT '', role_override_b TEXT DEFAULT '')").run();
  // The columns under test arrive through their own migrations, as they do in the real database.
  await db.batch(runtimeMigrations.find((entry) => entry.version === 20)!.statements.map((sql) => db.prepare(sql)));
  await db.batch(runtimeMigrations.find((entry) => entry.version === 21)!.statements.map((sql) => db.prepare(sql)));
  return { db, dispose: () => runtime.dispose() };
}

async function addJob(db: D1Database, id: string, userId: string, description: string, url = BOARD_URL) {
  await db.prepare(`INSERT INTO jobs (id, user_id, source_url, canonical_url, title, location, description, is_saved, application_status)
    VALUES (?, ?, ?, ?, 'Data Governance Analyst', 'Amsterdam, Netherlands', ?, 1, 'applied')`)
    .bind(id, userId, url, url, description).run();
}

test('a flattened advertisement regains its requirements list', async () => {
  const { db, dispose } = await fixture();
  try {
    await addJob(db, 'job-1', 'alice', flattened);
    assert.equal(extractRequirements(flattened), null, 'the stored row must start with no requirements');

    const report = await backfillFlattenedDescriptions(db, 'alice', { loadBoardJobs: async () => [boardJob()] });
    assert.equal(report.eligibleCount, 1);
    assert.equal(report.matchedCount, 1);
    assert.equal(report.updatedCount, 1);
    assert.equal(report.gainedRequirementsCount, 1);
    assert.equal(report.remainingCount, 0);

    const row = await db.prepare('SELECT description, structure_version, is_saved, application_status FROM jobs WHERE id = ?')
      .bind('job-1').first<{ description: string; structure_version: number; is_saved: number; application_status: string }>();
    const requirements = extractRequirements(row!.description);
    assert.ok(requirements, 'requirements should now be extractable');
    assert.match(requirements.heading, /What we are looking for/i);
    assert.ok(requirements.items.length >= 2);
    assert.equal(row!.structure_version, STRUCTURE_BACKFILL_VERSION);

    // A maintenance pass must never quietly undo something the person did.
    assert.equal(row!.is_saved, 1, 'the saved flag must survive');
    assert.equal(row!.application_status, 'applied', 'the application state must survive');
  } finally {
    await dispose();
  }
});

test('a capped preview is never re-read, however flat it is', async () => {
  const { db, dispose } = await fixture();
  try {
    // An Adzuna teaser: no line breaks, but nothing to recover either. 1,312 of the 1,677
    // flat rows in the stored corpus look like this, and re-reading them would spend requests
    // on other people's servers to receive the identical text back.
    const teaser = 'A'.repeat(MIN_STRUCTURE_BACKFILL_CHARS - 1);
    await addJob(db, 'job-teaser', 'alice', teaser);

    let loaderCalls = 0;
    const report = await backfillFlattenedDescriptions(db, 'alice', {
      loadBoardJobs: async () => { loaderCalls += 1; return [boardJob()]; },
    });
    assert.equal(report.eligibleCount, 0);
    assert.equal(report.attemptedCount, 0);
    assert.equal(loaderCalls, 0, 'with nothing eligible, the boards must not be read at all');
  } finally {
    await dispose();
  }
});

test('a job that already has line breaks is left alone', async () => {
  const { db, dispose } = await fixture();
  try {
    await addJob(db, 'job-structured', 'alice', `What we are looking for\n• ${'x'.repeat(920)}\n• second item here`);
    const report = await backfillFlattenedDescriptions(db, 'alice', { loadBoardJobs: async () => [boardJob()] });
    assert.equal(report.eligibleCount, 0, 'structure already present is not a reason to re-read');
  } finally {
    await dispose();
  }
});

test('a posting no longer on any board is left for a later run, not written off', async () => {
  const { db, dispose } = await fixture();
  try {
    await addJob(db, 'job-gone', 'alice', flattened, 'https://boards.greenhouse.io/example/jobs/999');
    const report = await backfillFlattenedDescriptions(db, 'alice', { loadBoardJobs: async () => [boardJob()] });
    assert.equal(report.notFoundCount, 1);
    assert.equal(report.updatedCount, 0);

    const row = await db.prepare('SELECT structure_version FROM jobs WHERE id = ?').bind('job-gone')
      .first<{ structure_version: number }>();
    // Not stamped: configuring that employer's board later should let this row be picked up.
    assert.equal(row!.structure_version, 0);
    assert.equal(report.remainingCount, 1);
  } finally {
    await dispose();
  }
});

test("a board whose own copy is flat is stamped so it is not re-read forever", async () => {
  const { db, dispose } = await fixture();
  try {
    await addJob(db, 'job-flat-source', 'alice', flattened);
    const report = await backfillFlattenedDescriptions(db, 'alice', {
      loadBoardJobs: async () => [boardJob({ descriptionHtml: `<p>${flattened}</p>` })],
    });
    assert.equal(report.matchedCount, 1);
    assert.equal(report.unchangedCount, 1);
    assert.equal(report.updatedCount, 0);
    assert.equal(report.remainingCount, 0, 'stamped, so a second run finds nothing to do');
  } finally {
    await dispose();
  }
});

test('the backfill never reaches another account', async () => {
  const { db, dispose } = await fixture();
  try {
    await addJob(db, 'job-alice', 'alice', flattened);
    await addJob(db, 'job-bob', 'bob', flattened, 'https://boards.greenhouse.io/example/jobs/2');

    const report = await backfillFlattenedDescriptions(db, 'alice', {
      loadBoardJobs: async () => [boardJob(), boardJob({ sourceUrl: 'https://boards.greenhouse.io/example/jobs/2' })],
    });
    assert.equal(report.updatedCount, 1, "only alice's row may be touched");

    const bob = await db.prepare('SELECT description, structure_version FROM jobs WHERE id = ?').bind('job-bob')
      .first<{ description: string; structure_version: number }>();
    assert.equal(bob!.description, flattened, "bob's row must be untouched");
    assert.equal(bob!.structure_version, 0);
  } finally {
    await dispose();
  }
});
