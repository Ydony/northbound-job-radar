import { NextResponse } from 'next/server';
import { aggregatorCredentials, authSecrets, ensureSchema } from '@/db/runtime';
import { rateLimit, requireSession } from '@/lib/guard';
import { CV_MATCHING_ENABLED } from '@/lib/features';
import { analyzeLanguage, analyzeStructuredLanguages, scoreFitAcrossCvs, type LanguageResult } from '@/lib/analysis';
import { adminOnlySourceKeys, descriptionMatchesRoles, jobSourceAdapters, REQUEST_DELAY_MS,
  sourceStatusForAvailability,
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

type ProgressEvent = { type: 'progress'; label: string; percent: number };
type Report = (event: ProgressEvent) => void;

/**
 * Streams the search as newline-delimited JSON instead of answering once at the end.
 *
 * The last line is the result the caller wants; everything before it is progress. A client that
 * only reads the final line still works, which is what keeps the scripted verifiers unchanged.
 *
 * Progress is flushed as it is produced. Buffering it would defeat the point entirely — the whole
 * reason this exists is that a search takes tens of seconds and a silent button looks broken.
 */
export async function POST(request: Request) {
  const encoder = new TextEncoder();
  const queued: string[] = [];
  let flush: (() => void) | null = null;

  // Start the work immediately, collecting progress until we know whether there is anything to
  // stream. A refusal happens before any of it - no session, rate limited, no role keywords - and
  // those deserve their real status code rather than a 200 carrying an error in its last line.
  const work = runSearch(request, (event) => {
    queued.push(`${JSON.stringify(event)}
`);
    flush?.();
  });

  const firstSignal = new Promise<void>((resolve) => { flush = resolve; });
  const settled = await Promise.race([
    work.then((outcome) => outcome),
    firstSignal.then(() => null),
  ]);
  if (settled && settled.kind === 'refused') return settled.response;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (line: string) => {
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          // The tab was closed. The search is worth finishing - anything it finds is already
          // being stored - so a dead reader is not a reason to stop.
        }
      };
      // Anything produced while we were deciding whether to stream at all.
      for (const line of queued.splice(0)) write(line);
      flush = () => { for (const line of queued.splice(0)) write(line); };

      const outcome = await work;
      flush();
      write(`${JSON.stringify(outcome.kind === 'done' ? outcome.body : { error: 'Search failed.' })}
`);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Nothing between here and the browser may hold events back and deliver them together.
      'x-accel-buffering': 'no',
    },
  });
}

type SearchOutcome =
  /** Refused before any work started; sent as an ordinary response with its real status code. */
  | { kind: 'refused'; response: NextResponse }
  /** Completed; `body` becomes the last line of the stream. */
  | { kind: 'done'; body: unknown };

async function runSearch(request: Request, report: Report): Promise<SearchOutcome> {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return { kind: 'refused', response };
  const { db, user } = session;
  // A search fans out to every source, so it is capped per account to protect third-party quotas.
  const limited = rateLimit(`scrape:${user.id}`, 6, 10 * 60_000);
  if (limited) return { kind: 'refused', response: limited };

  // 'authorized' runs only official or keyed APIs. 'all' additionally reads public web pages, which
  // is the mode that carries terms risk, so it is restricted to administrators and is not merely
  // hidden in the UI - a non-admin calling this directly is refused.
  const body = await request.json().catch(() => ({})) as { mode?: SearchMode };
  const requestedAll = body.mode === 'all';
  if (requestedAll && user.role !== 'admin') {
    return { kind: 'refused', response: NextResponse.json({ error: 'That search mode is not available on this account.' }, { status: 403 }) };
  }
  // Restricted sources need the VPN, and the button label is not evidence of one. Only the
  // launcher that verifies a full tunnel route sets this, so without it the mode is refused.
  if (requestedAll && !authSecrets().vpnEnforced) {
    return { kind: 'refused', response: NextResponse.json({
      error: 'Start the app with "npm run dev:private" first. That checks for a full VPN route before these sources will run.',
    }, { status: 409 }) };
  }
  const mode: SearchMode = requestedAll ? 'all' : 'authorized';
  // Everyone gets the authorized APIs and the grey-area sources, whose robots.txt permits the
  // paths read. Only the explicit VPN mode adds the sources that prohibit automated access.
  // Two separate rules, and they are not the same rule. `restricted` means page-fetching that needs
  // a verified VPN, so it is gated on the mode. `adminOnly` means a source the owner may use but
  // that is not offered to anyone else - Careerjet is licensed to one declared IP, IamExpat is read
  // from public pages - so it is gated on the account, in every mode.
  const hiddenForAccount = user.role === 'admin' ? new Set<string>() : adminOnlySourceKeys();
  const activeAdapters = jobSourceAdapters.filter((adapter) =>
    (mode === 'all' || adapter.access !== 'restricted') && !hiddenForAccount.has(adapter.key));
  const [cvRows, criteriaRow, roleRows] = await Promise.all([
    db.prepare('SELECT slot, cv_text, derived_role FROM cvs WHERE user_id = ?').bind(user.id).all<{ slot: CvSlot; cv_text: string; derived_role: string }>(),
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles WHERE user_id = ? ORDER BY position').bind(user.id).all<SearchRoleRow>(),
  ]);
  // A CV is no longer a precondition for searching. It used to be, because search terms were
  // derived from one, which made an optional feature block the product's only job. Roles come from
  // the role keywords now; a CV, when the feature is switched back on, only adds to them.
  if (CV_MATCHING_ENABLED && !cvRows.results.length) {
    return { kind: 'refused', response: NextResponse.json({ error: 'Upload at least one CV first.' }, { status: 400 }) };
  }

  const criteria = criteriaFromRow(criteriaRow, roleRows.results);
  const searchTerms = searchTermsForProfiles(cvRows.results.map((row) => ({
    slot: row.slot,
    derivedRole: row.derived_role,
  })), criteria);
  if (!searchTerms.length) {
    return { kind: 'refused', response: NextResponse.json({
      error: CV_MATCHING_ENABLED
        ? 'Add at least one role keyword or use a CV with a detectable target role.'
        : 'Add at least one role keyword in Search settings, then search again.',
    }, { status: 400 }) };
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

  /**
   * Progress is reported as it happens rather than estimated.
   *
   * A search takes tens of seconds — it contacts every configured source and then screens what
   * comes back — and a button that sits there looking broken is the most common reason someone
   * presses it twice. Every event below corresponds to work that has actually finished, so the
   * percentage cannot run ahead of reality or stall at 99.
   *
   * Two phases, weighted by how long each really takes. Fetching is the slow one: it waits on
   * other people's servers. Screening is local and quick, so it gets the last quarter of the bar.
   */
  const FETCH_SHARE = 0.75;
  const totalSteps = activeAdapters.length || 1;
  let fetched = 0;
  let screened = 0;
  const progress = (label: string) => report({
    type: 'progress',
    label,
    percent: Math.min(99, Math.round(
      ((fetched / totalSteps) * FETCH_SHARE + (screened / totalSteps) * (1 - FETCH_SHARE)) * 100,
    )),
  });

  progress(`Contacting ${activeAdapters.length} source${activeAdapters.length === 1 ? '' : 's'}…`);
  const searchResults = await Promise.all(activeAdapters.map(async (adapter) => {
    const empty = { adapter, candidates: [] as string[], bulk: [] as ParsedJob[], error: '', missingCredentials: false };
    // Counted whichever way this ends, including skipped and failed sources: a bar that only
    // advances on success stops moving exactly when something has gone wrong.
    const done = <T>(value: T, note: string) => {
      fetched += 1;
      progress(`${adapter.name}: ${note}`);
      return value;
    };
    if (adapter.availability !== 'enabled') return done(empty, 'not available');
    if (adapter.hasCredentials && !adapter.hasCredentials(credentials)) {
      return done({ ...empty, missingCredentials: true }, 'no credentials');
    }
    try {
      if (adapter.searchDetailed) {
        const bulk = await adapter.searchDetailed(searchTerms, criteria.location, credentials);
        return done(
          { ...empty, bulk, candidates: bulk.map((job) => canonicalJobUrl(job.sourceUrl)) },
          `${bulk.length} advertisement${bulk.length === 1 ? '' : 's'}`,
        );
      }
      if (!adapter.search) return done(empty, 'nothing to search');
      const candidates = [...new Set((await adapter.search(searchTerms, criteria.location)).map(canonicalJobUrl))];
      return done({ ...empty, candidates }, `${candidates.length} listing${candidates.length === 1 ? '' : 's'}`);
    } catch (error) {
      return done(
        { ...empty, error: error instanceof Error ? error.message : 'Source request failed.' },
        'failed',
      );
    }
  }));

  const addedById = new Map<string, JobRecord>();
  const sourceReports: SearchRunSource[] = [];

  for (const result of searchResults) {
    const { adapter, candidates, bulk, error, missingCredentials } = result;
    screened += 1;
    progress(`Screening ${adapter.name}…`);
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
    : sourceReports.filter((source) => !hiddenForAccount.has(source.sourceKey));
  const run: SearchRun = { id: runId, status: overallStatus, startedAt, completedAt, sources: visibleSources };
  const added = [...addedById.values()];
  return { kind: 'done', body: {
    added,
    run,
    scanned: sourceReports.reduce((sum, source) => sum + source.foundCount, 0),
    alreadyKnown: sourceReports.reduce((sum, source) => sum + source.knownCount, 0),
  } };
}
