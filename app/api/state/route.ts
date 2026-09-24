import { authSecrets, ensureSchema } from '@/db/runtime';
import { recordVisit } from '@/lib/analytics';
import { clientIp, requireSession } from '@/lib/guard';
import { indeedSettingsFromRow } from '@/lib/indeed/settings';
import { adminOnlySourceKeys } from '@/lib/job-adapters';
import { decodeJobsCursor, parsePageLimit } from '@/lib/paging';
import { criteriaFromRow, ensureCurrentJobClusters, ensureSearchText, jobFromRow, normalizeStoredJobs, queryCollectionTotals, queryJobsPage, visibleSearchRuns, type CriteriaRow,
  type SearchRoleRow, type SearchRunRow, type SearchRunSourceRow } from '@/lib/server-data';

/**
 * The dashboard filters and counts across the whole set, so it loads jobs in pages rather than
 * all at once. Each page carries at most JOB_PAGE_LIMIT rows; the response says how many jobs
 * match overall and where the next page starts, so the interface can page beyond any single
 * response instead of silently hiding whatever falls off the end.
 *
 * Keyword filtering happens in SQL, before the page limit, against the folded
 * `jobs.search_text` column (see lib/criteria.ts). It used to happen per returned row only,
 * which meant the limit was spent on jobs the saved criteria would have excluded while older
 * matching jobs stayed invisible past it. matchesCriteria is still computed per row and stays
 * the value the client renders; the two agree by construction.
 */
const JOB_PAGE_LIMIT = 2000;
/*
 * There is deliberately no smaller default. A page of 40 was tried on 2026-09-23 and
 * reverted the same day: every filter count and every lifecycle tab in app/job-radar.tsx
 * is computed from the jobs the client holds, so a 40-row page that happens to contain
 * nothing matching the active filter renders "Definitely English 0", "All 0" and an empty
 * list while the server holds 2,383 matches. Paging has to move to the server - filtering
 * and counting with it - before the client can be handed less than everything. See #140.
 */

export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const url = new URL(request.url);
  const { size: pageSize, error: limitError } = parsePageLimit(url.searchParams.get('limit'), JOB_PAGE_LIMIT);
  if (limitError) return Response.json({ error: limitError }, { status: 400 });
  const { cursor, error: cursorError } = decodeJobsCursor(url.searchParams.get('cursor'));
  if (cursorError) return Response.json({ error: cursorError }, { status: 400 });
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
  const ordinaryHiddenSourceKeys = [...adminOnlySourceKeys()];
  const hiddenSourceKeys = previewAsUser
    ? ordinaryHiddenSourceKeys
    : user.role === 'admin' ? [] : ordinaryHiddenSourceKeys;
  const hideIndeedRecords = previewAsUser || user.role !== 'admin';

  // Copies of the same advertisement are kept in the database but folded into the job on screen,
  // which carries the count and the board names so the alternatives stay reachable.
  // Criteria are evaluated here, against the text, because the text does not leave the server.
  // The client receives each job's matchesCriteria and never the advertisement it was judged on.
  const [criteriaRow, roleRows] = await Promise.all([
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles WHERE user_id = ? ORDER BY position').bind(user.id).all<SearchRoleRow>(),
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
  const [page, runs, collectionTotals] = await Promise.all([
    queryJobsPage(db, user.id, {
      hiddenSourceKeys,
      hideIndeedRecords,
      criteria: searchCriteria,
      cursor,
      limit: pageSize,
    }),
    db.prepare('SELECT * FROM search_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 12').bind(user.id).all<SearchRunRow>(),
    // #124 Total collected: full account-scoped retained collection from the
    // server, never from loaded pages or summed run counts. Saved, applied and
    // dismissed rows are included; deleted rows are gone. Hidden sources are
    // excluded here, so ordinary accounts never learn admin-source counts.
    queryCollectionTotals(db, user.id, hiddenSourceKeys, hideIndeedRecords),
  ]);
  const runIds = runs.results.map((run) => run.id);
  const runSources = runIds.length
    ? await db.prepare(`SELECT * FROM search_run_sources WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY source_name`)
      .bind(...runIds).all<SearchRunSourceRow>()
    : { results: [] as SearchRunSourceRow[] };
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
    account: { email: user.email, role: user.role },
    // Sent so the administrator's "view as user" preview can hide the same sources the server
    // already withholds from everyone else. The server is what enforces it; this is what makes the
    // preview honest, and it is only ever non-empty for an administrator, who can see them anyway.
    adminOnlySources: user.role === 'admin' ? [...adminOnlySourceKeys()] : [],
    jobs: visibleJobs,
    hiddenDuplicates: allJobs.length - visibleJobs.length,
    totalJobs: page.total,
    // Jobs the saved keywords keep, across every page, not just this one. The dashboard counts
    // and facets over the loaded pages; this is the number they converge to as pages load.
    matchingJobs: page.matching,
    collectionTotals,
    jobLimit: pageSize,
    // Null when this page is the end: fewer rows than requested means nothing follows.
    nextCursor: page.nextCursor,
    criteria: searchCriteria,
    // The ordinary-audience preview mirrors what an ordinary account receives,
    // so it never carries Indeed settings even for the requesting administrator.
    ...(!previewAsUser && user.role === 'admin' ? { indeedSettings: indeedSettingsFromRow(indeedSettingsRow) } : {}),
    // Page-fetching sources are an administrator capability, so their run rows are withheld from
    // everyone else rather than only hidden in the interface. The user preview
    // applies the same ordinary-audience rule: audience filtering happens
    // before aggregation, never as a client-side subtraction of admin rows.
    // Shaped by visibleSearchRuns (lib/server-data.ts) so the stored-run read path and the
    // fresh-search response cannot disagree about what an ordinary account may see.
    searchRuns: visibleSearchRuns(runs.results, runSources.results,
      !previewAsUser && user.role === 'admin', new Set(hiddenSourceKeys)),
  });
}
