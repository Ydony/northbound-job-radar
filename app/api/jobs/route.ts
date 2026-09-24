import { ensureSchema } from '@/db/runtime';
import { removeUserVacancyState } from '@/lib/catalogue';
import { requireSession } from '@/lib/guard';
import { analyzeLanguage } from '@/lib/analysis';
import { adminOnlySourceKeys, isHiddenSourceForRole } from '@/lib/job-adapters';
import { audienceExclusionClause } from '@/lib/server-data';
import { isSafeManualJobUrl } from '@/lib/job-sources';
import { canonicalJobUrl, sourceInfoForUrl } from '@/lib/job-identity';
import { upsertJob } from '@/lib/server-data';
import { isIndeedUrl, languageForIndeed } from '@/lib/indeed/normalize';

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

  if (!isSafeManualJobUrl(sourceUrl)) return Response.json({ error: 'Paste a valid public HTTPS job-ad URL.' }, { status: 400 });
  // Administrator-only sources cannot be imported into an ordinary account: the row would be
  // stored under a hidden key and vanish from every response, which is confusing, and accepting
  // it would give a non-admin a write path into an audience they must never read. The refusal
  // names no source, exactly like the Indeed-only refusal it generalizes.
  if (isHiddenSourceForRole(sourceInfoForUrl(sourceUrl).key, sourceUrl, user.role === 'admin')) {
    return Response.json({ error: 'This source is not available.' }, { status: 403 });
  }
  if (!title) return Response.json({ error: 'Add the job title.' }, { status: 400 });
  if (description.length < 160) return Response.json({ error: 'Paste the full job advertisement so the language gate has enough evidence.' }, { status: 400 });

  const language = isIndeedUrl(sourceUrl) ? languageForIndeed(description, title) : analyzeLanguage(description, title);
  const result = await upsertJob(db, user.id, {
    sourceUrl, title, company, location, description,
    languageStatus: language.status, languageSummary: language.summary, languageSignals: language.signals,
    postedAt,
  });
  return Response.json({ job: result.job, duplicate: result.wasKnown || result.wasDuplicate, dismissed: result.wasDismissed });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  // Deletion targets only rows this audience may see, so counts and side effects disclose
  // nothing about hidden sources. Historical admin-only rows survive an ordinary account's
  // "delete everything", exactly as Indeed rows already did; only an administrator removes them.
  const hiddenKeys = user.role === 'admin' ? [] : [...adminOnlySourceKeys()];
  const audience = audienceExclusionClause('', hiddenKeys);
  const visible = audience.clause;
  const hiddenParams = audience.params;
  const all = body.all === true;
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 250)
    : [];
  if (!all && !ids.length) return Response.json({ error: 'Choose at least one job to delete.' }, { status: 400 });

  if (all) {
    // Collected first so catalogue state is forgotten exactly for the rows this
    // delete actually removes — the audience guard below may spare some rows.
    const doomed = await db.prepare(`SELECT id FROM jobs WHERE user_id = ?${visible}`)
      .bind(user.id).all<{ id: string }>();
    const results = await db.batch([
      db.prepare(`DELETE FROM language_feedback WHERE user_id = ? AND job_id IN (SELECT id FROM jobs WHERE user_id = ?${visible})`).bind(user.id, user.id, ...hiddenParams),
      db.prepare(`DELETE FROM jobs WHERE user_id = ?${visible}`).bind(user.id, ...hiddenParams),
    ]);
    // INT-04 (#163): forget this account's catalogue state for the deleted rows.
    await removeUserVacancyState(db, user.id, doomed.results.map((row) => row.id));
    return Response.json({ ok: true, deletedJobs: results[1].meta.changes ?? 0 });
  }

  const placeholders = ids.map(() => '?').join(',');
  const results = await db.batch([
    db.prepare(`DELETE FROM language_feedback WHERE user_id = ? AND job_id IN (SELECT id FROM jobs WHERE user_id = ? AND id IN (${placeholders})${visible})`).bind(user.id, user.id, ...ids, ...hiddenParams),
    db.prepare(`DELETE FROM jobs WHERE user_id = ? AND id IN (${placeholders})${visible}`).bind(user.id, ...ids, ...hiddenParams),
  ]);
  await removeUserVacancyState(db, user.id, ids);
  return Response.json({ ok: true, deletedJobs: results[1].meta.changes ?? 0 });
}
