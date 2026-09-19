import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { backfillJobRoomDescriptions } from '../lib/job-room-backfill';
import type { JobRoomParsedJob } from '../lib/job-room';

interface FakeJob {
  id: string;
  user_id: string;
  source_key: string;
  source_url: string;
  title: string;
  description: string;
  language_status: 'pass' | 'unknown' | 'review' | 'blocked';
  job_room_detail_version: number;
  updated_at: string;
  is_saved: number;
  application_status: string;
  visibility_status: string;
  correction: string;
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
      const [userId, threshold, version] = this.bindings as [string, number, number];
      return { total: this.database.eligible(userId, threshold, version).length } as T;
    }
    if (this.sql.includes('FROM search_settings')) {
      return { role_override_a: 'Data Governance Lead', role_override_b: '' } as T;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes('SELECT id, source_url, title, description, language_status FROM jobs')) {
      const [userId, threshold, version, limit] = this.bindings as [string, number, number, number];
      return {
        results: this.database.eligible(userId, threshold, version)
          .slice(0, limit).map((row) => ({ ...row })) as T[],
      };
    }
    if (this.sql.includes('SELECT slot, cv_text, derived_role FROM cvs')) {
      return { results: [{ slot: 'a', cv_text: 'Data governance SQL stakeholder management', derived_role: 'Analyst' }] as T[] };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes('SET job_room_detail_version = ?')) {
      const [version, updatedAt, id, userId] = this.bindings as [number, string, string, string];
      const row = this.database.jobs.find((job) => job.id === id && job.user_id === userId);
      if (!row) return { meta: { changes: 0 } };
      row.job_room_detail_version = version;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes('UPDATE jobs SET description = ?')) {
      const description = this.bindings[0] as string;
      const languageStatus = this.bindings[1] as FakeJob['language_status'];
      const version = this.bindings[11] as number;
      const updatedAt = this.bindings[12] as string;
      const id = this.bindings[13] as string;
      const userId = this.bindings[14] as string;
      const row = this.database.jobs.find((job) => job.id === id && job.user_id === userId);
      if (!row) return { meta: { changes: 0 } };
      row.description = description;
      row.language_status = languageStatus;
      row.job_room_detail_version = version;
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

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

function parsed(descriptionHtml: string): JobRoomParsedJob {
  return {
    sourceUrl: 'https://www.job-room.ch/job-search/job-1',
    title: 'Data Analyst',
    company: 'Example AG',
    location: 'Zürich',
    descriptionHtml,
    postedAt: '2026-09-01',
    languageSkills: [
      { languageIsoCode: 'de', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' },
      { languageIsoCode: 'en', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' },
    ],
  };
}

test('backfills only the signed-in account and preserves actions and corrections', async () => {
  const preview = 'Short English preview for a data role.';
  const jobs: FakeJob[] = [
    {
      id: 'job-1', user_id: 'owner-1', source_key: 'job-room.ch',
      source_url: 'https://www.job-room.ch/job-search/job-1', title: 'Data Analyst',
      description: preview, language_status: 'unknown', job_room_detail_version: 0,
      updated_at: '', is_saved: 1, application_status: 'applied', visibility_status: 'dismissed',
      correction: 'pass',
    },
    {
      id: 'job-2', user_id: 'owner-2', source_key: 'job-room.ch',
      source_url: 'https://www.job-room.ch/job-search/job-2', title: 'Data Analyst',
      description: preview, language_status: 'unknown', job_room_detail_version: 0,
      updated_at: '', is_saved: 0, application_status: 'not_applied', visibility_status: 'active',
      correction: '',
    },
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
  const jobs: FakeJob[] = [{
    id: 'job-1', user_id: 'owner-1', source_key: 'job-room.ch',
    source_url: 'https://www.job-room.ch/job-search/job-1', title: 'Analyst',
    description: 'A longer preview text', language_status: 'unknown', job_room_detail_version: 0,
    updated_at: '', is_saved: 0, application_status: 'not_applied', visibility_status: 'active', correction: '',
  }];
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
