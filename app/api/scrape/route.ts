import { aggregatorCredentials, authSecrets, ensureSchema, indeedConfiguration } from '@/db/runtime';
import { collectIndeed, type IndeedBatchResult } from '@/lib/indeed/collection';
import { indeedSettingsFromRow } from '@/lib/indeed/settings';
import { isIndeedUrl, languageForIndeed } from '@/lib/indeed/normalize';
import { rateLimit, requireSession } from '@/lib/guard';
import { analyzeLanguage, analyzeStructuredLanguages, type LanguageResult } from '@/lib/analysis';
import { adminOnlySourceKeys, bulkJobIsRelevant, descriptionMatchesRoles, jobSourceAdapters, REQUEST_DELAY_MS,
  sourceStatusForAvailability,
  type SearchMode } from '@/lib/job-adapters';
import { canonicalJobUrl, isGloballyStableSourceJobId, sourceInfoForUrl, sourceJobIdFromUrl } from '@/lib/job-identity';
import { isSafeManualJobUrl } from '@/lib/job-sources';
import { delay, stripHtml, type ParsedJob } from '@/lib/jobsch';
import { isRejectedUrl, loadRejectedListings, rejectionRolesKey, rememberRejection,
  type RejectionReason } from '@/lib/rejected-listings';
import { matchesSearchCriteria, searchTermsForRoles } from '@/lib/criteria';
import { criteriaFromRow, upsertJob, visibleSourceReports, type CriteriaRow, type SearchRoleRow } from '@/lib/server-data';
import type { JobCountry, JobRecord, SearchRun, SearchRunSource } from '@/lib/types';

/**
 * Page-fetching sources cost one request per job, so they stay tightly capped.
 *
 * This cap is not a performance setting and is not lifted with the others. It limits automated
 * reading of sites whose terms prohibit it (jobs.ch, jobup.ch, JobScout24), and AGENTS.md is
 * explicit: "Do not raise the caps to hit a volume target."
 */
const MAX_NEW_PER_SOURCE = 4;
/**
 * Bulk API sources return whole advertisements in the search response, and their postings are
 * filtered to this search before this point (bulkJobIsRelevant), so nothing here is a request.
 *
 * Uncapped, deliberately, for now: the owner's decision on 2026-09-14 is full coverage while the
 * app runs locally, caps later. The previous ceiling of 200 would already have deferred more than
 * half of the 409 role-matching employer postings measured that day. A ceiling on database writes
 * per search belongs back here before any hosted deployment.
 */
const MAX_NEW_PER_BULK_SOURCE = Number.POSITIVE_INFINITY;

/** Employer-declared requirements are more reliable than prose, so they win when a source publishes them. */
function languageForParsedJob(parsed: ParsedJob, description: string): LanguageResult {
  if (isIndeedUrl(parsed.sourceUrl)) return languageForIndeed(description, parsed.title);
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
      found_count, known_count, new_count, imported_count, matched_count, duplicate_count, skipped_count, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [runId, source.sourceKey, source.sourceName, source.country, source.status,
      JSON.stringify(source.rolesSearched), source.foundCount, source.knownCount, source.newCount,
      source.importedCount, source.matchedCount, source.duplicateCount, source.skippedCount, source.message],
  };
}

type ProgressEvent = { type: 'progress'; label: string; percent: number; step: number; steps: number };
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
  | { kind: 'refused'; response: Response }
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
  const body = await request.json().catch(() => ({})) as { mode?: SearchMode; sourceGroup?: string };
  if (body.sourceGroup && (body.sourceGroup !== 'indeed' || user.role !== 'admin')) {
    return { kind: 'refused', response: Response.json({ error: 'That search selection is not available.' }, { status: 403 }) };
  }
  const requestedAll = body.mode === 'all';
  if (requestedAll && user.role !== 'admin') {
    return { kind: 'refused', response: Response.json({ error: 'That search mode is not available on this account.' }, { status: 403 }) };
  }
  // Restricted sources need the VPN, and the button label is not evidence of one. Only the
  // launcher that verifies a full tunnel route sets this, so without it the mode is refused.
  if (requestedAll && !authSecrets().vpnEnforced) {
    return { kind: 'refused', response: Response.json({
      error: 'Start the app with "npm run dev:private" first. That checks for a full VPN route before these sources will run.',
    }, { status: 409 }) };
  }
  const mode: SearchMode = requestedAll ? 'all' : 'authorized';
  // The no-VPN mode is eligible for authorized APIs and grey-area sources whose robots.txt permits
  // the paths read. `adminOnly` below still removes private sources from ordinary accounts. Only
  // the explicit VPN mode adds sources that prohibit automated access or previously blocked it.
  // Two separate rules, and they are not the same rule. `restricted` means page-fetching that needs
  // a verified VPN, so it is gated on the mode. `adminOnly` means a source the owner may use but
  // that is not offered to anyone else - Careerjet is licensed to one declared IP, while IamExpat
  // is read from public pages - so it is gated on the account, in every mode.
  const hiddenForAccount = user.role === 'admin' ? new Set<string>() : adminOnlySourceKeys();
  const permittedAdapters = jobSourceAdapters.filter((adapter) =>
    (mode === 'all' || adapter.access !== 'restricted') && !hiddenForAccount.has(adapter.key)
    && (!body.sourceGroup || adapter.experimentalIndeed));
  const [criteriaRow, roleRows] = await Promise.all([
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles WHERE user_id = ? ORDER BY position').bind(user.id).all<SearchRoleRow>(),
  ]);
  // Indeed place/distance are per-account (#113). A missing row reads as the previous
  // hardcoded defaults, so other sources and pre-settings accounts are untouched.
  const indeedSettingsRow = await db.prepare(
    'SELECT nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at FROM indeed_settings WHERE user_id = ?')
    .bind(user.id).first<{ nl_location: unknown; nl_radius_km: unknown; ch_location: unknown; ch_radius_km: unknown; updated_at: unknown }>()
    .catch(() => null);
  const indeedSettings = indeedSettingsFromRow(indeedSettingsRow);
  const criteria = criteriaFromRow(criteriaRow, roleRows.results);

  /**
   * Two switches decide which countries a search contacts (#72).
   *
   * This is about what gets *collected*, not what the results list shows - the country facet on
   * the dashboard is a separate thing that narrows what is already stored. Jobs already collected
   * from a country that is now off are untouched: nobody expects a search setting to delete work
   * they have saved.
   *
   * A country neither switch names is always searched, so adding a third country later cannot be
   * silently switched off by a setting written before it existed.
   */
  const countrySearched = (country: JobCountry) =>
    country === 'netherlands' ? criteria.searchNetherlands
      : country === 'switzerland' ? criteria.searchSwitzerland
        : true;
  if (!criteria.searchNetherlands && !criteria.searchSwitzerland) {
    // Refused rather than run: a search that contacts nothing looks identical to a search that
    // found nothing, and the person would have no way to tell which had happened.
    return { kind: 'refused', response: Response.json({
      error: 'Both countries are switched off in Search settings, so a search has nowhere to look.'
        + ' Switch the Netherlands or Switzerland back on, then search again.',
    }, { status: 400 }) };
  }
  const activeAdapters = permittedAdapters.filter((adapter) => countrySearched(adapter.country));
  const skippedAdapters = permittedAdapters.filter((adapter) => !countrySearched(adapter.country));

  const searchTerms = searchTermsForRoles(criteria);
  if (!searchTerms.length) {
    return { kind: 'refused', response: Response.json({
      error: 'Add at least one role keyword in Search settings, then search again.',
    }, { status: 400 }) };
  }
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await db.prepare('INSERT INTO search_runs (id, user_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)')
    .bind(runId, user.id, 'partial', startedAt, '').run();

  const [jobIdentities, dismissedIdentities, rejectedIdentities] = await Promise.all([
    db.prepare('SELECT source_key, source_job_id, canonical_url FROM jobs WHERE user_id = ?').bind(user.id).all<KnownIdentity>(),
    db.prepare('SELECT source_key, source_job_id, canonical_url FROM dismissed_jobs WHERE user_id = ?').bind(user.id).all<KnownIdentity>(),
    loadRejectedListings(db, user.id),
  ]);
  const known = [...jobIdentities.results, ...dismissedIdentities.results];
  const rejected = [...rejectedIdentities];
  // A role mismatch only counts while the searched roles are unchanged, so the key travels
  // with every check below and every row written in the detail loop.
  const rolesKey = rejectionRolesKey(searchTerms);

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
    // Sent alongside the percentage so the run bar can say "4 of 9 sources". A percentage alone
    // does not tell you whether a slow run is stuck or simply has six sources left to contact.
    step: Math.min(fetched, totalSteps),
    steps: totalSteps,
  });

  progress(`Contacting ${activeAdapters.length} source${activeAdapters.length === 1 ? '' : 's'}…`);
  let indeedBatch: ReturnType<typeof collectIndeed> | undefined;
  const searchResults = await Promise.all(activeAdapters.map(async (adapter) => {
    const empty = { adapter, candidates: [] as string[], bulk: [] as ParsedJob[], error: '', missingCredentials: false,
      indeed: undefined as IndeedBatchResult | undefined };
    // Counted whichever way this ends, including skipped and failed sources: a bar that only
    // advances on success stops moving exactly when something has gone wrong.
    const done = <T>(value: T, note: string) => {
      fetched += 1;
      progress(`${adapter.name}: ${note}`);
      return value;
    };
    if (adapter.experimentalIndeed) {
      try {
        indeedBatch ??= collectIndeed(db, indeedConfiguration(request, user.role === 'admin'),
          searchTerms, request.signal, fetch,
          activeAdapters.filter(source => source.experimentalIndeed)
            .map(source => source.country === 'netherlands' ? 'NL' : 'CH'),
          indeedSettings, undefined, undefined, user.id);
        const summary = (await indeedBatch)[adapter.country === 'netherlands' ? 'NL' : 'CH'];
        const bulk = summary.jobs.filter(job => bulkJobIsRelevant(job, adapter.country, searchTerms));
        return done({ ...empty, bulk, candidates: bulk.map(job => canonicalJobUrl(job.sourceUrl)),
          indeed: { ...summary, rejected: summary.rejected + summary.jobs.length - bulk.length } }, summary.status);
      } catch {
        return done({ ...empty, indeed: { jobs: [], status: 'failed', message: 'Indeed collection failed safely; check local configuration.',
          roles: [], retrieved: 0, rejected: 0, duplicates: 0, requests: 0 } satisfies IndeedBatchResult }, 'failed');
      }
    }
    if (adapter.availability !== 'enabled') return done(empty, 'not available');
    if (adapter.hasCredentials && !adapter.hasCredentials(credentials)) {
      return done({ ...empty, missingCredentials: true }, 'no credentials');
    }
    try {
      if (adapter.searchDetailed) {
        // Filtered to this adapter's country and roles before anything is capped: see
        // bulkJobIsRelevant for how capping first left the employer boards stuck on the same
        // first 200 worldwide postings run after run.
        const bulk = (await adapter.searchDetailed(searchTerms, criteria.location, credentials))
          .filter((job) => bulkJobIsRelevant(job, adapter.country, searchTerms));
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
    const { adapter, candidates, bulk, error, missingCredentials, indeed } = result;
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
        matchedCount: null,
        duplicateCount: 0,
        skippedCount: 0,
        message: adapter.availabilityMessage,
      });
      continue;
    }
    if (adapter.availability !== 'enabled' && !indeed) {
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
        matchedCount: null,
        duplicateCount: 0,
        skippedCount: 0,
        message: adapter.availabilityMessage,
      });
      continue;
    }
    const isBulk = Boolean(adapter.searchDetailed || indeed);
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
        matchedCount: null,
        duplicateCount: 0,
        skippedCount: 0,
        message: error || 'The source has no detail parser.',
      });
      continue;
    }

    const bulkByUrl = new Map(bulk.map((job) => [canonicalJobUrl(job.sourceUrl), job]));
    // Remembered rejections count as known: the listing was already fetched and judged, so it
    // no longer occupies one of the four per-run slots. Without this, four permanently
    // unimportable listings at the head of a page-fetching source starved everything behind
    // them on every run (#93). The cap itself is unchanged.
    const isKnownCandidate = (url: string) => isKnownUrl(url, known) || isRejectedUrl(url, rejected, rolesKey);
    const knownCount = candidates.filter(isKnownCandidate).length;
    const rememberedCount = candidates.filter((url) => !isKnownUrl(url, known) && isRejectedUrl(url, rejected, rolesKey)).length;
    const newCandidates = candidates.filter((url) => !isKnownCandidate(url));
    const attempted = newCandidates.slice(0, isBulk ? MAX_NEW_PER_BULK_SOURCE : MAX_NEW_PER_SOURCE);
    let importedCount = 0;
    let matchedCount = 0;
    let duplicateCount = 0;
    // Deferring candidates because of the per-run cap is normal; only real parse/filter failures make a run partial.
    // The deferred list itself is deliberately not persisted (#93): postedAt is only known
    // after the detail fetch, so no recency ordering is possible before it, and a stored queue
    // would need per-owner ordering and merge semantics for the narrow case of more than four
    // new listings plus a page reorder between runs. Remembered rejections already let a stable
    // page drain run over run, and the deferred count stays visible in the message below.
    const deferredCount = newCandidates.length - attempted.length;
    let failedCount = 0;

    for (const [index, url] of attempted.entries()) {
      let parsed: ParsedJob | null;
      if (isBulk) {
        parsed = bulkByUrl.get(url) ?? null;
      } else {
        if (index > 0) await delay(REQUEST_DELAY_MS);
        try {
          parsed = await adapter.fetchDetail!(url);
        } catch {
          // Transient: the request never completed, so nothing is known about the listing. It
          // stays retryable and is never remembered; the safe direction is a wasted slot next
          // run, never a silently lost job.
          failedCount += 1;
          continue;
        }
      }
      if (!parsed) {
        failedCount += 1;
        // The page answered but holds no parseable posting: a property of the page, so it is
        // remembered rather than re-read on every run. Bulk sources never reach this branch
        // with a null (their postings arrive in the search response); the guard keeps their
        // pre-cap filtering untouched.
        if (!isBulk) rejected.push(await rememberRejection(db, user.id, url, 'unparseable', rolesKey));
        continue;
      }
      // The apply link is rendered as a clickable href, and for several sources it comes straight
      // out of a third-party response - Adzuna hands back `redirect_url`, Careerjet hands back
      // `url`. Nothing upstream checks the scheme, so a compromised or malicious source could put
      // `javascript:` there and have it run in this origin the moment somebody clicked Apply. The
      // manual import path has always validated this; the search path did not.
      if (!isSafeManualJobUrl(parsed.sourceUrl)) {
        failedCount += 1;
        // The scheme is a property of the listing and will not change between runs.
        if (!isBulk) rejected.push(await rememberRejection(db, user.id, url, 'unsafe-url', rolesKey));
        continue;
      }
      const description = stripHtml(parsed.descriptionHtml);
      const parsedCountry = sourceInfoForUrl(parsed.sourceUrl, parsed.location).country;
      if (description.length < 160 || parsedCountry !== adapter.country || !descriptionMatchesRoles(parsed, searchTerms)) {
        failedCount += 1;
        if (!isBulk) {
          // All three are properties of the fetched advertisement, not of the attempt: a short
          // ad will not lengthen, a wrong-country listing will not move, and a role mismatch
          // holds for as long as the searched roles do (the stored roles key re-opens it when
          // they change). Scope stays page-fetching only; bulk filtering already happens
          // before the cap and is not touched.
          const reason: RejectionReason = description.length < 160 ? 'too-short'
            : parsedCountry !== adapter.country ? 'wrong-country' : 'role-mismatch';
          rejected.push(await rememberRejection(db, user.id, url, reason, rolesKey));
        }
        continue;
      }
      const language = languageForParsedJob(parsed, description);
      const stored = await upsertJob(db, user.id, {
        sourceUrl: parsed.sourceUrl,
        title: parsed.title,
        company: parsed.company,
        location: parsed.location,
        description,
        postedAt: parsed.postedAt,
        // Only Job-Room publishes an end date today; every other adapter leaves it absent,
        // which stores as '' meaning "no expiry published".
        expiresAt: parsed.expiresAt ?? '',
        languageStatus: language.status,
        languageSummary: language.summary,
        languageSignals: language.signals,
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
        // Matched at search time (#124): first-time unique additions that were
        // English-confirmed by the detector and met the saved criteria then.
        // Later user corrections and criteria edits do not rewrite this snapshot;
        // the card labels it as such. Never guessed from importedCount.
        const matchedAtSearch = language.status === 'pass'
          && matchesSearchCriteria(
            { title: parsed.title, location: parsed.location, description },
            criteria,
          );
        if (matchedAtSearch) matchedCount += 1;
        addedById.set(stored.job.id, stored.job);
      }
    }

    const sourceStatus = indeed
      ? (failedCount && indeed.status === 'complete' ? 'partial' : indeed.status)
      : failedCount ? 'partial' : 'complete';
    sourceReports.push({
      sourceKey: adapter.key,
      sourceName: adapter.name,
      country: adapter.country,
      status: sourceStatus,
      rolesSearched: indeed?.roles ?? searchTerms,
      foundCount: indeed?.retrieved ?? candidates.length,
      knownCount,
      newCount: newCandidates.length,
      importedCount,
      // Only completed sources carry a matched number; anything else is unknown,
      // never a false zero. Caps and partial failures keep what was measured.
      matchedCount: sourceStatus === 'complete' || sourceStatus === 'partial' ? matchedCount : null,
      duplicateCount: duplicateCount + (indeed?.duplicates ?? 0),
      skippedCount: deferredCount + failedCount + (indeed?.rejected ?? 0),
      message: [
        adapter.availabilityMessage,
        indeed?.message ?? '',
        deferredCount ? `${deferredCount} further new listing${deferredCount === 1 ? '' : 's'} deferred to the next run by the per-run cap.` : '',
        rememberedCount ? `${rememberedCount} previously rejected listing${rememberedCount === 1 ? '' : 's'} skipped without re-reading.` : '',
        failedCount ? `${failedCount} listing${failedCount === 1 ? '' : 's'} could not be parsed or did not match the search.` : '',
      ].filter(Boolean).join(' '),
    });
  }

  // A country switched off is reported, not omitted. Leaving it out would make Search statistics
  // quietly shrink and look like sources had vanished; reporting it as failed would blame the
  // source for the person's own setting.
  for (const adapter of skippedAdapters) {
    sourceReports.push({
      sourceKey: adapter.key,
      sourceName: adapter.name,
      country: adapter.country,
      status: 'skipped',
      rolesSearched: [],
      foundCount: 0,
      knownCount: 0,
      newCount: 0,
      importedCount: 0,
      matchedCount: null,
      duplicateCount: 0,
      skippedCount: 0,
      message: `${adapter.country === 'netherlands' ? 'The Netherlands' : 'Switzerland'} is switched`
        + ' off in Search settings, so this source was not contacted.',
    });
  }

  const enabledReports = sourceReports.filter((source) => activeAdapters
    .some((adapter) => adapter.key === source.sourceKey && (adapter.availability === 'enabled' || adapter.experimentalIndeed)));
  const overallStatus: SearchRun['status'] = enabledReports.every((source) => source.status === 'failed')
    ? 'failed'
    // 'skipped' is excluded on purpose: switching a country off is a choice, and a run that did
    // exactly what it was asked to do is complete, not partial.
    : sourceReports.some((source) => source.status !== 'complete' && source.status !== 'skipped')
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

  // An ordinary account is not told that hidden sources were searched, let alone what they
  // returned: the same visibleSourceReports shape /api/state serves for stored runs. The
  // aggregate counts below are summed over exactly these visible rows, so an ordinary
  // account's totals disclose nothing about admin-only volume either.
  const visibleSources = visibleSourceReports(sourceReports, user.role === 'admin', hiddenForAccount);
  const run: SearchRun = { id: runId, status: overallStatus, startedAt, completedAt, sources: visibleSources };
  const added = [...addedById.values()];
  return { kind: 'done', body: {
    added,
    run,
    scanned: visibleSources.reduce((sum, source) => sum + source.foundCount, 0),
    alreadyKnown: visibleSources.reduce((sum, source) => sum + source.knownCount, 0),
  } };
}
