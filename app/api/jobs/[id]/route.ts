import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { normalizeLanguageFeedback } from '@/lib/language-feedback';
import type { JobStatus } from '@/lib/types';

const statuses = new Set<JobStatus>(['new', 'saved', 'applied', 'ignored']);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await context.params;
  const body = await request.json() as Record<string, unknown>;
  const hasStatus = body.status !== undefined;
  const hasLanguageFeedback = body.languageFeedback !== undefined;
  if (!hasStatus && !hasLanguageFeedback) return NextResponse.json({ error: 'No supported update was provided.' }, { status: 400 });
  const status = body.status as JobStatus;
  if (hasStatus && !statuses.has(status)) return NextResponse.json({ error: 'Invalid job status.' }, { status: 400 });
  const feedback = hasLanguageFeedback
    ? normalizeLanguageFeedback(body.languageFeedback, body.correctedLanguageStatus, body.languageFeedbackReason)
    : null;
  if (hasLanguageFeedback && !feedback) return NextResponse.json({ error: 'Invalid language feedback.' }, { status: 400 });

  const { db } = bindings();
  const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').bind(id).first<{ id: string }>();
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  if (hasStatus) statements.push(db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, id));
  if (feedback?.verdict) {
    statements.push(db.prepare(`INSERT INTO language_feedback (job_id, verdict, corrected_status, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET verdict = excluded.verdict, corrected_status = excluded.corrected_status,
      reason = excluded.reason, updated_at = excluded.updated_at`)
      .bind(id, feedback.verdict, feedback.correctedStatus, feedback.reason, now));
  } else if (hasLanguageFeedback) {
    statements.push(db.prepare('DELETE FROM language_feedback WHERE job_id = ?').bind(id));
  }
  await db.batch(statements);
  return NextResponse.json({ ok: true, feedback });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await context.params;
  const { db } = bindings();
  await db.batch([
    db.prepare('DELETE FROM language_feedback WHERE job_id = ?').bind(id),
    db.prepare('DELETE FROM jobs WHERE id = ?').bind(id),
  ]);
  return NextResponse.json({ ok: true });
}
