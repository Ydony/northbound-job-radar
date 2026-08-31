import { NextResponse } from 'next/server';
import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { analyzeLanguage, scoreFitAcrossCvs } from '@/lib/analysis';
import { roleForSlot } from '@/lib/criteria';
import { isSafeManualJobUrl } from '@/lib/job-sources';
import { canonicalJobUrl } from '@/lib/job-identity';
import { criteriaFromRow, upsertJob, type CriteriaRow } from '@/lib/server-data';
import type { CvSlot } from '@/lib/types';
import { CV_MATCHING_ENABLED } from '@/lib/features';

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function POST(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const payload = await request.json() as Record<string, unknown>;
  const sourceUrl = canonicalJobUrl(clean(payload.sourceUrl, 1000));
  const title = clean(payload.title, 240);
  const company = clean(payload.company, 240);
  const location = clean(payload.location, 240) || 'Location not added';
  const description = clean(payload.description, 120_000);
  const postedAt = clean(payload.postedAt, 80);

  if (!isSafeManualJobUrl(sourceUrl)) return NextResponse.json({ error: 'Paste a valid public HTTPS job-ad URL.' }, { status: 400 });
  if (!title) return NextResponse.json({ error: 'Add the job title.' }, { status: 400 });
  if (description.length < 160) return NextResponse.json({ error: 'Paste the full job advertisement so the language gate has enough evidence.' }, { status: 400 });

  const [cvRows, criteriaRow] = await Promise.all([
    db.prepare('SELECT slot, cv_text, derived_role FROM cvs WHERE user_id = ?').bind(user.id)
      .all<{ slot: CvSlot; cv_text: string; derived_role: string }>(),
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
  ]);
  if (CV_MATCHING_ENABLED && !cvRows.results.length) {
    return NextResponse.json({ error: 'Upload at least one CV before analyzing jobs.' }, { status: 400 });
  }
  const criteria = criteriaFromRow(criteriaRow);
  const cvs = cvRows.results.map((row) => ({
    slot: row.slot,
    cvText: row.cv_text,
    derivedRole: roleForSlot(row.slot, row.derived_role, criteria),
  }));

  const language = analyzeLanguage(description, title);
  const fit = scoreFitAcrossCvs(description, title, cvs);
  const result = await upsertJob(db, user.id, {
    sourceUrl, title, company, location, description,
    languageStatus: language.status, languageSummary: language.summary, languageSignals: language.signals,
    postedAt,
    ...fit,
  });
  return NextResponse.json({ job: result.job, duplicate: result.wasKnown || result.wasDuplicate, dismissed: result.wasDismissed });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const all = body.all === true;
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 250)
    : [];
  if (!all && !ids.length) return NextResponse.json({ error: 'Choose at least one job to delete.' }, { status: 400 });

  if (all) {
    const results = await db.batch([
      db.prepare('DELETE FROM language_feedback WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM jobs WHERE user_id = ?').bind(user.id),
    ]);
    return NextResponse.json({ ok: true, deletedJobs: results[1].meta.changes ?? 0 });
  }

  const placeholders = ids.map(() => '?').join(',');
  const results = await db.batch([
    db.prepare(`DELETE FROM language_feedback WHERE user_id = ? AND job_id IN (${placeholders})`).bind(user.id, ...ids),
    db.prepare(`DELETE FROM jobs WHERE user_id = ? AND id IN (${placeholders})`).bind(user.id, ...ids),
  ]);
  return NextResponse.json({ ok: true, deletedJobs: results[1].meta.changes ?? 0 });
}
