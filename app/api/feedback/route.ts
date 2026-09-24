import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { adminOnlySourceKeys } from '@/lib/job-adapters';
import { audienceExclusionClause } from '@/lib/server-data';

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

  // An export is a read of the same rows /api/state hides, so it needs the same two guards.
  // Without them an account demoted from administrator kept a way to read back the names, titles
  // and stored evidence of page-fetching sources through its own old corrections — which ordinary
  // accounts must never learn exist. Excluded in SQL and before the LIMIT, like /api/state, so the
  // rows are never fetched rather than dropped afterwards. The predicate is the shared
  // audienceExclusionClause, derived from the registry-driven adminOnlySourceKeys, so this
  // export cannot drift away from what the jobs and runs paths hide.
  const hiddenSourceKeys = user.role === 'admin' ? [] : [...adminOnlySourceKeys()];
  const audience = audienceExclusionClause('j', hiddenSourceKeys);

  const rows = await db.prepare(`SELECT f.job_id, f.verdict, f.corrected_status, f.reason, f.updated_at,
      f.detected_status, f.detected_summary, f.detected_signals, f.evidence,
      j.title, j.company, j.location, j.source_name
    FROM language_feedback f JOIN jobs j ON j.id = f.job_id AND j.user_id = f.user_id
    WHERE f.user_id = ?${audience.clause} ORDER BY f.updated_at DESC LIMIT 500`)
    .bind(user.id, ...audience.params).all<FeedbackRow>();

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

  return Response.json({
    total: entries.length,
    confirmed: entries.filter((entry) => entry.verdict === 'correct').length,
    disagreements: disagreements.length,
    // e.g. { "pass -> blocked": 3 } means the gate said English was enough three times when it was not.
    shapes: Object.fromEntries([...byShape.entries()].sort((a, b) => b[1] - a[1])),
    entries,
  });
}
