import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { criteriaFromRow, cvFromRow, jobFromRow, type CriteriaRow, type CvRow, type JobRow } from '@/lib/server-data';

export async function GET() {
  await ensureSchema();
  const { db } = bindings();
  const [cvs, jobs, criteria] = await Promise.all([
    db.prepare('SELECT * FROM cvs ORDER BY slot').all<CvRow>(),
    db.prepare(`SELECT jobs.*, language_feedback.verdict AS feedback_verdict,
      language_feedback.corrected_status AS feedback_corrected_status,
      language_feedback.reason AS feedback_reason, language_feedback.updated_at AS feedback_updated_at
      FROM jobs LEFT JOIN language_feedback ON language_feedback.job_id = jobs.id
      ORDER BY jobs.updated_at DESC LIMIT 250`).all<JobRow>(),
    db.prepare('SELECT * FROM search_settings WHERE id = ?').bind('default').first<CriteriaRow>(),
  ]);
  return NextResponse.json({ profiles: cvs.results.map(cvFromRow), jobs: jobs.results.map(jobFromRow), criteria: criteriaFromRow(criteria) });
}
