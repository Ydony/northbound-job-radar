/**
 * INT-05 (#164, also #140): serve the shared public catalogue (`vacancies` +
 * `vacancy_sources`, split from per-user state in INT-04/migration 30) with
 * server-side filtering, faceting, counting and stable pagination.
 *
 * This follows the `queryCollectionTotals` pattern from #124: aggregates are
 * computed in SQL over the whole audience-filtered holding set, so no number
 * depends on which page is loaded. The 40-row page that broke the dashboard in
 * #140 broke it because counts were derived client-side from held rows; here
 * the page carries rows and the aggregates carry whole-collection numbers, and
 * the two agree by construction (same predicates, pagination only on the page).
 *
 * Read model (one row per holding, advert from the shared catalogue):
 * - advert fields (title/company/location, excerpt and requirements derived
 *   from the description, language verdict, country, dates) come from
 *   `vacancies`;
 * - personal fields (saved/applied/dismissed, language corrections) come from
 *   `user_vacancy_state` scoped by `user_id` — the only per-user table read;
 * - the holding's own source (audience gate) comes from the caller's `jobs`
 *   row via `user_vacancy_state.job_id`, so an ordinary account's public copy
 *   of an advert is shown even when its primary lives behind an admin source
 *   (the #124 orphan-promotion rule), while admin-only holdings never appear.
 *
 * Audience: callers pass `hiddenSourceKeys` (the union of the existing
 * `adminOnlySourceKeys()` gate and `adminOnlySourcePolicyKeys()` from
 * lib/source-policy.ts — the registry narrows nothing by itself, so the union
 * only ever adds) plus `hideIndeedRecords`. Admin-only names, rows, counts,
 * facets and freshness never reach ordinary responses through any query here.
 *
 * The advertisement text stops here like it does in `jobFromRow`: it is read
 * to derive excerpt/requirements/matchesCriteria and never copied onto the
 * returned records. No query here returns `description`.
 *
 * Role keywords (up to five, OR semantics): each role is an AND of its folded
 * words against `vacancies.search_text`, roles ORed together. Word-anywhere
 * serving is deliberately no stricter than the import rule
 * (`descriptionMatchesRoles` additionally requires title containment for the
 * head noun), so no retained row that passed import under the same roles is
 * hidden by serving under those roles. Only a role *change* narrows what is
 * served — which is the catalogue contract ("serves each user's five role
 * keywords"). Pipeline and Dismissed ignore roles, keywords and language
 * (ride-along: records of what the person did, as in `jobInView`).
 *
 * Duplicate folding is evaluated at filter level: a copy folds only while its
 * primary is in the current filtered set. A copy whose primary is filtered
 * out (another source, dismissed, a narrowed facet) is shown rather than
 * lost — the #124 orphan rule applied to result filters, not just audience.
 */

import { countryLabel } from './job-identity';
import { escapeLikePattern, normalizeRoleKeywords, searchTextForJob } from './criteria';
import { INDEED_SOURCE_KEYS, indeedSql } from './indeed/access';
import { normalizePlace } from './places';
import { jobFromRow } from './server-data';
import type { SearchCriteria } from './types';
import type { WorkplaceType } from './workplace';

export type CatalogueView = 'new' | 'all' | 'pipeline' | 'dismissed';
export type CatalogueLanguage = 'pass' | 'review' | 'unknown' | 'blocked' | 'all';
export type CatalogueApplication = 'all' | 'applied' | 'not_applied';
export type CatalogueSort = 'posted' | 'found';
export type CatalogueWorkType = 'all' | WorkplaceType;

export interface CatalogueFilters {
  roles: string[];
  country: 'all' | 'switzerland' | 'netherlands';
  /** 'all' or a grouped city label as produced by `normalizePlace`. */
  place: string;
  /** 'all' or a holding source key. */
  source: string;
  application: CatalogueApplication;
  workType: CatalogueWorkType;
  language: CatalogueLanguage;
  view: CatalogueView;
  sort: CatalogueSort;
  /** Cutoff ISO timestamp for the `new` view (the latest finished run's start). */
  since: string;
}

export interface CatalogueAudience {
  hiddenSourceKeys: string[];
  hideIndeedRecords: boolean;
}

interface Clause {
  clause: string;
  params: unknown[];
}

interface Aliases {
  v: string;
  s: string;
  j: string;
}

const OUTER: Aliases = { v: 'v', s: 's', j: 'j' };
const PRIMARY: Aliases = { v: 'pv', s: 'ps', j: 'pj' };

/** Effective verdict: the caller's correction wins over the detector. */
const effectiveLanguage = (s: string, v: string) =>
  `CASE WHEN ${s}.corrected_status != '' THEN ${s}.corrected_status ELSE ${v}.language_status END`;

/** Empty workplace analyses group as unknown, like the client facet does. */
const workplaceValue = (v: string) => `COALESCE(NULLIF(${v}.workplace_type, ''), 'unknown')`;

export async function catalogueServingAvailable(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
    WHERE type = 'table' AND name IN ('vacancies', 'vacancy_sources', 'user_vacancy_state')`)
    .first<{ total: number }>();
  return (row?.total ?? 0) === 3;
}

function audienceClauses(audience: CatalogueAudience, jobAlias: string): Clause {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (audience.hiddenSourceKeys.length) {
    parts.push(` AND ${jobAlias}.source_key NOT IN (${audience.hiddenSourceKeys.map(() => '?').join(',')})`);
    params.push(...audience.hiddenSourceKeys);
  }
  if (audience.hideIndeedRecords) parts.push(` AND NOT ${indeedSql(jobAlias)}`);
  return { clause: parts.join(''), params };
}

function foldWord(value: string) {
  return searchTextForJob({ title: value, location: '', description: '' }).trim();
}

function roleWords(role: string): string[] {
  return foldWord(role).split(/[^a-z0-9]+/).filter((word) => word.length > 2);
}

/**
 * OR over roles of AND over each role's folded words. Roles with no
 * matchable word (e.g. a two-letter abbreviation) are dropped rather than
 * matching nothing or everything — serving stays lenient, never a trap.
 */
function rolesClause(roles: string[], v: string): Clause {
  const worded = roles.map((role) => roleWords(role)).filter((words) => words.length > 0);
  if (!worded.length) return { clause: '', params: [] };
  const params: unknown[] = [];
  const groups = worded.map((words) => {
    const likes = words.map(() => `${v}.search_text LIKE ? ESCAPE '\\'`);
    for (const word of words) params.push(`%${escapeLikePattern(word)}%`);
    return `(${likes.join(' AND ')})`;
  });
  return { clause: ` AND (${groups.join(' OR ')})`, params };
}

function keywordsClause(criteria: Pick<SearchCriteria, 'requiredKeywords' | 'excludedKeywords'>, v: string): Clause {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const keyword of criteria.requiredKeywords) {
    const folded = foldWord(keyword);
    if (!folded) continue;
    parts.push(` AND ${v}.search_text LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLikePattern(folded)}%`);
  }
  for (const keyword of criteria.excludedKeywords) {
    const folded = foldWord(keyword);
    if (!folded) continue;
    parts.push(` AND ${v}.search_text NOT LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLikePattern(folded)}%`);
  }
  return { clause: parts.join(''), params };
}

export interface CatalogueQueryInput {
  userId: string;
  audience: CatalogueAudience;
  filters: CatalogueFilters;
  criteria: SearchCriteria;
  /** Raw locations backing `filters.place`, resolved server-side (see below). */
  placeLocations: string[];
  /** False when `filters.place` names a place with no backing locations. */
  placeResolvable: boolean;
}

function viewClause(filters: CatalogueFilters, s: string): Clause {
  if (filters.view === 'dismissed') return { clause: ` AND ${s}.visibility_status = 'dismissed'`, params: [] };
  if (filters.view === 'pipeline') {
    return {
      clause: ` AND ${s}.visibility_status = 'active' AND (${s}.is_saved = 1 OR ${s}.application_status = 'applied')`,
      params: [],
    };
  }
  const parts = [` AND ${s}.visibility_status = 'active'`];
  const params: unknown[] = [];
  if (filters.view === 'new') {
    parts.push(` AND ${s}.created_at >= ?`);
    params.push(filters.since);
  }
  return { clause: parts.join(''), params };
}

/** Roles, saved keywords and language narrow browsable views, never the ride-along ones. */
function narrowingClauses(filters: CatalogueFilters, criteria: SearchCriteria, a: Aliases): Clause {
  if (filters.view === 'pipeline' || filters.view === 'dismissed') return { clause: '', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  const roles = rolesClause(filters.roles, a.v);
  parts.push(roles.clause);
  params.push(...roles.params);
  const keywords = keywordsClause(criteria, a.v);
  parts.push(keywords.clause);
  params.push(...keywords.params);
  if (filters.language !== 'all') {
    parts.push(` AND ${effectiveLanguage(a.s, a.v)} = ?`);
    params.push(filters.language);
  }
  return { clause: parts.join(''), params };
}

export type CatalogueSkip = 'country' | 'source' | 'application' | 'place' | 'workType' | null;

function facetClauses(input: CatalogueQueryInput, skip: CatalogueSkip, a: Aliases): Clause {
  const { filters } = input;
  const parts: string[] = [];
  const params: unknown[] = [];
  if (skip !== 'country' && filters.country !== 'all') {
    parts.push(` AND ${a.v}.country = ?`);
    params.push(filters.country);
  }
  if (skip !== 'source' && filters.source !== 'all') {
    parts.push(` AND ${a.j}.source_key = ?`);
    params.push(filters.source);
  }
  if (skip !== 'application' && filters.application !== 'all') {
    parts.push(` AND ${a.s}.application_status = ?`);
    params.push(filters.application);
  }
  if (skip !== 'workType' && filters.workType !== 'all') {
    parts.push(` AND ${workplaceValue(a.v)} = ?`);
    params.push(filters.workType);
  }
  if (skip !== 'place') {
    if (input.placeLocations.length) {
      parts.push(` AND ${a.v}.location IN (${input.placeLocations.map(() => '?').join(',')})`);
      params.push(...input.placeLocations);
    } else if (!input.placeResolvable) {
      parts.push(` AND 1 = 0`);
    }
  }
  return { clause: parts.join(''), params };
}

function baseFrom(a: Aliases): string {
  // Holdings only: every row served is a vacancy this account holds via its
  // own jobs row (deleted rows are gone — the INNER JOINs drop state whose job
  // row no longer exists). Advert text from the shared catalogue, personal
  // state from this account's row, holding source from this account's copy.
  return `FROM vacancies ${a.v}
    JOIN user_vacancy_state ${a.s} ON ${a.s}.vacancy_id = ${a.v}.id AND ${a.s}.user_id = ?
    JOIN jobs ${a.j} ON ${a.j}.id = ${a.s}.job_id AND ${a.j}.user_id = ${a.s}.user_id`;
}

function filteredOn(input: CatalogueQueryInput, skip: CatalogueSkip, a: Aliases): Clause {
  const audience = audienceClauses(input.audience, a.j);
  const view = viewClause(input.filters, a.s);
  const narrowing = narrowingClauses(input.filters, input.criteria, a);
  const facets = facetClauses(input, skip, a);
  return {
    clause: `${audience.clause}${view.clause}${narrowing.clause}${facets.clause}`,
    params: [...audience.params, ...view.params, ...narrowing.params, ...facets.params],
  };
}

function foldedOutClause(input: CatalogueQueryInput): Clause {
  const inner = baseFrom(PRIMARY);
  const predicates = filteredOn(input, null, PRIMARY);
  // Two owner binds: the inner holding join, then the primary identity check.
  return {
    clause: ` AND NOT EXISTS (SELECT 1 ${inner}
      WHERE ${PRIMARY.j}.id = j.duplicate_of AND ${PRIMARY.j}.user_id = ?${predicates.clause})`,
    params: [input.userId, input.userId, ...predicates.params],
  };
}

/** Every predicate except pagination: the shape all counts share with the page. */
function filteredWhere(input: CatalogueQueryInput, skip: CatalogueSkip): Clause {
  const own = filteredOn(input, skip, OUTER);
  // Facet-minus-self counts fold the way the narrowed list would: the folding
  // check sees the same effective filters (including a cleared place).
  const foldingInput = skip === 'place'
    ? { ...input, placeLocations: [], placeResolvable: true }
    : { ...input, filters: skipFiltered(input.filters, skip) };
  const folding = foldedOutClause(foldingInput);
  return { clause: `${own.clause}${folding.clause}`, params: [...own.params, ...folding.params] };
}

function skipFiltered(filters: CatalogueFilters, skip: CatalogueSkip): CatalogueFilters {
  if (skip === 'country') return { ...filters, country: 'all' };
  if (skip === 'source') return { ...filters, source: 'all' };
  if (skip === 'application') return { ...filters, application: 'all' };
  if (skip === 'workType') return { ...filters, workType: 'all' };
  return filters;
}

export interface CatalogueCursor {
  sortValue: string;
  id: string;
}

/**
 * Keyset cursor over (sort value, job id), opaque to the client. Separate
 * from the jobs-page codec in lib/paging.ts because the posted sort carries
 * date-only values (`YYYY-MM-DD`) that the jobs codec refuses.
 */
export function encodeCatalogueCursor(sortValue: string, id: string) {
  return `${sortValue}|${id}`;
}

export function decodeCatalogueCursor(raw: string | null): { cursor: CatalogueCursor | null; error: string | null } {
  if (raw === null || raw === '') return { cursor: null, error: null };
  const separator = raw.lastIndexOf('|');
  const sortValue = separator < 0 ? '' : raw.slice(0, separator);
  const id = separator < 0 ? '' : raw.slice(separator + 1);
  if (!sortValue || !id || /[\n\r|]/.test(sortValue) || /[\n\r|]/.test(id)) {
    return { cursor: null, error: 'Cursor is not a value this endpoint returned.' };
  }
  return { cursor: { sortValue, id }, error: null };
}

function orderAndCursor(filters: CatalogueFilters, cursor: CatalogueCursor | null): Clause & { order: string } {
  if (filters.sort === 'posted') {
    const order = `CASE WHEN v.posted_at = '' THEN 1 ELSE 0 END, v.posted_at DESC, s.job_id DESC`;
    if (!cursor) return { clause: '', params: [], order };
    return {
      clause: ` AND ((CASE WHEN v.posted_at = '' THEN 1 ELSE 0 END) > (CASE WHEN ? = '' THEN 1 ELSE 0 END)
        OR ((CASE WHEN v.posted_at = '' THEN 1 ELSE 0 END) = (CASE WHEN ? = '' THEN 1 ELSE 0 END)
          AND (v.posted_at < ? OR (v.posted_at = ? AND s.job_id < ?))))`,
      params: [cursor.sortValue, cursor.sortValue, cursor.sortValue, cursor.sortValue, cursor.id],
      order,
    };
  }
  const order = `s.updated_at DESC, s.job_id DESC`;
  if (!cursor) return { clause: '', params: [], order };
  return {
    clause: ` AND (s.updated_at < ? OR (s.updated_at = ? AND s.job_id < ?))`,
    params: [cursor.sortValue, cursor.sortValue, cursor.id],
    order,
  };
}

function sortValueFor(filters: CatalogueFilters, row: { posted_at: string; state_updated_at: string }) {
  return filters.sort === 'posted' ? row.posted_at : row.state_updated_at;
}

interface CataloguePageRow {
  vacancy_id: string;
  canonical_url: string;
  country: string;
  title: string;
  company: string;
  location: string;
  description: string;
  language_status: string;
  language_summary: string;
  language_signals: string;
  workplace_type: string;
  posted_at: string;
  expires_at: string;
  identity_fingerprint: string;
  job_id: string;
  source_url: string;
  holding_source_key: string;
  holding_source_name: string;
  source_job_id: string;
  duplicate_of: string;
  is_saved: number;
  application_status: string;
  visibility_status: string;
  corrected_status: string;
  corrected_reason: string;
  state_created_at: string;
  state_updated_at: string;
}

// The canonical URL comes from the account's OWN jobs row, never from the shared catalogue
// row (#188). One advertisement posted to a public source and to an administrator-only one
// has the same identity fingerprint, so both copies legitimately fold into a single
// `vacancies` row — and that row keeps whichever copy wrote it. Serving `v.canonical_url`
// therefore handed an ordinary account a `nl.indeed.com` link for a record whose own source
// was `example.com`: the audience gate holds on the record and leaked through its content.
// `j.canonical_url` belongs to the row the account actually holds, and the gate has already
// removed rows it may not see. `jobFromRow` falls back to deriving it from `j.source_url`
// when the column is empty, which is equally the account's own copy.
const PAGE_COLUMNS = `v.id AS vacancy_id, j.canonical_url, v.country, v.title, v.company, v.location,
  v.description, v.language_status, v.language_summary, v.language_signals, v.workplace_type,
  v.posted_at, v.expires_at, v.identity_fingerprint,
  s.job_id, s.is_saved, s.application_status, s.visibility_status,
  s.corrected_status, s.corrected_reason, s.created_at AS state_created_at, s.updated_at AS state_updated_at,
  j.id AS job_id, j.source_url, j.source_key AS holding_source_key, j.source_name AS holding_source_name,
  j.source_job_id, j.duplicate_of`;

export interface CataloguePage {
  jobs: ReturnType<typeof jobFromRow>[];
  nextCursor: string | null;
}

export async function queryCataloguePage(
  db: D1Database,
  input: CatalogueQueryInput,
  cursor: CatalogueCursor | null,
  limit: number,
): Promise<CataloguePage> {
  const where = filteredWhere(input, null);
  const paging = orderAndCursor(input.filters, cursor);
  // One row past the page: whether it exists is what decides nextCursor.
  // Ending exactly on a full page must not send the client after an empty one.
  const probe = limit + 1;
  const rows = await db.prepare(`SELECT ${PAGE_COLUMNS} ${baseFrom(OUTER)}
    WHERE 1 = 1${where.clause}${paging.clause} ORDER BY ${paging.order} LIMIT ?`)
    .bind(input.userId, ...where.params, ...paging.params, probe)
    .all<CataloguePageRow>();
  const hasMore = rows.results.length > limit;
  const page = hasMore ? rows.results.slice(0, limit) : rows.results;
  const jobs = page.map((row) => jobFromRow({
    id: row.job_id,
    source_url: row.source_url,
    canonical_url: row.canonical_url,
    source_key: row.holding_source_key,
    source_name: row.holding_source_name,
    source_job_id: row.source_job_id,
    country: row.country as 'switzerland' | 'netherlands' | 'unknown',
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description,
    language_status: row.language_status as 'pass' | 'unknown' | 'review' | 'blocked',
    language_summary: row.language_summary,
    language_signals: row.language_signals,
    feedback_verdict: row.corrected_status ? 'incorrect' : '',
    feedback_corrected_status: row.corrected_status,
    feedback_reason: row.corrected_reason,
    feedback_updated_at: row.state_updated_at,
    workplace_type: (row.workplace_type || 'unknown') as 'remote' | 'hybrid' | 'onsite' | 'unknown',
    identity_fingerprint: row.identity_fingerprint,
    cluster_key: '',
    duplicate_of: row.duplicate_of,
    is_saved: row.is_saved,
    application_status: row.application_status as 'applied' | 'not_applied',
    visibility_status: row.visibility_status as 'active' | 'dismissed',
    posted_at: row.posted_at,
    expires_at: row.expires_at,
    first_seen_at: row.state_created_at,
    last_seen_at: row.state_updated_at,
    created_at: row.state_created_at,
    updated_at: row.state_updated_at,
  }, input.criteria));
  const lastRow = page[page.length - 1];
  return {
    jobs,
    nextCursor: hasMore && lastRow
      ? encodeCatalogueCursor(sortValueFor(input.filters, lastRow), lastRow.job_id)
      : null,
  };
}

async function countDistinct(db: D1Database, input: CatalogueQueryInput, skip: CatalogueSkip): Promise<number> {
  const where = filteredWhere(input, skip);
  const row = await db.prepare(`SELECT COUNT(DISTINCT v.id) AS total ${baseFrom(OUTER)} WHERE 1 = 1${where.clause}`)
    .bind(input.userId, ...where.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function countTotal(db: D1Database, input: CatalogueQueryInput): Promise<number> {
  // Total ignores result filters but keeps audience + folding: distinct held
  // vacancies, folded copies excluded (the unique-retained notion).
  const audience = audienceClauses(input.audience, 'j');
  const inner = baseFrom(PRIMARY);
  const innerAudience = audienceClauses(input.audience, 'pj');
  const row = await db.prepare(`SELECT COUNT(DISTINCT v.id) AS total ${baseFrom(OUTER)}
    WHERE 1 = 1${audience.clause}
    AND NOT EXISTS (SELECT 1 ${inner} WHERE pj.id = j.duplicate_of AND pj.user_id = ?${innerAudience.clause})`)
    .bind(input.userId, ...audience.params, input.userId, input.userId, ...innerAudience.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function countFolded(db: D1Database, input: CatalogueQueryInput): Promise<number> {
  // Folded copies under the full filters: holdings the folding rule removes,
  // so the card can name them instead of losing them silently.
  const own = filteredOn(input, null, OUTER);
  const foldingAudience = audienceClauses(input.audience, 'pj');
  const view = viewClause(input.filters, 'ps');
  const narrowing = narrowingClauses(input.filters, input.criteria, PRIMARY);
  const facets = facetClauses(input, null, PRIMARY);
  const inner = baseFrom(PRIMARY);
  const row = await db.prepare(`SELECT COUNT(DISTINCT v.id) AS total ${baseFrom(OUTER)}
    WHERE 1 = 1${own.clause}
    AND j.duplicate_of != '' AND EXISTS (SELECT 1 ${inner}
      WHERE pj.id = j.duplicate_of AND pj.user_id = ?${foldingAudience.clause}${view.clause}${narrowing.clause}${facets.clause})`)
    .bind(input.userId, ...own.params, input.userId, input.userId, ...foldingAudience.params,
      ...view.params, ...narrowing.params, ...facets.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export interface CatalogueAggregates {
  total: number;
  matching: number;
  /** Distinct held vacancies before facet narrowing (view+language+keywords+roles applied). */
  inView: number;
  /** Held rows folded into a visible primary under the full filters. */
  folded: number;
  viewCounts: Record<CatalogueView, number>;
  languageCounts: Record<Exclude<CatalogueLanguage, 'all'> | 'all', number>;
  facets: {
    country: { all: number; values: { key: string; count: number }[] };
    source: { all: number; values: { key: string; name: string; count: number }[] };
    application: { all: number; values: { key: string; count: number }[] };
    workType: { all: number; values: { key: string; count: number }[] };
  };
}

async function groupCount(
  db: D1Database,
  input: CatalogueQueryInput,
  skip: CatalogueSkip,
  valueSql: string,
): Promise<{ key: string; count: number }[]> {
  const where = filteredWhere(input, skip);
  const rows = await db.prepare(`SELECT ${valueSql} AS key, COUNT(DISTINCT v.id) AS count
    ${baseFrom(OUTER)} WHERE 1 = 1${where.clause} GROUP BY key ORDER BY key`)
    .bind(input.userId, ...where.params)
    .all<{ key: string | null; count: number }>();
  return rows.results.map((row) => ({ key: row.key ?? '', count: row.count ?? 0 }));
}

async function viewCounts(db: D1Database, input: CatalogueQueryInput): Promise<Record<CatalogueView, number>> {
  const views: CatalogueView[] = ['new', 'all', 'pipeline', 'dismissed'];
  const entries = await Promise.all(views.map(async (view) => {
    const viewInput: CatalogueQueryInput = { ...input, filters: { ...input.filters, view } };
    return [view, await countDistinct(db, viewInput, null)] as const;
  }));
  return Object.fromEntries(entries) as Record<CatalogueView, number>;
}

async function languageCounts(db: D1Database, input: CatalogueQueryInput): Promise<CatalogueAggregates['languageCounts']> {
  const languages: Exclude<CatalogueLanguage, 'all'>[] = ['pass', 'review', 'unknown', 'blocked'];
  const entries = await Promise.all(languages.map(async (language) => {
    const languageInput: CatalogueQueryInput = { ...input, filters: { ...input.filters, language } };
    return [language, await countDistinct(db, languageInput, null)] as const;
  }));
  const all = await countDistinct(db, { ...input, filters: { ...input.filters, language: 'all' } }, null);
  return { ...(Object.fromEntries(entries) as Record<Exclude<CatalogueLanguage, 'all'>, number>), all };
}

export async function queryCatalogueAggregates(db: D1Database, input: CatalogueQueryInput): Promise<CatalogueAggregates> {
  const inViewInput: CatalogueQueryInput = {
    ...input,
    filters: { ...input.filters, country: 'all', source: 'all', application: 'all', workType: 'all', place: 'all' },
    placeLocations: [],
    placeResolvable: true,
  };
  const [total, matching, inView, folded, views, languages, countryGroups, applicationGroups, workTypeGroups, sourceRows] = await Promise.all([
    countTotal(db, input),
    countDistinct(db, input, null),
    countDistinct(db, inViewInput, null),
    countFolded(db, input),
    viewCounts(db, input),
    languageCounts(db, input),
    groupCount(db, input, 'country', 'v.country'),
    groupCount(db, input, 'application', 's.application_status'),
    groupCount(db, input, 'workType', workplaceValue('v')),
    groupCountWithNames(db, input),
  ]);
  return {
    total,
    matching,
    inView,
    folded,
    viewCounts: views,
    languageCounts: languages,
    facets: {
      country: {
        all: countryGroups.reduce((sum, entry) => sum + entry.count, 0),
        values: countryGroups.map((entry) => ({ key: entry.key, count: entry.count })),
      },
      source: {
        all: sourceRows.reduce((sum, entry) => sum + entry.count, 0),
        values: sourceRows,
      },
      application: {
        all: applicationGroups.reduce((sum, entry) => sum + entry.count, 0),
        values: applicationGroups.map((entry) => ({ key: entry.key, count: entry.count })),
      },
      workType: {
        all: workTypeGroups.reduce((sum, entry) => sum + entry.count, 0),
        values: workTypeGroups.map((entry) => ({ key: entry.key || 'unknown', count: entry.count })),
      },
    },
  };
}

async function groupCountWithNames(
  db: D1Database,
  input: CatalogueQueryInput,
): Promise<{ key: string; name: string; count: number }[]> {
  const where = filteredWhere(input, 'source');
  const rows = await db.prepare(`SELECT j.source_key AS key, MAX(j.source_name) AS name, COUNT(DISTINCT v.id) AS count
    ${baseFrom(OUTER)} WHERE 1 = 1${where.clause} GROUP BY key ORDER BY name`)
    .bind(input.userId, ...where.params)
    .all<{ key: string | null; name: string | null; count: number }>();
  return rows.results.map((row) => ({
    key: row.key ?? '',
    name: row.name || row.key || '',
    count: row.count ?? 0,
  }));
}

export interface CataloguePlaceGroup {
  country: string;
  label: string;
  cities: [string, number][];
}

/**
 * Places to narrow by, counted with every other filter applied. Locations are
 * grouped server-side with the same `normalizePlace` rule the client used, so
 * one city is one entry. Location names are facts about postings, not
 * advertisement prose, so they may travel in facet payloads.
 */
export async function queryCataloguePlaces(
  db: D1Database,
  input: CatalogueQueryInput,
): Promise<{ groups: CataloguePlaceGroup[]; locationsByPlace: Map<string, string[]>; all: number }> {
  const where = filteredWhere({ ...input, placeLocations: [], placeResolvable: true }, 'place');
  const rows = await db.prepare(`SELECT v.location AS location, v.country AS country, COUNT(DISTINCT v.id) AS count
    ${baseFrom(OUTER)} WHERE 1 = 1${where.clause} GROUP BY v.location, v.country`)
    .bind(input.userId, ...where.params)
    .all<{ location: string; country: string; count: number }>();
  const byCountry = new Map<string, Map<string, { count: number; locations: string[] }>>();
  let all = 0;
  for (const row of rows.results) {
    const { place } = normalizePlace(row.location);
    if (!place) continue;
    all += row.count;
    const cities = byCountry.get(row.country) ?? new Map<string, { count: number; locations: string[] }>();
    const entry = cities.get(place) ?? { count: 0, locations: [] };
    entry.count += row.count;
    entry.locations.push(row.location);
    cities.set(place, entry);
    byCountry.set(row.country, cities);
  }
  const groups: CataloguePlaceGroup[] = [...byCountry.entries()]
    .sort((a, b) => countryLabel(a[0] as 'switzerland' | 'netherlands' | 'unknown')
      .localeCompare(countryLabel(b[0] as 'switzerland' | 'netherlands' | 'unknown')))
    .map(([country, cities]) => ({
      country,
      label: countryLabel(country as 'switzerland' | 'netherlands' | 'unknown'),
      cities: [...cities.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([place, entry]): [string, number] => [place, entry.count]),
    }));
  const locationsByPlace = new Map<string, string[]>();
  for (const cities of byCountry.values()) {
    for (const [place, entry] of cities) {
      const known = locationsByPlace.get(place) ?? [];
      locationsByPlace.set(place, [...new Set([...known, ...entry.locations])]);
    }
  }
  return { groups, locationsByPlace, all };
}

/**
 * Resolve a requested place to its backing raw locations under every other
 * filter. An unknown or empty place resolves to no filtering; a known place
 * with no locations under the other filters resolves to an honest empty page.
 */
export async function resolvePlaceLocations(
  db: D1Database,
  input: CatalogueQueryInput,
  place: string,
): Promise<{ locations: string[]; resolvable: boolean }> {
  if (!place || place === 'all') return { locations: [], resolvable: true };
  const { locationsByPlace } = await queryCataloguePlaces(db, input);
  const locations = locationsByPlace.get(place);
  if (!locations) {
    // A place the grouping never produced (different country selected, or a
    // crafted value): filter to nothing rather than ignoring the request.
    return { locations: [], resolvable: false };
  }
  return { locations, resolvable: true };
}

export interface CatalogueFreshness {
  /** Newest catalogue sighting across this account's audience-filtered holdings. */
  refreshedAt: string;
  bySource: { sourceKey: string; sourceName: string; country: string; lastSeenAt: string }[];
}

/**
 * Catalogue freshness (ingest side) for the freshness line, kept separate
 * from the user's search events (`search_runs`, served unchanged as
 * `searchRuns`). Provenance windows come from `vacancy_sources` joined to
 * this account's audience-filtered holdings, so ordinary accounts never learn
 * admin-source refresh times. No counts here: how many lives in the facets,
 * when lives here.
 */
export async function queryCatalogueFreshness(
  db: D1Database,
  userId: string,
  audience: CatalogueAudience,
): Promise<CatalogueFreshness> {
  const hidden = audienceClauses(audience, 'j');
  const holdings = `${baseFrom(OUTER)} WHERE 1 = 1${hidden.clause}`;
  const provenance = provenanceClauses(audience);
  const [freshRow, sourceRows] = await Promise.all([
    db.prepare(`SELECT MAX(v.last_seen_at) AS refreshed ${holdings}`)
      .bind(userId, ...hidden.params)
      .first<{ refreshed: string | null }>(),
    db.prepare(`SELECT ps.source_key AS sourceKey, MAX(ps.source_name) AS sourceName,
        MAX(ps.country) AS country, MAX(ps.last_seen_at) AS lastSeenAt
      FROM vacancy_sources ps
      JOIN user_vacancy_state s ON s.vacancy_id = ps.vacancy_id AND s.user_id = ?
      JOIN jobs j ON j.id = s.job_id AND j.user_id = s.user_id
      WHERE 1 = 1${hidden.clause}${provenance.clause}
      GROUP BY ps.source_key ORDER BY sourceName`)
      .bind(userId, ...hidden.params, ...provenance.params)
      .all<{ sourceKey: string; sourceName: string; country: string; lastSeenAt: string }>(),
  ]);
  return {
    refreshedAt: freshRow?.refreshed ?? '',
    bySource: sourceRows.results.map((row) => ({
      sourceKey: row.sourceKey || '',
      sourceName: row.sourceName || row.sourceKey || '',
      country: row.country === 'switzerland' || row.country === 'netherlands' ? row.country : 'unknown',
      lastSeenAt: row.lastSeenAt ?? '',
    })),
  };
}

/**
 * Provenance rows carry their own source key and canonical URL rather than a
 * jobs row, so the audience gate is re-expressed for them: hidden keys plus
 * the Indeed identity (keys and URL patterns, mirroring `indeedSql`, which
 * reads `source_url` — here the column is `canonical_url`).
 */
function provenanceClauses(audience: CatalogueAudience): Clause {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (audience.hiddenSourceKeys.length) {
    parts.push(` AND ps.source_key NOT IN (${audience.hiddenSourceKeys.map(() => '?').join(',')})`);
    params.push(...audience.hiddenSourceKeys);
  }
  if (audience.hideIndeedRecords) {
    parts.push(` AND ps.source_key NOT IN (${INDEED_SOURCE_KEYS.map(() => '?').join(',')})
      AND lower(ps.canonical_url) NOT LIKE '%indeed.%'`);
    params.push(...INDEED_SOURCE_KEYS);
  }
  return { clause: parts.join(''), params };
}

/**
 * Copies folded into each shown primary, for the card's "also on" line.
 * Audience-filtered like everything else: an ordinary account never learns an
 * admin copy exists from its source name. Reads all held copies in one
 * bounded query and intersects in TypeScript instead of an IN list over the
 * page — a page of ids would exceed the bound-parameter limit.
 */
export async function queryCatalogueCopies(
  db: D1Database,
  userId: string,
  audience: CatalogueAudience,
  primaryJobIds: string[],
): Promise<Map<string, string[]>> {
  const copies = new Map<string, string[]>();
  if (!primaryJobIds.length) return copies;
  const wanted = new Set(primaryJobIds);
  const hidden = audienceClauses(audience, 'j2');
  const rows = await db.prepare(`SELECT j2.duplicate_of AS primaryId, j2.source_name AS sourceName
    FROM jobs j2 WHERE j2.user_id = ? AND j2.duplicate_of != ''${hidden.clause}`)
    .bind(userId, ...hidden.params)
    .all<{ primaryId: string; sourceName: string }>();
  for (const row of rows.results) {
    if (!wanted.has(row.primaryId)) continue;
    copies.set(row.primaryId, [...(copies.get(row.primaryId) ?? []), row.sourceName || '']);
  }
  return copies;
}

const FILTER_VALUES: Record<string, readonly string[]> = {
  country: ['all', 'switzerland', 'netherlands'],
  application: ['all', 'applied', 'not_applied'],
  workType: ['all', 'remote', 'hybrid', 'onsite', 'unknown'],
  language: ['pass', 'review', 'unknown', 'blocked', 'all'],
  view: ['new', 'all', 'pipeline', 'dismissed'],
  sort: ['posted', 'found'],
};

/**
 * Read the catalogue result filters off the request. Roles default to the
 * account's saved role keywords (up to five) — the catalogue serves each
 * user's five roles — and explicit repeated `role` params override them
 * (present-but-empty clears the role filter for that request). Anything
 * outside the documented value sets is a 400, never silent narrowing.
 */
export function parseCatalogueFilters(
  params: URLSearchParams,
  criteria: SearchCriteria,
  since: string,
): { filters: CatalogueFilters; error: string | null } {
  for (const name of Object.keys(FILTER_VALUES)) {
    const raw = params.get(name);
    if (raw !== null && !FILTER_VALUES[name].includes(raw.trim())) {
      return { filters: defaultCatalogueFilters(criteria, since), error: `Invalid ${name} filter.` };
    }
  }
  const roleParams = params.getAll('role');
  const roles = roleParams.length
    ? normalizeRoleKeywords(roleParams)
    : normalizeRoleKeywords(criteria.roleKeywords);
  const text = (name: string) => (params.get(name) ?? 'all').trim().slice(0, 160) || 'all';
  return {
    filters: {
      roles,
      country: (params.get('country')?.trim() ?? 'all') as CatalogueFilters['country'],
      place: text('place'),
      source: text('source'),
      application: (params.get('application')?.trim() ?? 'all') as CatalogueFilters['application'],
      workType: (params.get('workType')?.trim() ?? 'all') as CatalogueFilters['workType'],
      language: (params.get('language')?.trim() ?? 'all') as CatalogueFilters['language'],
      view: (params.get('view')?.trim() ?? 'all') as CatalogueFilters['view'],
      sort: (params.get('sort')?.trim() ?? 'found') as CatalogueFilters['sort'],
      since,
    },
    error: null,
  };
}

function defaultCatalogueFilters(criteria: SearchCriteria, since: string): CatalogueFilters {
  return {
    roles: normalizeRoleKeywords(criteria.roleKeywords),
    country: 'all',
    place: 'all',
    source: 'all',
    application: 'all',
    workType: 'all',
    language: 'all',
    view: 'all',
    sort: 'found',
    since,
  };
}
