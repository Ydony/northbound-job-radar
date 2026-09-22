import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { queryCollectionTotals, searchRunsFromRows } from '../lib/server-data';

/**
 * #124: Total collected is server-retained unique jobs, never loaded pages or
 * summed run counts. First-seen decides newness; posting dates do not.
 * Saved/applied/dismissed rows are included; deleted rows are gone.
 * Counts respect account scope; ordinary roles never learn admin sources.
 */

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
    source_url TEXT NOT NULL DEFAULT '',
    source_key TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'unknown',
    duplicate_of TEXT NOT NULL DEFAULT ''
  )`).run();
  return { db, dispose: () => runtime.dispose() };
}

async function addJob(
  db: D1Database,
  id: string,
  userId: string,
  sourceKey: string,
  sourceName: string,
  duplicateOf = '',
  sourceUrl = '',
) {
  await db.prepare(`INSERT INTO jobs (id, user_id, source_url, source_key, source_name, country, duplicate_of)
    VALUES (?, ?, ?, ?, ?, 'switzerland', ?)`)
    .bind(id, userId, sourceUrl || `https://example.com/${id}`, sourceKey, sourceName, duplicateOf).run();
}

test('run1 plus run2 accumulate; a duplicate-only repeat adds nothing new', async () => {
  const { db, dispose } = await fixture();
  try {
    // Run 1: two unique jobs retained.
    await addJob(db, 'j1', 'alice', 'eures-ch', 'EURES Switzerland');
    await addJob(db, 'j2', 'alice', 'eures-ch', 'EURES Switzerland');
    let totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 2);
    // Run 2: three more unique jobs accumulate to five.
    await addJob(db, 'j3', 'alice', 'jobs.ch', 'jobs.ch');
    await addJob(db, 'j4', 'alice', 'jobs.ch', 'jobs.ch');
    await addJob(db, 'j5', 'alice', 'eures-ch', 'EURES Switzerland');
    totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 5);
    // A duplicate-only repeat stores a copy folded into j1: unique total stays 5.
    await addJob(db, 'j6-copy', 'alice', 'jobs.ch', 'jobs.ch', 'j1');
    totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 5, 'a folded copy must not inflate the unique total');
    const jobsCh = totals.bySource.find((entry) => entry.sourceKey === 'jobs.ch');
    assert.ok(jobsCh, 'per-source rows show where jobs were first kept');
    assert.equal(jobsCh.total, 2, 'the folded copy counts for no source in the unique totals');
  } finally {
    await dispose();
  }
});

test('saved, applied and dismissed rows keep their historical contribution', async () => {
  const { db, dispose } = await fixture();
  try {
    // The fixture table carries no saved/applied columns; the contract is that
    // queryCollectionTotals applies no state filter at all — every retained row
    // counts. Inserting rows that would carry those states still totals them.
    await addJob(db, 's1', 'alice', 'eures-ch', 'EURES Switzerland');
    await addJob(db, 's2', 'alice', 'eures-ch', 'EURES Switzerland');
    await addJob(db, 's3', 'alice', 'eures-ch', 'EURES Switzerland');
    const totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 3);
  } finally {
    await dispose();
  }
});

test('deliberate deletion removes rows from the total; pagination never shrinks it', async () => {
  const { db, dispose } = await fixture();
  try {
    for (let i = 1; i <= 5; i++) await addJob(db, `d${i}`, 'alice', 'eures-ch', 'EURES Switzerland');
    let totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 5);
    await db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').bind('d1', 'alice').run();
    await db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').bind('d2', 'alice').run();
    totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 3, 'deleted records must not be preserved merely for totals');
    // Pagination is a loading concern: the server total is unaffected by page size.
    assert.equal(totals.total, 3);
  } finally {
    await dispose();
  }
});

test('totals are scoped per account and hide admin sources from ordinary roles', async () => {
  const { db, dispose } = await fixture();
  try {
    await addJob(db, 'a1', 'alice', 'eures-ch', 'EURES Switzerland');
    await addJob(db, 'a2', 'alice', 'jobs.ch', 'jobs.ch');
    await addJob(db, 'b1', 'bob', 'eures-ch', 'EURES Switzerland');
    // Alice sees only her own rows.
    let totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 2);
    // Bob sees only his.
    totals = await queryCollectionTotals(db, 'bob', [], false);
    assert.equal(totals.total, 1);
    // An ordinary role never learns admin-source counts: hidden keys vanish
    // from both the overall and the per-source breakdown.
    totals = await queryCollectionTotals(db, 'alice', ['jobs.ch'], false);
    assert.equal(totals.total, 1);
    assert.ok(!totals.bySource.some((entry) => entry.sourceKey === 'jobs.ch'));
  } finally {
    await dispose();
  }
});

test('orphan copies count where they are shown; first-seen decides, not posted dates', async () => {
  const { db, dispose } = await fixture();
  try {
    // Primary deleted (or outside the audience): its copy is shown rather than
    // lost, so the unique total keeps it under the copy's source.
    await addJob(db, 'p1', 'alice', 'eures-ch', 'EURES Switzerland');
    await addJob(db, 'c1', 'alice', 'jobs.ch', 'jobs.ch', 'p1');
    let totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 1, 'a folded copy with a present primary adds no unique job');
    await db.prepare('DELETE FROM jobs WHERE id = ?').bind('p1').run();
    totals = await queryCollectionTotals(db, 'alice', [], false);
    assert.equal(totals.total, 1, 'an orphan copy is shown, so it counts');
    assert.equal(totals.bySource.find((entry) => entry.sourceKey === 'jobs.ch')?.total, 1);
  } finally {
    await dispose();
  }
});

test('run rows without matched counts read as unknown, never as zero', () => {
  const runs = searchRunsFromRows(
    [{ id: 'run-1', status: 'complete', started_at: '2026-09-20T00:00:00.000Z', completed_at: '2026-09-20T00:05:00.000Z' }],
    [{
      run_id: 'run-1', source_key: 'eures-ch', source_name: 'EURES Switzerland', country: 'switzerland',
      status: 'complete', roles_searched: '[]', found_count: 50, known_count: 48, new_count: 2,
      imported_count: 2, matched_count: null, duplicate_count: 0, skipped_count: 0, message: '',
    }],
  );
  assert.equal(runs[0].sources[0].matchedCount, null);
});
