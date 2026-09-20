import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { backfillJobRoomDescriptions, backfillJobRoomPostingDates } from '../lib/job-room-backfill';
import { isPublicationOpen } from '../lib/job-room';
import type { JobRoomAdvertisement, JobRoomParsedJob } from '../lib/job-room';
import { jobIdentityFingerprint } from '../lib/job-identity';

interface FakeJob {
  id: string;
  user_id: string;
  source_key: string;
  source_url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  posted_at: string;
  expires_at: string;
  identity_fingerprint: string;
  cluster_version: number;
  language_status: 'pass' | 'unknown' | 'review' | 'blocked';
  job_room_detail_version: number;
  job_room_posted_at_version: number;
  updated_at: string;
  is_saved: number;
  application_status: string;
  visibility_status: string;
  correction: string;
}

function makeJob(overrides: Partial<FakeJob> & { id: string }): FakeJob {
  return {
    user_id: 'owner-1',
    source_key: 'job-room.ch',
    source_url: `https://www.job-room.ch/job-search/${overrides.id}`,
    title: 'Data Analyst',
    company: 'Example AG',
    location: 'Zürich 8001 ZH',
    description: 'Short English preview for a data role.',
    posted_at: '',
    expires_at: '',
    identity_fingerprint: '',
    cluster_version: 2,
    language_status: 'unknown',
    job_room_detail_version: 0,
    job_room_posted_at_version: 0,
    updated_at: '',
    is_saved: 0,
    application_status: 'not_applied',
    visibility_status: 'active',
    correction: '',
    ...overrides,
  };
}

class FakeStatement {
  private bindings: unknown[] = [];

  constructor(private sql: string, private database: FakeD1) {}

  bind(...bindings: unknown[]) {
    this.bindings = bindings;
    return this;
  }

  async first<T>() {
    if (this.sql.includes('COUNT(*) AS total FROM jobs')) {
      if (this.sql.includes('posted_at')) {
        const [userId, version] = this.bindings as [string, number];
        return { total: this.database.dateless(userId, version).length } as T;
      }
      const [userId, threshold, version] = this.bindings as [string, number, number];
      return { total: this.database.eligible(userId, threshold, version).length } as T;
    }
    if (this.sql.includes('FROM search_settings')) {
      return { role_override_a: 'Data Governance Lead', role_override_b: '' } as T;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes('SELECT id, source_url, title, company, location, description, posted_at')) {
      const [userId, threshold, version, limit] = this.bindings as [string, number, number, number];
      return {
        results: this.database.eligible(userId, threshold, version)
          .slice(0, limit).map((row) => ({ ...row })) as T[],
      };
    }
    if (this.sql.includes('SELECT id, source_url, title, company, location')) {
      const [userId, version, limit] = this.bindings as [string, number, number];
      return {
        results: this.database.dateless(userId, version)
          .slice(0, limit).map((row) => ({ ...row })) as T[],
      };
    }
    if (this.sql.includes('SELECT slot, cv_text, derived_role FROM cvs')) {
      return { results: [{ slot: 'a', cv_text: 'Data governance SQL stakeholder management', derived_role: 'Analyst' }] as T[] };
    }
    return { results: [] as T[] };
  }

  async run() {
    // Description backfill, short-detail branch: always marks the text version; fills the date
    // (plus fingerprint and cluster invalidation) when the fetch answered the date question,
    // and the expiry when the fetch answered that one. The closed-advertisement branch shares
    // the shape with one fewer bind pair: its expiry is observed, not filled, so it is set
    // unconditionally.
    if (this.sql.includes('SET job_room_detail_version = ?')) {
      const row = this.database.jobs.find((job) => job.id === this.bindings[this.bindings.length - 3]
        && job.user_id === this.bindings[this.bindings.length - 2]);
      if (!row) return { meta: { changes: 0 } };
      if (this.bindings.length === 13) {
        const [, dateFill, , expiresFill, , , fingerprint, , postedAtVersion, updatedAt] = this.bindings as
          [number, string, string, string, string, string, string, string, number, string, string, string, number];
        row.job_room_detail_version = 1;
        row.job_room_posted_at_version = postedAtVersion;
        row.updated_at = updatedAt;
        if (dateFill) {
          row.posted_at = dateFill;
          row.identity_fingerprint = fingerprint;
          row.cluster_version = 0;
        }
        if (expiresFill) row.expires_at = expiresFill;
      } else {
        const [, dateFill, , observed, , fingerprint, , postedAtVersion, updatedAt] = this.bindings as
          [number, string, string, string, string, string, string, number, string, string, string, number];
        row.job_room_detail_version = 1;
        row.job_room_posted_at_version = postedAtVersion;
        row.updated_at = updatedAt;
        row.expires_at = observed;
        if (dateFill) {
          row.posted_at = dateFill;
          row.identity_fingerprint = fingerprint;
          row.cluster_version = 0;
        }
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes('UPDATE jobs SET description = ?')) {
      const description = this.bindings[0] as string;
      const languageStatus = this.bindings[1] as FakeJob['language_status'];
      const dateFill = this.bindings[11] as string;
      const expiresFill = this.bindings[13] as string;
      const fingerprint = this.bindings[16] as string;
      const postedAtVersion = this.bindings[20] as number;
      const updatedAt = this.bindings[21] as string;
      const id = this.bindings[22] as string;
      const userId = this.bindings[23] as string;
      const row = this.database.jobs.find((job) => job.id === id && job.user_id === userId);
      if (!row) return { meta: { changes: 0 } };
      row.description = description;
      row.language_status = languageStatus;
      row.job_room_detail_version = 1;
      row.job_room_posted_at_version = postedAtVersion;
      row.updated_at = updatedAt;
      if (dateFill) {
        row.posted_at = dateFill;
        row.identity_fingerprint = fingerprint;
        row.cluster_version = 0;
      }
      if (expiresFill) row.expires_at = expiresFill;
      return { meta: { changes: 1 } };
    }
    // Posting-date backfill, closed advertisement: the same request that proved it records
    // the observed expiry and answers the date question, so the row leaves eligibility.
    if (this.sql.includes('expires_at = ?,') && this.sql.includes('job_room_posted_at_version = ?')) {
      const [published, , observed, fingerprint, , dateMoved, postedAtVersion, updatedAt, id, userId] = this.bindings as
        [string, string, string, string, string, string, number, string, string, string, number];
      const row = this.database.jobs.find((job) => job.id === id && job.user_id === userId);
      if (!row) return { meta: { changes: 0 } };
      if (published) {
        row.posted_at = published;
        row.identity_fingerprint = fingerprint;
        row.cluster_version = 0;
      }
      void dateMoved;
      row.expires_at = observed;
      row.job_room_posted_at_version = postedAtVersion;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    // Posting-date backfill, date filled.
    if (this.sql.includes('UPDATE jobs SET posted_at = ?')) {
      const [published, expiresFill, , fingerprint, , updatedAt, id, userId] = this.bindings as
        [string, string, string, string, number, string, string, string];
      const row = this.database.jobs.find((job) => job.id === id && job.user_id === userId);
      if (!row) return { meta: { changes: 0 } };
      row.posted_at = published;
      if (expiresFill) row.expires_at = expiresFill;
      row.identity_fingerprint = fingerprint;
      row.cluster_version = 0;
      row.job_room_posted_at_version = 1;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    // Posting-date backfill, source publishes no date: answered, not failed.
    if (this.sql.includes('SET job_room_posted_at_version = ?')) {
      const [, expiresFill, , updatedAt, id, userId] = this.bindings as
        [number, string, string, string, string, string, number];
      const row = this.database.jobs.find((job) => job.id === id && job.user_id === userId);
      if (!row) return { meta: { changes: 0 } };
      if (expiresFill) row.expires_at = expiresFill;
      row.job_room_posted_at_version = 1;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

class FakeD1 {
  constructor(public jobs: FakeJob[]) {}

  eligible(userId: string, threshold: number, version: number) {
    return this.jobs.filter((job) => job.user_id === userId && job.source_key === 'job-room.ch'
      && job.description.length < threshold && job.job_room_detail_version < version);
  }

  dateless(userId: string, version: number) {
    return this.jobs.filter((job) => job.user_id === userId && job.source_key === 'job-room.ch'
      && job.posted_at === '' && job.job_room_posted_at_version < version);
  }

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

function parsed(descriptionHtml: string, postedAt = '2026-09-01', expiresAt = '2099-01-01'): JobRoomParsedJob {
  return {
    sourceUrl: 'https://www.job-room.ch/job-search/job-1',
    title: 'Data Analyst',
    company: 'Example AG',
    location: 'Zürich',
    descriptionHtml,
    postedAt,
    expiresAt,
    languageSkills: [
      { languageIsoCode: 'de', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' },
      { languageIsoCode: 'en', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' },
    ],
  };
}

function advertisement(overrides: Partial<JobRoomAdvertisement> = {}): JobRoomAdvertisement {
  return {
    id: 'job-1',
    publication: { startDate: '2026-09-01', endDate: '2099-01-01' },
    status: 'PUBLISHED_PUBLIC',
    jobContent: {
      externalUrl: null,
      jobDescriptions: [{ languageIsoCode: 'en', title: 'Data Analyst',
        description: `<p>${'We need a data specialist for our international team. '.repeat(25)}</p>` }],
      company: { name: 'Example AG' },
      location: { city: 'Zürich' },
      languageSkills: [],
    },
    ...overrides,
  };
}

test('backfills only the signed-in account and preserves actions and corrections', async () => {
  const jobs: FakeJob[] = [
    makeJob({ id: 'job-1', is_saved: 1, application_status: 'applied', visibility_status: 'dismissed', correction: 'pass' }),
    makeJob({ id: 'job-2', user_id: 'owner-2' }),
  ];
  const db = new FakeD1(jobs);
  let fetched = 0;
  const report = await backfillJobRoomDescriptions(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => {
      fetched += 1;
      return parsed(`<p>${'We need a data specialist for our international team. '.repeat(25)}</p>`);
    },
  });

  assert.equal(fetched, 1);
  assert.deepEqual(report.verdictDirections, { 'unknown → blocked': 1 });
  assert.equal(report.updatedCount, 1);
  assert.equal(report.remainingCount, 0);
  assert.equal(jobs[0].is_saved, 1);
  assert.equal(jobs[0].application_status, 'applied');
  assert.equal(jobs[0].visibility_status, 'dismissed');
  assert.equal(jobs[0].correction, 'pass');
  assert.equal(jobs[1].job_room_detail_version, 0);

  const rerun = await backfillJobRoomDescriptions(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => {
      fetched += 1;
      return null;
    },
  });
  assert.equal(rerun.attemptedCount, 0);
  assert.equal(fetched, 1, 'a completed row must not be fetched again');
});

test('records a successful but unusually short detail so it is not fetched forever', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1', description: 'A longer preview text' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomDescriptions(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => parsed('Short'),
  });
  assert.equal(report.unchangedCount, 1);
  assert.equal(report.remainingCount, 0);
  assert.equal(jobs[0].job_room_detail_version, 1);
});

test('backfill route is administrator-only and the update cannot overwrite user decisions', async () => {
  const route = await readFile(new URL('../app/api/admin/job-room-backfill/route.ts', import.meta.url), 'utf8');
  const implementation = await readFile(new URL('../lib/job-room-backfill.ts', import.meta.url), 'utf8');
  assert.match(route, /requireSession\(request, \{ adminOnly: true \}\)/);
  const contentUpdate = implementation.match(/UPDATE jobs SET description = \?[\s\S]*?\.bind/)?.[0] ?? '';
  for (const protectedColumn of ['is_saved', 'application_status', 'visibility_status', 'duplicate_of']) {
    assert.doesNotMatch(contentUpdate, new RegExp(protectedColumn));
  }
  assert.match(contentUpdate, /WHERE id = \? AND user_id = \?/);
  assert.doesNotMatch(implementation, /UPDATE language_feedback/);
});

/**
 * The posting-date half of the Job-Room repair (#88).
 *
 * Every Job-Room row stored before the parser fix carries posted_at = '' — 193 of 193 in the
 * development database — because the parser read a top-level publicationStartDate the API never
 * sends. A dateless row cannot be told apart from a fresh one, so the date is re-fetched from
 * the same public detail endpoint, under the same cap and pace.
 */
test('fills the posting date and re-derives what depends on it, nothing else', async () => {
  const before = 'Short English preview for a data role.';
  const jobs: FakeJob[] = [
    makeJob({ id: 'job-1', is_saved: 1, application_status: 'applied', visibility_status: 'dismissed', correction: 'pass' }),
    // Already dated: not eligible, never refetched.
    makeJob({ id: 'job-2', posted_at: '2026-08-20', identity_fingerprint: 'job-v1-keep', job_room_posted_at_version: 0 }),
    // Another account's dateless row: invisible to this run.
    makeJob({ id: 'job-3', user_id: 'owner-2' }),
  ];
  const db = new FakeD1(jobs);
  let fetched = 0;
  const report = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => {
      fetched += 1;
      return parsed('<p>Unchanged short body.</p>', '2026-08-18');
    },
  });

  assert.equal(fetched, 1);
  assert.equal(report.attemptedCount, 1);
  assert.equal(report.fetchedCount, 1);
  assert.equal(report.updatedCount, 1);
  assert.equal(report.failedCount, 0);
  assert.equal(report.remainingCount, 0);
  assert.equal(report.verdictChangeCount, 0);
  assert.deepEqual(report.verdictDirections, {});
  assert.equal(jobs[0].posted_at, '2026-08-18');
  assert.equal(jobs[0].identity_fingerprint, jobIdentityFingerprint({
    sourceUrl: jobs[0].source_url,
    title: jobs[0].title,
    company: jobs[0].company,
    location: jobs[0].location,
    postedAt: '2026-08-18',
  }));
  assert.ok(jobs[0].identity_fingerprint, 'a filled date must leave a usable fingerprint, not an empty one');
  assert.equal(jobs[0].cluster_version, 0, 'duplicate links were derived dateless and must be re-derived');
  assert.equal(jobs[0].job_room_posted_at_version, 1);
  // Everything the date must not move stays exactly where it was.
  assert.equal(jobs[0].description, before);
  assert.equal(jobs[0].language_status, 'unknown');
  assert.equal(jobs[0].is_saved, 1);
  assert.equal(jobs[0].application_status, 'applied');
  assert.equal(jobs[0].visibility_status, 'dismissed');
  assert.equal(jobs[0].correction, 'pass');
  assert.equal(jobs[1].posted_at, '2026-08-20', 'a held date is never overwritten');
  assert.equal(jobs[1].identity_fingerprint, 'job-v1-keep');
  assert.equal(jobs[2].job_room_posted_at_version, 0);

  const rerun = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => {
      fetched += 1;
      return null;
    },
  });
  assert.equal(rerun.attemptedCount, 0);
  assert.equal(fetched, 1, 'a completed row must not be fetched again');
});

test('marks a row whose source publishes no date so reruns terminate', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => parsed('<p>Body.</p>', ''),
  });
  assert.equal(report.unchangedCount, 1);
  assert.equal(report.updatedCount, 0);
  assert.equal(report.remainingCount, 0);
  assert.equal(jobs[0].posted_at, '', 'nothing is invented when the source publishes no date');
  assert.equal(jobs[0].job_room_posted_at_version, 1);
});

test('leaves failed fetches eligible for a later retry', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => null,
  });
  assert.equal(report.failedCount, 1);
  assert.equal(report.remainingCount, 1);
  assert.equal(jobs[0].job_room_posted_at_version, 0);
});

test('the description backfill fills a missing date from the same fetch', async () => {
  // A short, dateless row is eligible for both repairs; one capped request must answer both so
  // the second pass has nothing left to fetch.
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomDescriptions(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => parsed(`<p>${'We need a data specialist for our international team. '.repeat(25)}</p>`, '2026-08-18'),
  });
  assert.equal(report.updatedCount, 1);
  assert.ok(jobs[0].description.length > 900);
  assert.equal(jobs[0].posted_at, '2026-08-18');
  assert.equal(jobs[0].job_room_posted_at_version, 1);
  assert.equal(jobs[0].cluster_version, 0);

  const dates = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => { throw new Error('must not fetch: the date is already filled'); },
  });
  assert.equal(dates.attemptedCount, 0);
  assert.equal(dates.remainingCount, 0);
});

test('posting-date backfill route is administrator-only and writes only the date', async () => {
  const route = await readFile(new URL('../app/api/admin/job-room-posting-date-backfill/route.ts', import.meta.url), 'utf8');
  const implementation = await readFile(new URL('../lib/job-room-backfill.ts', import.meta.url), 'utf8');
  assert.match(route, /requireSession\(request, \{ adminOnly: true \}\)/);
  const dateUpdate = implementation.match(/UPDATE jobs SET posted_at = \?[\s\S]*?\.bind/)?.[0] ?? '';
  assert.ok(dateUpdate, 'expected a dedicated date-only UPDATE');
  for (const protectedColumn of ['description', 'language_status', 'is_saved', 'application_status',
    'visibility_status', 'duplicate_of', 'language_feedback']) {
    assert.doesNotMatch(dateUpdate, new RegExp(protectedColumn),
      `${protectedColumn} must never move because a date was filled`);
  }
  assert.match(dateUpdate, /WHERE id = \? AND user_id = \? AND posted_at = ''/);
});

/**
 * #97: the end date is kept wherever the backfill already looks.
 *
 * Storing it costs no request at all - it arrived in the same response as the posting date
 * and the description - and it is what lets the card say the advertisement expired without
 * re-fetching every stored job. Like the posting date, an empty value never overwrites one held.
 */
test('an open re-fetch stores the expiry alongside the date', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => parsed('<p>Body.</p>', '2026-08-18', '2026-10-01'),
  });
  assert.equal(report.updatedCount, 1);
  assert.equal(jobs[0].posted_at, '2026-08-18');
  assert.equal(jobs[0].expires_at, '2026-10-01');
});

test('a held expiry is never overwritten by a re-fetch', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1', expires_at: '2026-09-15' })];
  const db = new FakeD1(jobs);
  await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => parsed('<p>Body.</p>', '2026-08-18', '2026-10-01'),
  });
  assert.equal(jobs[0].expires_at, '2026-09-15');
});

test('the description backfill stores the expiry from the same fetch', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  await backfillJobRoomDescriptions(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchDetail: async () => parsed(`<p>${'We need a data specialist for our international team. '.repeat(25)}</p>`,
      '2026-08-18', '2026-10-01'),
  });
  assert.equal(jobs[0].expires_at, '2026-10-01');
  assert.equal(jobs[0].posted_at, '2026-08-18');
});

/**
 * A stored advertisement that has since closed (#97).
 *
 * This is the case the owner hit: the card looked current and the link led to "no longer
 * active". The raw advertisement is read in the same single capped request that was already
 * going to re-fetch the row - the parsed-detail fetch cannot see it, because the parser
 * refuses closed advertisements by design, which used to make them look like failures and
 * retry forever. The row is marked, never deleted: the person may have applied to it.
 */
test('a re-fetch that finds the advertisement closed marks it expired, not failed', async () => {
  const before = 'Short English preview for a data role.';
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  let fetched = 0;
  const report = await backfillJobRoomDescriptions(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchAdvertisement: async () => {
      fetched += 1;
      return advertisement({ publication: { startDate: '2026-08-01', endDate: '2026-08-15' } });
    },
  });
  assert.equal(fetched, 1, 'closure must be learned in the same single request, not a second one');
  assert.equal(report.fetchedCount, 1);
  assert.equal(report.expiredCount, 1);
  assert.equal(report.failedCount, 0);
  assert.equal(report.remainingCount, 0, 'a marked row must leave eligibility, not retry forever');
  assert.equal(jobs[0].expires_at, '2026-08-15');
  assert.equal(jobs[0].posted_at, '2026-08-01', 'the closed body still publishes its start date');
  assert.equal(jobs[0].description, before, 'a closed advertisement has no new text worth storing');
  assert.equal(jobs[0].language_status, 'unknown', 'expiry must never rescreen a verdict');
  assert.equal(jobs[0].job_room_detail_version, 1);
  assert.equal(jobs[0].job_room_posted_at_version, 1);
  assert.ok(!isPublicationOpen(advertisement(
    { publication: { startDate: '2026-08-01', endDate: jobs[0].expires_at } })),
    'the stored expiry must actually read as closed');
});

test('a closed advertisement also answers the posting-date pass in the same request', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchAdvertisement: async () => advertisement({
      publication: { startDate: '2026-08-01', endDate: '2026-08-15' },
    }),
  });
  assert.equal(report.expiredCount, 1);
  assert.equal(report.failedCount, 0);
  assert.equal(report.remainingCount, 0);
  assert.equal(jobs[0].expires_at, '2026-08-15');
  assert.equal(jobs[0].posted_at, '2026-08-01', 'the closed body still publishes its start date');
  assert.equal(jobs[0].job_room_posted_at_version, 1);
});

test('a cancellation without an end date is observed today, not invented', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchAdvertisement: async () => advertisement({
      publication: { startDate: '2026-08-01' },
      status: 'CANCELLED',
      cancellationDate: '',
    }),
  });
  assert.equal(report.expiredCount, 1);
  assert.equal(jobs[0].expires_at, today,
    'with no published date the observation day is stored, which the card reads as closing today');
});

test('a failed raw fetch stays eligible for a later retry', async () => {
  const jobs: FakeJob[] = [makeJob({ id: 'job-1' })];
  const db = new FakeD1(jobs);
  const report = await backfillJobRoomPostingDates(db as unknown as D1Database, 'owner-1', {
    delayMs: 0,
    fetchAdvertisement: async () => null,
  });
  assert.equal(report.failedCount, 1);
  assert.equal(report.expiredCount, 0);
  assert.equal(report.remainingCount, 1);
  assert.equal(jobs[0].expires_at, '', 'a failure must not invent an expiry');
  assert.equal(jobs[0].job_room_posted_at_version, 0);
});
