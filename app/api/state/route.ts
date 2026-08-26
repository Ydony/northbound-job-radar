import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { cvFromRow, jobFromRow, type CvRow, type JobRow } from '@/lib/server-data';

export async function GET() {
  await ensureSchema();
  const { db } = bindings();
  const [cvs, jobs] = await Promise.all([
    db.prepare('SELECT * FROM cvs ORDER BY slot').all<CvRow>(),
    db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 250').all<JobRow>(),
  ]);
  return NextResponse.json({ profiles: cvs.results.map(cvFromRow), jobs: jobs.results.map(jobFromRow) });
}
