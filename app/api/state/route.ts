import { authSecrets, ensureSchema } from '@/db/runtime';
import { recordVisit } from '@/lib/analytics';
import { clientIp, requireSession } from '@/lib/guard';
import { adminOnlySourceKeys } from '@/lib/job-adapters';
import { indeedSql } from '@/lib/indeed/access';
import { criteriaFromRow, cvFromRow, ensureCurrentJobClusters, jobFromRow, normalizeStoredJobs, searchRunsFromRows, type CriteriaRow, type CvRow,
  type JobRow, type SearchRoleRow, type SearchRunRow, type SearchRunSourceRow } from '@/lib/server-data';

/**
 * The dashboard filters and counts across the whole set client-side, so it loads jobs in one go
 * rather than paging. That cannot grow without bound: the response also carries each description,
 * which is roughly a third of its size. The limit is therefore explicit, and the total is returned
 * alongside so the interface can say when it is showing only part of the workspace - silently
 * hiding jobs is worse than admitting the ceiling.
 */
const JOB_PAGE_LIMIT = 2000;

export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  // Counted here rather than on every request: one visit per dashboard load. Nothing identifying
  // is stored - see lib/analytics.ts.
  await recordVisit(db, clientIp(request), request.headers.get('user-agent') ?? '', authSecrets().sessionSecret);

  // Recheck old links on the first read after a clustering-rule change, even when every job
  // already has a cluster key. New imports and normalized fields also invalidate the version.
  // Order matters: decoding entities first means "Cost &amp; Inventory Analyst" and
  // "Cost & Inventory Analyst" produce the same cluster key and are recognised as one job.
  await normalizeStoredJobs(db, user.id);
  await ensureCurrentJobClusters(db, user.id);

  // Careerjet and IamExpat are the owner's to use, not a feature to offer. Excluded in SQL rather
  // than filtered after the fact, so an ordinary account cannot reach those rows by calling this
  // endpoint directly, and so they never count towards the page limit either.
  const hiddenSourceKeys = user.role === 'admin' ? [] : [...adminOnlySourceKeys()];
  const hiddenClause = hiddenSourceKeys.length
    ? ` AND jobs.source_key NOT IN (${hiddenSourceKeys.map(() => '?').join(',')}) AND NOT ${indeedSql('jobs')}`
    : '';

  const [cvs, jobs, criteria, roles, runs, jobTotal] = await Promise.all([
    db.prepare('SELECT * FROM cvs WHERE user_id = ? ORDER BY slot').bind(user.id).all<CvRow>(),
    db.prepare(`SELECT jobs.*, language_feedback.verdict AS feedback_verdict,
      language_feedback.corrected_status AS feedback_corrected_status,
      language_feedback.reason AS feedback_reason, language_feedback.updated_at AS feedback_updated_at
      FROM jobs LEFT JOIN language_feedback ON language_feedback.job_id = jobs.id
      WHERE jobs.user_id = ?${hiddenClause}
      ORDER BY jobs.updated_at DESC LIMIT ?`)
      .bind(user.id, ...hiddenSourceKeys, JOB_PAGE_LIMIT).all<JobRow>(),
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles WHERE user_id = ? ORDER BY position').bind(user.id).all<SearchRoleRow>(),
    db.prepare('SELECT * FROM search_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 12').bind(user.id).all<SearchRunRow>(),
    db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE user_id = ?${hiddenClause.replace(/jobs\./g, '')}`)
      .bind(user.id, ...hiddenSourceKeys).first<{ total: number }>(),
  ]);
  const runIds = runs.results.map((run) => run.id);
  const runSources = runIds.length
    ? await db.prepare(`SELECT * FROM search_run_sources WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY source_name`)
      .bind(...runIds).all<SearchRunSourceRow>()
    : { results: [] as SearchRunSourceRow[] };
  // Copies of the same advertisement are kept in the database but folded into the job on screen,
  // which carries the count and the board names so the alternatives stay reachable.
  // Criteria are evaluated here, against the text, because the text does not leave the server.
  // The client receives each job's matchesCriteria and never the advertisement it was judged on.
  const searchCriteria = criteriaFromRow(criteria, roles.results);
  const allJobs = jobs.results.map((row) => jobFromRow(row, searchCriteria));
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
    profiles: cvs.results.map(cvFromRow),
    jobs: visibleJobs,
    hiddenDuplicates: allJobs.length - visibleJobs.length,
    totalJobs: jobTotal?.total ?? jobs.results.length,
    jobLimit: JOB_PAGE_LIMIT,
    criteria: searchCriteria,
    // Page-fetching sources are an administrator capability, so their run rows are withheld from
    // everyone else rather than only hidden in the interface.
    searchRuns: searchRunsFromRows(runs.results, user.role === 'admin'
      ? runSources.results
      // Same rule as the jobs above, from the same derived list: an ordinary account is not told
      // that these sources were searched, let alone what they returned.
      : runSources.results.filter((row) => !hiddenSourceKeys.includes(row.source_key)))
      .filter(run => user.role === 'admin' || run.sources.length > 0)
      .map(run => user.role === 'admin' ? run : { ...run,
        status: run.sources.every(source => source.status === 'complete') ? 'complete'
          : run.sources.every(source => source.status === 'failed') ? 'failed' : 'partial' }),
  });
}
