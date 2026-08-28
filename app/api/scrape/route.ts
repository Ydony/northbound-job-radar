import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { analyzeLanguage, scoreFitAcrossCvs } from '@/lib/analysis';
import { descriptionMatchesRoles, jobSourceAdapters, REQUEST_DELAY_MS, sourceStatusForAvailability } from '@/lib/job-adapters';
import { canonicalJobUrl, isGloballyStableSourceJobId, sourceInfoForUrl, sourceJobIdFromUrl } from '@/lib/job-identity';
import { delay, stripHtml } from '@/lib/jobsch';
import { roleForSlot, searchTermsForProfiles } from '@/lib/criteria';
import { criteriaFromRow, upsertJob, type CriteriaRow, type SearchRoleRow } from '@/lib/server-data';
import type { CvSlot, JobRecord, SearchRun, SearchRunSource } from '@/lib/types';

const MAX_NEW_PER_SOURCE = 4;

interface KnownIdentity {
  source_key: string;
  source_job_id: string;
  canonical_url: string;
}

function isKnownUrl(url: string, known: KnownIdentity[]) {
  const canonicalUrl = canonicalJobUrl(url);
  const source = sourceInfoForUrl(canonicalUrl);
  const sourceJobId = sourceJobIdFromUrl(canonicalUrl);
  return known.some((entry) => entry.canonical_url === canonicalUrl
    || (Boolean(sourceJobId) && entry.source_job_id === sourceJobId
      && (entry.source_key === source.key || isGloballyStableSourceJobId(sourceJobId))));
}

function runSourceRow(runId: string, source: SearchRunSource) {
  return {
    statement: `INSERT INTO search_run_sources (run_id, source_key, source_name, country, status, roles_searched,
      found_count, known_count, new_count, imported_count, duplicate_count, skipped_count, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [runId, source.sourceKey, source.sourceName, source.country, source.status,
      JSON.stringify(source.rolesSearched), source.foundCount, source.knownCount, source.newCount,
      source.importedCount, source.duplicateCount, source.skippedCount, source.message],
  };
}

export async function POST() {
  await ensureSchema();
  const { db } = bindings();
  const [cvRows, criteriaRow, roleRows] = await Promise.all([
    db.prepare('SELECT slot, cv_text, derived_role FROM cvs').all<{ slot: CvSlot; cv_text: string; derived_role: string }>(),
    db.prepare('SELECT * FROM search_settings WHERE id = ?').bind('default').first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles ORDER BY position').all<SearchRoleRow>(),
  ]);
  if (!cvRows.results.length) return NextResponse.json({ error: 'Upload at least one CV first.' }, { status: 400 });

  const criteria = criteriaFromRow(criteriaRow, roleRows.results);
  const searchTerms = searchTermsForProfiles(cvRows.results.map((row) => ({
    slot: row.slot,
    derivedRole: row.derived_role,
  })), criteria);
  if (!searchTerms.length) {
    return NextResponse.json({ error: 'Add at least one role keyword or use a CV with a detectable target role.' }, { status: 400 });
  }

  const cvs = cvRows.results.map((row) => ({
    slot: row.slot,
    cvText: row.cv_text,
    derivedRole: roleForSlot(row.slot, row.derived_role, criteria),
  }));
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await db.prepare('INSERT INTO search_runs (id, status, started_at, completed_at) VALUES (?, ?, ?, ?)')
    .bind(runId, 'partial', startedAt, '').run();

  const [jobIdentities, dismissedIdentities] = await Promise.all([
    db.prepare('SELECT source_key, source_job_id, canonical_url FROM jobs').all<KnownIdentity>(),
    db.prepare('SELECT source_key, source_job_id, canonical_url FROM dismissed_jobs').all<KnownIdentity>(),
  ]);
  const known = [...jobIdentities.results, ...dismissedIdentities.results];

  const searchResults = await Promise.all(jobSourceAdapters.map(async (adapter) => {
    if (adapter.availability !== 'enabled' || !adapter.search) {
      return { adapter, candidates: [] as string[], error: '' };
    }
    try {
      const candidates = [...new Set((await adapter.search(searchTerms, criteria.location)).map(canonicalJobUrl))];
      return { adapter, candidates, error: '' };
    } catch (error) {
      return { adapter, candidates: [] as string[], error: error instanceof Error ? error.message : 'Source request failed.' };
    }
  }));

  const addedById = new Map<string, JobRecord>();
  const sourceReports: SearchRunSource[] = [];

  for (const result of searchResults) {
    const { adapter, candidates, error } = result;
    if (adapter.availability !== 'enabled') {
      sourceReports.push({
        sourceKey: adapter.key,
        sourceName: adapter.name,
        country: adapter.country,
        status: sourceStatusForAvailability(adapter.availability),
        rolesSearched: [],
        foundCount: 0,
        knownCount: 0,
        newCount: 0,
        importedCount: 0,
        duplicateCount: 0,
        skippedCount: 0,
        message: adapter.availabilityMessage,
      });
      continue;
    }
    if (error || !adapter.fetchDetail) {
      sourceReports.push({
        sourceKey: adapter.key,
        sourceName: adapter.name,
        country: adapter.country,
        status: 'failed',
        rolesSearched: searchTerms,
        foundCount: 0,
        knownCount: 0,
        newCount: 0,
        importedCount: 0,
        duplicateCount: 0,
        skippedCount: 0,
        message: error || 'The source has no detail parser.',
      });
      continue;
    }

    const knownCount = candidates.filter((url) => isKnownUrl(url, known)).length;
    const newCandidates = candidates.filter((url) => !isKnownUrl(url, known));
    const attempted = newCandidates.slice(0, MAX_NEW_PER_SOURCE);
    let importedCount = 0;
    let duplicateCount = 0;
    let skippedCount = newCandidates.length - attempted.length;

    for (const [index, url] of attempted.entries()) {
      if (index > 0) await delay(REQUEST_DELAY_MS);
      const parsed = await adapter.fetchDetail(url);
      if (!parsed) {
        skippedCount += 1;
        continue;
      }
      const description = stripHtml(parsed.descriptionHtml);
      const parsedCountry = sourceInfoForUrl(parsed.sourceUrl, parsed.location).country;
      if (description.length < 160 || parsedCountry !== adapter.country || !descriptionMatchesRoles(parsed, searchTerms)) {
        skippedCount += 1;
        continue;
      }
      const language = analyzeLanguage(description);
      const fit = scoreFitAcrossCvs(description, parsed.title, cvs);
      const stored = await upsertJob(db, {
        sourceUrl: parsed.sourceUrl,
        title: parsed.title,
        company: parsed.company,
        location: parsed.location,
        description,
        postedAt: parsed.postedAt,
        languageStatus: language.status,
        languageSummary: language.summary,
        languageSignals: language.signals,
        ...fit,
      });
      known.push({
        source_key: stored.job.sourceKey,
        source_job_id: stored.job.sourceJobId,
        canonical_url: stored.job.canonicalUrl,
      });
      if (stored.wasKnown || stored.wasDuplicate) {
        duplicateCount += 1;
      } else {
        importedCount += 1;
        addedById.set(stored.job.id, stored.job);
      }
    }

    sourceReports.push({
      sourceKey: adapter.key,
      sourceName: adapter.name,
      country: adapter.country,
      status: skippedCount ? 'partial' : 'complete',
      rolesSearched: searchTerms,
      foundCount: candidates.length,
      knownCount,
      newCount: newCandidates.length,
      importedCount,
      duplicateCount,
      skippedCount,
      message: skippedCount
        ? `${adapter.availabilityMessage} ${skippedCount} new candidate${skippedCount === 1 ? '' : 's'} were deferred or could not be parsed.`
        : adapter.availabilityMessage,
    });
  }

  const enabledReports = sourceReports.filter((source) => jobSourceAdapters
    .find((adapter) => adapter.key === source.sourceKey)?.availability === 'enabled');
  const overallStatus: SearchRun['status'] = enabledReports.every((source) => source.status === 'failed')
    ? 'failed'
    : sourceReports.some((source) => source.status !== 'complete')
      ? 'partial'
      : 'complete';
  const completedAt = new Date().toISOString();
  const statements = sourceReports.map((source) => {
    const row = runSourceRow(runId, source);
    return db.prepare(row.statement).bind(...row.bindings);
  });
  statements.push(db.prepare('UPDATE search_runs SET status = ?, completed_at = ? WHERE id = ?')
    .bind(overallStatus, completedAt, runId));
  await db.batch(statements);

  const run: SearchRun = { id: runId, status: overallStatus, startedAt, completedAt, sources: sourceReports };
  const added = [...addedById.values()];
  return NextResponse.json({
    added,
    run,
    scanned: sourceReports.reduce((sum, source) => sum + source.foundCount, 0),
    alreadyKnown: sourceReports.reduce((sum, source) => sum + source.knownCount, 0),
  });
}
