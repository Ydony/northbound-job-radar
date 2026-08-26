import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { analyzeLanguage, scoreFitAcrossCvs } from '@/lib/analysis';
import { roleForSlot } from '@/lib/criteria';
import { isJobsChUrl } from '@/lib/jobsch';
import { criteriaFromRow, upsertJob, type CriteriaRow } from '@/lib/server-data';
import type { CvSlot } from '@/lib/types';

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function POST(request: Request) {
  await ensureSchema();
  const payload = await request.json() as Record<string, unknown>;
  const sourceUrl = clean(payload.sourceUrl, 1000);
  const title = clean(payload.title, 240);
  const company = clean(payload.company, 240);
  const location = clean(payload.location, 240) || 'Switzerland';
  const description = clean(payload.description, 120_000);

  if (!isJobsChUrl(sourceUrl)) return NextResponse.json({ error: 'Paste a valid https://www.jobs.ch job URL.' }, { status: 400 });
  if (!title) return NextResponse.json({ error: 'Add the job title.' }, { status: 400 });
  if (description.length < 160) return NextResponse.json({ error: 'Paste the full job advertisement so the language gate has enough evidence.' }, { status: 400 });

  const { db } = bindings();
  const [cvRows, criteriaRow] = await Promise.all([
    db.prepare('SELECT slot, cv_text, derived_role FROM cvs')
      .all<{ slot: CvSlot; cv_text: string; derived_role: string }>(),
    db.prepare('SELECT * FROM search_settings WHERE id = ?').bind('default').first<CriteriaRow>(),
  ]);
  if (!cvRows.results.length) return NextResponse.json({ error: 'Upload at least one CV before analyzing jobs.' }, { status: 400 });
  const criteria = criteriaFromRow(criteriaRow);
  const cvs = cvRows.results.map((row) => ({
    slot: row.slot,
    cvText: row.cv_text,
    derivedRole: roleForSlot(row.slot, row.derived_role, criteria),
  }));

  const language = analyzeLanguage(description);
  const fit = scoreFitAcrossCvs(description, title, cvs);
  const job = await upsertJob(db, {
    sourceUrl, title, company, location, description,
    languageStatus: language.status, languageSummary: language.summary, languageSignals: language.signals,
    ...fit,
  });
  return NextResponse.json({ job });
}
