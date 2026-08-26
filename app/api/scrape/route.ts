import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { analyzeLanguage, scoreFitAcrossCvs } from '@/lib/analysis';
import { MAX_NEW_JOBS_PER_RUN, REQUEST_DELAY_MS, delay, fetchJobDetail, fetchSearchResultIds, stripHtml } from '@/lib/jobsch';
import { upsertJob } from '@/lib/server-data';
import type { JobRecord } from '@/lib/types';

export async function POST() {
  await ensureSchema();
  const { db } = bindings();
  const cvRows = await db.prepare('SELECT slot, cv_text, derived_role FROM cvs')
    .all<{ slot: 'a' | 'b'; cv_text: string; derived_role: string }>();
  if (!cvRows.results.length) return NextResponse.json({ error: 'Upload at least one CV first.' }, { status: 400 });
  const cvs = cvRows.results.map((row) => ({ slot: row.slot, cvText: row.cv_text, derivedRole: row.derived_role }));

  const searchTerms = [...new Set(cvs.map((cv) => cv.derivedRole).filter(Boolean))];
  if (!searchTerms.length) return NextResponse.json({ error: 'Could not detect a role from your CV(s). Try a CV with a clearer job title, or paste ads manually.' }, { status: 400 });

  let candidateUrls: string[];
  try {
    const found = new Set<string>();
    for (const [index, term] of searchTerms.entries()) {
      if (index > 0) await delay(REQUEST_DELAY_MS);
      for (const url of await fetchSearchResultIds(term)) found.add(url);
    }
    candidateUrls = [...found];
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not reach jobs.ch.' }, { status: 502 });
  }
  if (!candidateUrls.length) return NextResponse.json({ added: [], scanned: 0, alreadyKnown: 0 });

  const placeholders = candidateUrls.map(() => '?').join(',');
  const known = await db.prepare(`SELECT source_url FROM jobs WHERE source_url IN (${placeholders})`)
    .bind(...candidateUrls).all<{ source_url: string }>();
  const knownUrls = new Set(known.results.map((row) => row.source_url));
  const newUrls = candidateUrls.filter((url) => !knownUrls.has(url)).slice(0, MAX_NEW_JOBS_PER_RUN);

  const added: JobRecord[] = [];
  for (const [index, url] of newUrls.entries()) {
    if (index > 0) await delay(REQUEST_DELAY_MS);
    const parsed = await fetchJobDetail(url);
    if (!parsed) continue;
    const description = stripHtml(parsed.descriptionHtml);
    if (description.length < 160) continue;
    const language = analyzeLanguage(description);
    const fit = scoreFitAcrossCvs(description, parsed.title, cvs);
    const job = await upsertJob(db, {
      sourceUrl: parsed.sourceUrl,
      title: parsed.title,
      company: parsed.company,
      location: parsed.location,
      description,
      languageStatus: language.status,
      languageSummary: language.summary,
      languageSignals: language.signals,
      ...fit,
    });
    added.push(job);
  }

  return NextResponse.json({ added, scanned: candidateUrls.length, alreadyKnown: knownUrls.size });
}
