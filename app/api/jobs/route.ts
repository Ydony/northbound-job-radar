import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { analyzeLanguage } from '@/lib/analysis';
import { isHiddenSourceForRole } from '@/lib/job-adapters';
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
