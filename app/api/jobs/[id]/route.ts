import { NextResponse } from 'next/server';
import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { canonicalJobUrl, jobIdentityFingerprint, sourceInfoForUrl, sourceJobIdFromUrl } from '@/lib/job-identity';
import { normalizeLanguageFeedback } from '@/lib/language-feedback';
import type { ApplicationStatus, VisibilityStatus } from '@/lib/types';

const applicationStatuses = new Set<ApplicationStatus>(['not_applied', 'applied']);
const visibilityStatuses = new Set<VisibilityStatus>(['active', 'dismissed']);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const { id } = await context.params;
  const body = await request.json() as Record<string, unknown>;
  const hasSavedState = body.isSaved !== undefined;
  const hasApplicationStatus = body.applicationStatus !== undefined;
  const hasVisibilityStatus = body.visibilityStatus !== undefined;
  const hasLanguageFeedback = body.languageFeedback !== undefined;
  if (!hasSavedState && !hasApplicationStatus && !hasVisibilityStatus && !hasLanguageFeedback) {
    return NextResponse.json({ error: 'No supported update was provided.' }, { status: 400 });
  }
  if (hasSavedState && typeof body.isSaved !== 'boolean') return NextResponse.json({ error: 'Invalid saved state.' }, { status: 400 });
  const applicationStatus = body.applicationStatus as ApplicationStatus;
  if (hasApplicationStatus && !applicationStatuses.has(applicationStatus)) return NextResponse.json({ error: 'Invalid application status.' }, { status: 400 });
  const visibilityStatus = body.visibilityStatus as VisibilityStatus;
  if (hasVisibilityStatus && !visibilityStatuses.has(visibilityStatus)) return NextResponse.json({ error: 'Invalid visibility status.' }, { status: 400 });
  const feedback = hasLanguageFeedback
    ? normalizeLanguageFeedback(body.languageFeedback, body.correctedLanguageStatus, body.languageFeedbackReason)
    : null;
  if (hasLanguageFeedback && !feedback) return NextResponse.json({ error: 'Invalid language feedback.' }, { status: 400 });

  const job = await db.prepare(`SELECT id, source_url, source_key, source_job_id, canonical_url, identity_fingerprint,
      title, company, location, posted_at
    FROM jobs WHERE id = ? AND user_id = ?`).bind(id, user.id).first<{
      id: string;
      source_url: string;
      source_key: string;
      source_job_id: string;
      canonical_url: string;
      identity_fingerprint: string;
      title: string;
      company: string;
      location: string;
      posted_at: string;
    }>();
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  if (hasSavedState) statements.push(db.prepare('UPDATE jobs SET is_saved = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(body.isSaved ? 1 : 0, now, id));
  if (hasApplicationStatus) statements.push(db.prepare('UPDATE jobs SET application_status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(applicationStatus, now, id));
  if (hasVisibilityStatus) {
    statements.push(db.prepare('UPDATE jobs SET visibility_status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(visibilityStatus, now, id));
    if (visibilityStatus === 'dismissed') {
      const canonicalUrl = canonicalJobUrl(job.canonical_url || job.source_url);
      const source = sourceInfoForUrl(canonicalUrl, job.location);
      const sourceJobId = job.source_job_id || sourceJobIdFromUrl(canonicalUrl);
      const identityFingerprint = job.identity_fingerprint || jobIdentityFingerprint({
        sourceUrl: canonicalUrl,
        title: job.title,
        company: job.company,
        location: job.location,
        postedAt: job.posted_at,
      });
      statements.push(db.prepare(`INSERT INTO dismissed_jobs
          (id, user_id, source_key, source_job_id, canonical_url, identity_fingerprint, dismissed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source_key = excluded.source_key, source_job_id = excluded.source_job_id,
          canonical_url = excluded.canonical_url, identity_fingerprint = excluded.identity_fingerprint,
          dismissed_at = excluded.dismissed_at`)
        .bind(id, user.id, job.source_key || source.key, sourceJobId, canonicalUrl, identityFingerprint, now));
    } else {
      statements.push(db.prepare(`DELETE FROM dismissed_jobs WHERE user_id = ? AND (id = ?
        OR (? != '' AND source_key = ? AND source_job_id = ?)
        OR (? != '' AND canonical_url = ?)
        OR (? != '' AND identity_fingerprint = ?))`)
        .bind(user.id, id, job.source_job_id, job.source_key, job.source_job_id, job.canonical_url, job.canonical_url,
          job.identity_fingerprint, job.identity_fingerprint));
    }
  }
  if (feedback?.verdict) {
    statements.push(db.prepare(`INSERT INTO language_feedback (job_id, user_id, verdict, corrected_status, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET verdict = excluded.verdict, corrected_status = excluded.corrected_status,
      reason = excluded.reason, updated_at = excluded.updated_at`)
      .bind(id, user.id, feedback.verdict, feedback.correctedStatus, feedback.reason, now));
  } else if (hasLanguageFeedback) {
    statements.push(db.prepare('DELETE FROM language_feedback WHERE job_id = ? AND user_id = ?').bind(id, user.id));
  }
  if (hasSavedState || hasApplicationStatus || hasVisibilityStatus) {
    statements.push(db.prepare(`UPDATE jobs SET status = CASE
      WHEN visibility_status = 'dismissed' THEN 'ignored'
      WHEN application_status = 'applied' THEN 'applied'
      WHEN is_saved = 1 THEN 'saved'
      ELSE 'new' END WHERE id = ? AND user_id = ?`).bind(id, user.id));
  }
  await db.batch(statements);
  return NextResponse.json({ ok: true, feedback, isSaved: body.isSaved, applicationStatus, visibilityStatus });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const { id } = await context.params;
  await db.batch([
    db.prepare('DELETE FROM language_feedback WHERE job_id = ? AND user_id = ?').bind(id, user.id),
    db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').bind(id, user.id),
  ]);
  return NextResponse.json({ ok: true });
}
