import { NextResponse } from 'next/server';
import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';

interface FeedbackRow {
  job_id: string;
  verdict: string;
  corrected_status: string;
  reason: string;
  updated_at: string;
  detected_status: string;
  detected_summary: string;
  detected_signals: string;
  evidence: string;
  title: string;
  company: string;
  location: string;
  source_name: string;
}

/**
 * Every language correction this account has made, with what the detector said at the time.
 *
 * This is the raw material for improving the gate: a correction alone says nothing, but the pair
 * — decided X, person said Y, here is the wording — is exactly what a regression case needs. The
 * disagreements are grouped so the common failure shapes are visible rather than having to be
 * spotted by eye.
 */
export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;

  const rows = await db.prepare(`SELECT f.job_id, f.verdict, f.corrected_status, f.reason, f.updated_at,
      f.detected_status, f.detected_summary, f.detected_signals, f.evidence,
      j.title, j.company, j.location, j.source_name
    FROM language_feedback f JOIN jobs j ON j.id = f.job_id
    WHERE f.user_id = ? ORDER BY f.updated_at DESC LIMIT 500`)
    .bind(user.id).all<FeedbackRow>();

  const entries = rows.results.map((row) => ({
    jobId: row.job_id,
    title: row.title,
    company: row.company,
    location: row.location,
    source: row.source_name,
    verdict: row.verdict,
    detected: row.detected_status,
    corrected: row.corrected_status,
    reason: row.reason,
    detectedSummary: row.detected_summary,
    detectedSignals: (() => {
      try { return JSON.parse(row.detected_signals) as string[]; } catch { return []; }
    })(),
    evidence: row.evidence,
    at: row.updated_at,
  }));

  // A disagreement is a correction that names a different status than the detector chose. Those
  // are the only ones that can teach the gate anything; "accurate" marks only confirm it.
  const disagreements = entries.filter((entry) => entry.corrected && entry.corrected !== entry.detected);
  const byShape = new Map<string, number>();
  for (const entry of disagreements) {
    const shape = `${entry.detected || 'unknown'} -> ${entry.corrected}`;
    byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
  }

  return NextResponse.json({
    total: entries.length,
    confirmed: entries.filter((entry) => entry.verdict === 'correct').length,
    disagreements: disagreements.length,
    // e.g. { "pass -> blocked": 3 } means the gate said English was enough three times when it was not.
    shapes: Object.fromEntries([...byShape.entries()].sort((a, b) => b[1] - a[1])),
    entries,
  });
}
