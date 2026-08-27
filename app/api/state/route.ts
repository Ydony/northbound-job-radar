import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { criteriaFromRow, cvFromRow, jobFromRow, searchRunsFromRows, type CriteriaRow, type CvRow,
  type JobRow, type SearchRoleRow, type SearchRunRow, type SearchRunSourceRow } from '@/lib/server-data';

export async function GET() {
  await ensureSchema();
  const { db } = bindings();
  const [cvs, jobs, criteria, roles, runs] = await Promise.all([
    db.prepare('SELECT * FROM cvs ORDER BY slot').all<CvRow>(),
    db.prepare(`SELECT jobs.*, language_feedback.verdict AS feedback_verdict,
      language_feedback.corrected_status AS feedback_corrected_status,
      language_feedback.reason AS feedback_reason, language_feedback.updated_at AS feedback_updated_at
      FROM jobs LEFT JOIN language_feedback ON language_feedback.job_id = jobs.id
      ORDER BY jobs.updated_at DESC LIMIT 250`).all<JobRow>(),
    db.prepare('SELECT * FROM search_settings WHERE id = ?').bind('default').first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles ORDER BY position').all<SearchRoleRow>(),
    db.prepare('SELECT * FROM search_runs ORDER BY started_at DESC LIMIT 12').all<SearchRunRow>(),
  ]);
  const runIds = runs.results.map((run) => run.id);
  const runSources = runIds.length
    ? await db.prepare(`SELECT * FROM search_run_sources WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY source_name`)
      .bind(...runIds).all<SearchRunSourceRow>()
    : { results: [] as SearchRunSourceRow[] };
  return NextResponse.json({
    profiles: cvs.results.map(cvFromRow),
    jobs: jobs.results.map(jobFromRow),
    criteria: criteriaFromRow(criteria, roles.results),
    searchRuns: searchRunsFromRows(runs.results, runSources.results),
  });
}
