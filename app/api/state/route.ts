import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { criteriaFromRow, cvFromRow, jobFromRow, type CriteriaRow, type CvRow, type JobRow } from '@/lib/server-data';

export async function GET() {
  await ensureSchema();
  const { db } = bindings();
  const [cvs, jobs, criteria] = await Promise.all([
    db.prepare('SELECT * FROM cvs ORDER BY slot').all<CvRow>(),
    db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 250').all<JobRow>(),
    db.prepare('SELECT * FROM search_settings WHERE id = ?').bind('default').first<CriteriaRow>(),
  ]);
  return NextResponse.json({ profiles: cvs.results.map(cvFromRow), jobs: jobs.results.map(jobFromRow), criteria: criteriaFromRow(criteria) });
}
