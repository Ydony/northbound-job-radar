import { authSecrets, ensureSchema } from '@/db/runtime';
import { recordVisit } from '@/lib/analytics';
import {
  catalogueServingAvailable,
  decodeCatalogueCursor,
  parseCatalogueFilters,
  queryCatalogueAggregates,
  queryCatalogueCopies,
  queryCatalogueFreshness,
  queryCataloguePage,
  queryCataloguePlaces,
  type CatalogueQueryInput,
} from '@/lib/catalogue-query';
import { newSinceCutoff } from '@/lib/dashboard';
import { clientIp, requireSession } from '@/lib/guard';
import { indeedSettingsFromRow } from '@/lib/indeed/settings';
import { adminOnlySourceKeys } from '@/lib/job-adapters';
import { decodeJobsCursor, parsePageLimit } from '@/lib/paging';
import { adminOnlySourcePolicyKeys } from '@/lib/source-policy';
import { criteriaFromRow, ensureCurrentJobClusters, ensureSearchText, jobFromRow, normalizeStoredJobs, queryCollectionTotals, queryJobsPage, searchRunsFromRows, type CriteriaRow,
  type SearchRoleRow, type SearchRunRow, type SearchRunSourceRow } from '@/lib/server-data';
import type { SearchCriteria } from '@/lib/types';

/**
 * INT-05 (#164, also #140): the dashboard no longer counts what it holds.
 *
 * Filtering (five role keywords, country/place/source/application/work-type,
 * language, lifecycle view), faceting, counting and freshness all happen in
 * SQL over the shared catalogue (`vacancies` + caller-scoped
 * `user_vacancy_state`), following the `queryCollectionTotals` aggregate
 * pattern: every number in the `catalogue` block is computed over the whole
 * audience-filtered holding set, so a small page cannot shrink a count. The
 * default page is 40 rows; changing a filter fetches page one of that filter
 * rather than re-filtering what is loaded.
 *
 * History: on 2026-09-23 a 40-row default shipped without the server
 * aggregates and every count read zero while the server held thousands of
 * matches — it was reverted the same day. The aggregates below are what makes
 * the small page honest this time. Databases that predate the catalogue
 * tables keep the previous jobs-table behavior via the legacy branch.
 */
const JOB_PAGE_MAX = 2000;
const JOB_PAGE_DEFAULT = 40;

export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const url = new URL(request.url);
  // Counted here rather than on every request: one visit per dashboard load. Nothing identifying
  // is stored - see lib/analytics.ts.
  await recordVisit(db, clientIp(request), request.headers.get('user-agent') ?? '', authSecrets().sessionSecret);

  // Recheck old links on the first read after a clustering-rule change, even when every job
  // already has a cluster key. New imports and normalized fields also invalidate the version.
  // Order matters: decoding entities first means "Cost &amp; Inventory Analyst" and
  // "Cost & Inventory Analyst" produce the same cluster key and are recognised as one job.

  // Careerjet and IamExpat are the owner's to use, not a feature to offer. Excluded in SQL rather
  // than filtered after the fact, so an ordinary account cannot reach those rows by calling this
  // endpoint directly, and so they never count towards the page limit either.
  //
  // #124 fix (2026-09-22): an administrator's "view as user" preview must show
  // the ordinary-audience numbers, not admin aggregates minus hidden sources.
  // A hidden jobs.ch primary with a public EURES copy counts 0 under naive
  // subtraction but 1 for a real ordinary account (the orphan copy is promoted
  // server-side before aggregation). `?preview=user` applies the ordinary
  // audience predicates before aggregation/dedupe, on the server, so the
  // preview equals what an ordinary account actually receives. Admin-only, and
  // only ever the caller's own rows: it reveals nothing another account holds.
  const previewAsUser = url.searchParams.get('preview') === 'user' && user.role === 'admin';

  // The preview is a read-only view of rows the administrator's own request has already
  // brought up to date, so it runs no maintenance. Pressing "view as user" used to fire a
  // second full state read that redid every pass over the same rows, concurrently with the
  // first, which is what turned a slow read into a lost connection.
  if (!previewAsUser) {
    await normalizeStoredJobs(db, user.id);
    await ensureSearchText(db, user.id);
    await ensureCurrentJobClusters(db, user.id);
  }
  // INT-05 audience: the existing adapter-derived gate plus the source-policy
  // registry (`adminOnlySourcePolicyKeys`). The registry narrows nothing by
  // itself — the union only ever adds — so no existing gate is weakened.
  const ordinaryHiddenSourceKeys = [...new Set([...adminOnlySourceKeys(), ...adminOnlySourcePolicyKeys()])];
  const hiddenSourceKeys = previewAsUser
    ? ordinaryHiddenSourceKeys
    : user.role === 'admin' ? [] : ordinaryHiddenSourceKeys;
  const hideIndeedRecords = previewAsUser || user.role !== 'admin';

  // Copies of the same advertisement are kept in the database but folded into the job on screen,
  // which carries the count and the board names so the alternatives stay reachable.
  // Criteria are evaluated here, against the text, because the text does not leave the server.
  // The client receives each job's matchesCriteria and never the advertisement it was judged on.
  const [criteriaRow, roleRows, runs] = await Promise.all([
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles WHERE user_id = ? ORDER BY position').bind(user.id).all<SearchRoleRow>(),
    db.prepare('SELECT * FROM search_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 12').bind(user.id).all<SearchRunRow>(),
  ]);
  const searchCriteria = criteriaFromRow(criteriaRow, roleRows.results);
  // Indeed settings are administrator-only (#113). Ordinary accounts never
  // receive them here, and the dedicated settings API refuses them outright,
  // so they cannot learn these exist by direct API, guessed ID or UI.
  const indeedSettingsRow = user.role === 'admin'
    ? await db.prepare('SELECT nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at FROM indeed_settings WHERE user_id = ?')
      .bind(user.id).first<{ nl_location: unknown; nl_radius_km: unknown; ch_location: unknown; ch_radius_km: unknown; updated_at: unknown }>()
      .catch(() => null)
    : null;

  const runIds = runs.results.map((run) => run.id);
  const runSources = runIds.length
    ? await db.prepare(`SELECT * FROM search_run_sources WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY source_name`)
      .bind(...runIds).all<SearchRunSourceRow>()
    : { results: [] as SearchRunSourceRow[] };
  // Page-fetching sources are an administrator capability, so their run rows are withheld from
  // everyone else rather than only hidden in the interface. The user preview
  // applies the same ordinary-audience rule: audience filtering happens
  // before aggregation, never as a client-side subtraction of admin rows.
  const searchRuns = searchRunsFromRows(runs.results, !previewAsUser && user.role === 'admin'
    ? runSources.results
    // Same rule as the jobs above, from the same derived list: an ordinary account is not told
    // that these sources were searched, let alone what they returned.
    : runSources.results.filter((row) => !hiddenSourceKeys.includes(row.source_key)))
    .filter(run => (!previewAsUser && user.role === 'admin') || run.sources.length > 0)
    .map(run => (!previewAsUser && user.role === 'admin') ? run : { ...run,
      status: run.sources.every(source => source.status === 'complete') ? 'complete'
        : run.sources.every(source => source.status === 'failed') ? 'failed' : 'partial' });

  const shared = {
    account: { email: user.email, role: user.role },
    // Sent so the administrator's "view as user" preview can hide the same sources the server
    // already withholds from everyone else. The server is what enforces it; this is what makes the
    // preview honest, and it is only ever non-empty for an administrator, who can see them anyway.
    adminOnlySources: user.role === 'admin' ? [...adminOnlySourceKeys()] : [],
    criteria: searchCriteria,
    // The ordinary-audience preview mirrors what an ordinary account receives,
    // so it never carries Indeed settings even for the requesting administrator.
    ...(!previewAsUser && user.role === 'admin' ? { indeedSettings: indeedSettingsFromRow(indeedSettingsRow) } : {}),
    searchRuns,
  };

  if (!await catalogueServingAvailable(db)) {
    return legacyStateResponse(db, user.id, url, hiddenSourceKeys, hideIndeedRecords, searchCriteria, shared);
  }

  const { size: pageSize, error: limitError } = parsePageLimit(url.searchParams.get('limit'), JOB_PAGE_MAX, JOB_PAGE_DEFAULT);
  if (limitError) return Response.json({ error: limitError }, { status: 400 });
  const { cursor, error: cursorError } = decodeCatalogueCursor(url.searchParams.get('cursor'));
  if (cursorError) return Response.json({ error: cursorError }, { status: 400 });
  // The "what's new since last run" baseline: the latest finished run's start,
  // or the last seven days before any run. Server-derived, so the `new` view
  // cannot be widened by a crafted cutoff.
  const since = newSinceCutoff(searchRunsFromRows(runs.results, []), new Date().toISOString());
  const { filters, error: filterError } = parseCatalogueFilters(url.searchParams, searchCriteria, since);
  if (filterError) return Response.json({ error: filterError }, { status: 400 });

  const audience = { hiddenSourceKeys, hideIndeedRecords };
  const unplaced: CatalogueQueryInput = {
    userId: user.id,
    audience,
    filters,
    criteria: searchCriteria,
    placeLocations: [],
    placeResolvable: true,
  };
  // Places group server-side, so the requested place resolves to its backing
  // raw locations here — still in the API, before the page query runs.
  const places = await queryCataloguePlaces(db, unplaced);
  const placeLocations = filters.place === 'all' ? [] : places.locationsByPlace.get(filters.place) ?? [];
  const input: CatalogueQueryInput = {
    ...unplaced,
    placeLocations,
    placeResolvable: filters.place === 'all' || places.locationsByPlace.has(filters.place),
  };
  const [page, aggregates, freshness, collectionTotals] = await Promise.all([
    queryCataloguePage(db, input, cursor, pageSize),
    queryCatalogueAggregates(db, input),
    // Catalogue ingest freshness (per-source last sightings over this
    // account's audience-filtered holdings). The user's search events travel
    // separately as `searchRuns` above — an ingest report and a search
    // report, never one number doing both jobs.
    queryCatalogueFreshness(db, user.id, audience),
    // #124 Total collected: full account-scoped retained collection from the
    // server, never from loaded pages or summed run counts. Saved, applied and
    // dismissed rows are included; deleted rows are gone. Hidden sources are
    // excluded here, so ordinary accounts never learn admin-source counts.
    queryCollectionTotals(db, user.id, hiddenSourceKeys, hideIndeedRecords),
  ]);
  // The card's "also on" line: held copies folded into each shown primary,
  // counted server-side over the account's holdings rather than over the page.
  const copies = await queryCatalogueCopies(db, user.id, audience, page.jobs.map((job) => job.id));
  const jobs = page.jobs.map((job) => {
    const sources = copies.get(job.id);
    return sources ? { ...job, duplicateCount: sources.length, duplicateSources: [...new Set(sources)] } : job;
  });

  return Response.json({
    ...shared,
    jobs,
    // Folded copies under the current filters, page-independent: the number
    // the card discloses next to the list, not an accumulation over loads.
    hiddenDuplicates: aggregates.folded,
    totalJobs: aggregates.total,
    // Vacancies the current filters keep, across every page, not just this
    // one. The dashboard counts and facets render this and the aggregates
    // below; they converge without loading more.
    matchingJobs: aggregates.matching,
    collectionTotals,
    catalogue: {
      filters: {
        roles: filters.roles,
        country: filters.country,
        place: filters.place,
        source: filters.source,
        application: filters.application,
        workType: filters.workType,
        language: filters.language,
        view: filters.view,
        sort: filters.sort,
      },
      total: aggregates.total,
      matching: aggregates.matching,
      inView: aggregates.inView,
      folded: aggregates.folded,
      viewCounts: aggregates.viewCounts,
      languageCounts: aggregates.languageCounts,
      facets: aggregates.facets,
      places: { all: places.all, groups: places.groups },
      freshness,
    },
    jobLimit: pageSize,
    // Null when this page is the end: fewer rows than requested means nothing follows.
    nextCursor: page.nextCursor,
  });
}

/**
 * Databases that predate the catalogue tables (migration 30) keep the
 * previous jobs-table serving until they migrate: keyword filtering in SQL
 * before the page limit, whole-collection page for the client to count over.
 * Application databases always run all migrations, so this is a fallback, not
 * a second supported read model.
 */
async function legacyStateResponse(
  db: D1Database,
  userId: string,
  url: URL,
  hiddenSourceKeys: string[],
  hideIndeedRecords: boolean,
  searchCriteria: SearchCriteria,
  shared: Record<string, unknown>,
) {
  const { size: pageSize, error: limitError } = parsePageLimit(url.searchParams.get('limit'), JOB_PAGE_MAX);
  if (limitError) return Response.json({ error: limitError }, { status: 400 });
  const { cursor, error: cursorError } = decodeJobsCursor(url.searchParams.get('cursor'));
  if (cursorError) return Response.json({ error: cursorError }, { status: 400 });
  const [page, collectionTotals] = await Promise.all([
    queryJobsPage(db, userId, {
      hiddenSourceKeys,
      hideIndeedRecords,
      criteria: searchCriteria,
      cursor,
      limit: pageSize,
    }),
    queryCollectionTotals(db, userId, hiddenSourceKeys, hideIndeedRecords),
  ]);
  const allJobs = page.rows.map((row) => jobFromRow(row, searchCriteria));
  const byId = new Map(allJobs.map((job) => [job.id, job]));
  const copies = new Map<string, string[]>();
  for (const job of allJobs) {
    if (!job.duplicateOf || !byId.has(job.duplicateOf)) continue;
    copies.set(job.duplicateOf, [...(copies.get(job.duplicateOf) ?? []), job.sourceName]);
  }
  const visibleJobs = allJobs
    // A copy whose primary fell outside the page limit is shown rather than lost.
    .filter((job) => !job.duplicateOf || !byId.has(job.duplicateOf))
    .map((job) => {
      const sources = copies.get(job.id);
      return sources ? { ...job, duplicateCount: sources.length, duplicateSources: [...new Set(sources)] } : job;
    });

  return Response.json({
    ...shared,
    jobs: visibleJobs,
    hiddenDuplicates: allJobs.length - visibleJobs.length,
    totalJobs: page.total,
    matchingJobs: page.matching,
    collectionTotals,
    jobLimit: pageSize,
    nextCursor: page.nextCursor,
  });
}
