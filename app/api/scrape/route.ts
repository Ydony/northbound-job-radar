import { NextResponse } from 'next/server';
import { aggregatorCredentials, authSecrets, ensureSchema } from '@/db/runtime';
import { rateLimit, requireSession } from '@/lib/guard';
import { analyzeLanguage, analyzeStructuredLanguages, scoreFitAcrossCvs, type LanguageResult } from '@/lib/analysis';
import { descriptionMatchesRoles, jobSourceAdapters, REQUEST_DELAY_MS, sourceStatusForAvailability,
  type SearchMode } from '@/lib/job-adapters';
import { canonicalJobUrl, isGloballyStableSourceJobId, sourceInfoForUrl, sourceJobIdFromUrl } from '@/lib/job-identity';
import { delay, stripHtml, type ParsedJob } from '@/lib/jobsch';
import { roleForSlot, searchTermsForProfiles } from '@/lib/criteria';
import { criteriaFromRow, upsertJob, type CriteriaRow, type SearchRoleRow } from '@/lib/server-data';
import type { CvSlot, JobRecord, SearchRun, SearchRunSource } from '@/lib/types';

/** Page-fetching sources cost one request per job, so they stay tightly capped. */
const MAX_NEW_PER_SOURCE = 4;
/** Bulk API sources return whole advertisements in the search response, so a far larger batch costs only a few requests. */
const MAX_NEW_PER_BULK_SOURCE = 200;

/** Employer-declared requirements are more reliable than prose, so they win when a source publishes them. */
function languageForParsedJob(parsed: ParsedJob, description: string): LanguageResult {
  const skills = (parsed as { languageSkills?: Parameters<typeof analyzeStructuredLanguages>[0] }).languageSkills;
  const structured = skills && analyzeStructuredLanguages(skills);
  // A language in the title still blocks: employer-declared skill lists are occasionally left
  // empty on an advertisement whose own headline names the language it needs.
  if (structured && structured.status === 'blocked') return structured;
  const fromText = analyzeLanguage(description, parsed.title);
  if (fromText.status === 'blocked') return fromText;
  return structured || fromText;
}

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

export async function POST(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  // A search fans out to every source, so it is capped per account to protect third-party quotas.
  const limited = rateLimit(`scrape:${user.id}`, 6, 10 * 60_000);
  if (limited) return limited;

  // 'authorized' runs only official or keyed APIs. 'all' additionally reads public web pages, which
  // is the mode that carries terms risk, so it is restricted to administrators and is not merely
  // hidden in the UI - a non-admin calling this directly is refused.
  const body = await request.json().catch(() => ({})) as { mode?: SearchMode };
  const requestedAll = body.mode === 'all';
  if (requestedAll && user.role !== 'admin') {
    return NextResponse.json({ error: 'That search mode is not available on this account.' }, { status: 403 });
  }
  // Restricted sources need the VPN, and the button label is not evidence of one. Only the
  // launcher that verifies a full tunnel route sets this, so without it the mode is refused.
  if (requestedAll && !authSecrets().vpnEnforced) {
    return NextResponse.json({
      error: 'Start the app with "npm run dev:private" first. That checks for a full VPN route before these sources will run.',
    }, { status: 409 });
  }
  const mode: SearchMode = requestedAll ? 'all' : 'authorized';
  // Everyone gets the authorized APIs and the grey-area sources, whose robots.txt permits the
  // paths read. Only the explicit VPN mode adds the sources that prohibit automated access.
  const activeAdapters = jobSourceAdapters.filter((adapter) => mode === 'all' || adapter.access !== 'restricted');
  const [cvRows, criteriaRow, roleRows] = await Promise.all([
    db.prepare('SELECT slot, cv_text, derived_role FROM cvs WHERE user_id = ?').bind(user.id).all<{ slot: CvSlot; cv_text: string; derived_role: string }>(),
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles WHERE user_id = ? ORDER BY position').bind(user.id).all<SearchRoleRow>(),
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
  await db.prepare('INSERT INTO search_runs (id, user_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)')
    .bind(runId, user.id, 'partial', startedAt, '').run();

  const [jobIdentities, dismissedIdentities] = await Promise.all([
    db.prepare('SELECT source_key, source_job_id, canonical_url FROM jobs WHERE user_id = ?').bind(user.id).all<KnownIdentity>(),
    db.prepare('SELECT source_key, source_job_id, canonical_url FROM dismissed_jobs WHERE user_id = ?').bind(user.id).all<KnownIdentity>(),
  ]);
  const known = [...jobIdentities.results, ...dismissedIdentities.results];

  const credentials = aggregatorCredentials();
  const searchResults = await Promise.all(activeAdapters.map(async (adapter) => {
    const empty = { adapter, candidates: [] as string[], bulk: [] as ParsedJob[], error: '', missingCredentials: false };
    if (adapter.availability !== 'enabled') return empty;
    if (adapter.hasCredentials && !adapter.hasCredentials(credentials)) {
      return { ...empty, missingCredentials: true };
    }
    try {
      if (adapter.searchDetailed) {
        const bulk = await adapter.searchDetailed(searchTerms, criteria.location, credentials);
        return { ...empty, bulk, candidates: bulk.map((job) => canonicalJobUrl(job.sourceUrl)) };
      }
      if (!adapter.search) return empty;
      const candidates = [...new Set((await adapter.search(searchTerms, criteria.location)).map(canonicalJobUrl))];
      return { ...empty, candidates };
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : 'Source request failed.' };
    }
  }));

  const addedById = new Map<string, JobRecord>();
  const sourceReports: SearchRunSource[] = [];

  for (const result of searchResults) {
    const { adapter, candidates, bulk, error, missingCredentials } = result;
    if (missingCredentials) {
      sourceReports.push({
        sourceKey: adapter.key,
        sourceName: adapter.name,
        country: adapter.country,
        status: 'unavailable',
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
    const isBulk = Boolean(adapter.searchDetailed);
    if (error || (!isBulk && !adapter.fetchDetail)) {
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

    const bulkByUrl = new Map(bulk.map((job) => [canonicalJobUrl(job.sourceUrl), job]));
    const knownCount = candidates.filter((url) => isKnownUrl(url, known)).length;
    const newCandidates = candidates.filter((url) => !isKnownUrl(url, known));
    const attempted = newCandidates.slice(0, isBulk ? MAX_NEW_PER_BULK_SOURCE : MAX_NEW_PER_SOURCE);
    let importedCount = 0;
    let duplicateCount = 0;
    // Deferring candidates because of the per-run cap is normal; only real parse/filter failures make a run partial.
    const deferredCount = newCandidates.length - attempted.length;
    let failedCount = 0;

    for (const [index, url] of attempted.entries()) {
      let parsed: ParsedJob | null;
      if (isBulk) {
        parsed = bulkByUrl.get(url) ?? null;
      } else {
        if (index > 0) await delay(REQUEST_DELAY_MS);
        parsed = await adapter.fetchDetail!(url);
      }
      if (!parsed) {
        failedCount += 1;
        continue;
      }
      const description = stripHtml(parsed.descriptionHtml);
      const parsedCountry = sourceInfoForUrl(parsed.sourceUrl, parsed.location).country;
      if (description.length < 160 || parsedCountry !== adapter.country || !descriptionMatchesRoles(parsed, searchTerms)) {
        failedCount += 1;
        continue;
      }
      const language = languageForParsedJob(parsed, description);
      const fit = scoreFitAcrossCvs(description, parsed.title, cvs);
      const stored = await upsertJob(db, user.id, {
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
      status: failedCount ? 'partial' : 'complete',
      rolesSearched: searchTerms,
      foundCount: candidates.length,
      knownCount,
      newCount: newCandidates.length,
      importedCount,
      duplicateCount,
      skippedCount: deferredCount + failedCount,
      message: [
        adapter.availabilityMessage,
        deferredCount ? `${deferredCount} further new listing${deferredCount === 1 ? '' : 's'} deferred to the next run by the per-run cap.` : '',
        failedCount ? `${failedCount} listing${failedCount === 1 ? '' : 's'} could not be parsed or did not match the search.` : '',
      ].filter(Boolean).join(' '),
    });
  }

  const enabledReports = sourceReports.filter((source) => activeAdapters
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
  statements.push(db.prepare('UPDATE search_runs SET status = ?, completed_at = ? WHERE id = ? AND user_id = ?')
    .bind(overallStatus, completedAt, runId, user.id));
  await db.batch(statements);

  const visibleSources = user.role === 'admin'
    ? sourceReports
    : sourceReports.filter((source) => jobSourceAdapters
      .find((adapter) => adapter.key === source.sourceKey)?.access !== 'restricted');
  const run: SearchRun = { id: runId, status: overallStatus, startedAt, completedAt, sources: visibleSources };
  const added = [...addedById.values()];
  return NextResponse.json({
    added,
    run,
    scanned: sourceReports.reduce((sum, source) => sum + source.foundCount, 0),
    alreadyKnown: sourceReports.reduce((sum, source) => sum + source.knownCount, 0),
  });
}
