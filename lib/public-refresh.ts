/**
 * INT-06 (#165): bounded scheduled refresh of the public catalogue.
 *
 * The Search button must query the catalogue and show its last-refresh time, not
 * fan out to every upstream source per visitor (plan §3). This module is the
 * collector side of that split: per-source locks, resume cursors, freshness
 * timestamps, durable cooldowns and a single coalesced refresh queue — all
 * persisted in D1 so a worker restart neither multiplies requests nor forgets
 * that a source refused access.
 *
 * Eligibility comes from INT-01's registry (`lib/source-policy.ts`): only
 * public-audience, enabled sources are ever refreshed here. Admin-only adapters
 * are unreachable from this path by construction — upstream fetchers are
 * injected by the caller, keys outside the eligible set are never called (they
 * are reported as ignored), and this module never imports `lib/job-adapters.ts`
 * (pinned by test). INT-12 owns the admin side; INT-05 owns catalogue
 * queries and will consume `publicRefreshFreshness()` plus
 * `requestCoalescedRefresh()` without this module touching query routes.
 *
 * Refusal semantics follow the plan §4 and extend INT-03's per-run budgets with
 * durability (the deferred INT-03 follow-up, implemented here):
 * - HTTP 429 persists a cooldown across restarts and honors `Retry-After`;
 * - 401/403/451 or a challenge pauses the source until operator review;
 * - transient 5xx/network faults get bounded retries only, then a failure count;
 * - concurrent runs never duplicate upstream calls: the second run sees the
 *   lease and reports `busy` instead of fetching.
 *
 * Timing is fixed, never randomized: AGENTS.md forbids detection evasion, and
 * jitter would be exactly that kind of disguise. The retry pause is one constant.
 */

import { isAccessRefusal } from './collection-budgets';
import { SOURCE_POLICY_REGISTRY } from './source-policy';

/** Refresh cadence: one bounded pass per window per source (provisional — the plan
 * requires measuring collection costs at sample size before fixing a frequency). */
export const PUBLIC_REFRESH_WINDOW_MS = 6 * 3_600_000;

/** How long one run's claim on a source lasts. A crash keeps the lease; expiry
 * bounds the damage, mirroring the Indeed lease in lib/indeed/collection.ts. */
export const PUBLIC_REFRESH_LEASE_MS = 300_000;

/** Transient 5xx/network faults are retried this many times, then recorded as a
 * failure. Refusals (429/401/403/challenge) are never retried. */
export const PUBLIC_REFRESH_MAX_RETRIES = 2;

/** Fixed pause between transient retries. A constant, not jitter. */
export const PUBLIC_REFRESH_RETRY_DELAY_MS = 1_000;

/** Cooldown written when a source rate-limits without a usable `Retry-After`. */
export const PUBLIC_REFRESH_DEFAULT_COOLDOWN_MS = 60_000;

/** Cloudflare Cron Trigger schedule for the prod worker (config only — the actual
 * deploy is owner-supervised and out of scope). Provisional until collection
 * costs are measured; see the plan §4. */
export const PUBLIC_REFRESH_CRON = '0 */6 * * *';

/** Keys this refresh may ever touch: public audience and currently enabled.
 * Derived from the registry on every run so a promotion/demotion or a disable
 * takes effect without a second list to drift. */
export function publicRefreshEligibleKeys(): string[] {
  return SOURCE_POLICY_REGISTRY.filter((entry) => entry.audience === 'public' && entry.enabled)
    .map((entry) => entry.key);
}

/** One normalized advert as far as the collector is concerned. Screening and
 * catalogue writes belong to the INT-05 seam; the refresh counts and carries
 * batches without interpreting them. */
export interface PublicRefreshAdvert {
  sourceUrl: string;
  title: string;
}

/**
 * One worker-sized batch from a source: the adverts found plus the cursor to
 * resume from (`''` when the source is exhausted). Each fetcher performs a
 * bounded amount of upstream work per call; the refresh never pages a source
 * to exhaustion inside one tick.
 */
export interface PublicRefreshBatch {
  adverts: PublicRefreshAdvert[];
  nextCursor: string;
}

export type PublicRefreshFetch = (cursor: string) => Promise<PublicRefreshBatch>;

export type PublicRefreshStatus =
  | 'complete'
  | 'fresh'
  | 'busy'
  | 'paused'
  | 'cooldown'
  | 'failed'
  | 'unavailable';

export interface PublicRefreshSourceResult {
  sourceKey: string;
  status: PublicRefreshStatus;
  /** Adverts carried by this tick's batch (0 unless complete). */
  advertCount: number;
  /** Cursor persisted for the next tick. */
  cursor: string;
  /** Seconds until the cooldown ends (cooldown only). */
  retryAfterSeconds: number;
  message: string;
}

export interface PublicRefreshReport {
  results: PublicRefreshSourceResult[];
  /** Fetcher keys outside the eligible set: never called, reported here. */
  ignoredKeys: string[];
}

export interface PublicRefreshFreshness {
  sourceKey: string;
  lastSuccess: string;
  stale: boolean;
  paused: boolean;
  retryAfterSeconds: number;
}

export type CoalescedRefreshDecision =
  | 'queued'
  | 'already-queued'
  | 'running'
  | 'fresh';

export interface PublicRefreshOptions {
  now?: number;
  windowMs?: number;
  leaseMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  defaultCooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with each completed batch; item persistence is the INT-05 seam. */
  onBatch?: (sourceKey: string, batch: PublicRefreshBatch) => void | Promise<void>;
}

/** Structured refusal a fetcher throws when the upstream answers with a status
 * the collector must honor durably. Plain `fetch()` callers lose headers, so
 * the scheduler maps them into this shape at the boundary. */
export function upstreamRefusal(status: number, retryAfterSeconds?: number): Error {
  const error = new Error(`Upstream request failed (${status}).`) as Error & {
    status: number;
    retryAfterSeconds?: number;
  };
  error.status = status;
  if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

type UpstreamFate =
  | { fate: 'cooldown'; retryAfterSeconds?: number }
  | { fate: 'paused' }
  | { fate: 'transient' };

/**
 * Classify a fetch failure. Order matters: a numeric 5xx is transient even when
 * its message contains refusal wording ("Service Unavailable"), because the
 * plan retries transient 5xx boundedly and only pauses on genuine access
 * refusals. 429/rate-limit wording cools down; 401/403/451, forbidden and
 * challenge/captcha wording pauses.
 */
export function classifyUpstreamError(error: unknown): UpstreamFate {
  const holder = error as { status?: unknown; statusCode?: unknown; retryAfterSeconds?: unknown } | null | undefined;
  const rawStatus = holder?.status ?? holder?.statusCode;
  const status = typeof rawStatus === 'number' ? rawStatus : null;
  if (status !== null && status >= 500 && status <= 599) return { fate: 'transient' };
  const retryAfterSeconds = typeof holder?.retryAfterSeconds === 'number' && holder.retryAfterSeconds >= 0
    ? holder.retryAfterSeconds
    : parseRetryAfter(error instanceof Error ? error.message : String(error ?? ''));
  if (status === 429) return { fate: 'cooldown', retryAfterSeconds };
  const text = (error instanceof Error ? error.message : String(error ?? '')).replaceAll('_', ' ');
  if (/\brate.?limit|\btoo many requests\b|\b429\b/.test(text)) return { fate: 'cooldown', retryAfterSeconds };
  if (status === 401 || status === 403 || status === 451) return { fate: 'paused' };
  if (/\b(401|403|451)\b/.test(text)
    || /\bforbidden\b|\baccess (refused|denied)\b|\bchallenge\b|\bcaptcha\b|\blogin required\b|\bsign.?in required\b/i.test(text)) {
    return { fate: 'paused' };
  }
  // A bare 5xx message with no status ("Service Unavailable") is a transient
  // fault, not a refusal: INT-03's classifier reads that wording as a refusal,
  // but the refresh must retry transient 5xx boundedly and only pause on
  // genuine access refusals.
  if (/\bservice unavailable\b/i.test(text)) return { fate: 'transient' };
  if (isAccessRefusal(error)) return { fate: 'paused' };
  return { fate: 'transient' };
}

function parseRetryAfter(text: string): number | undefined {
  const match = text.match(/retry.?after[:\s]+(\d+)/i);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

interface RefreshStateRow {
  source_key: string;
  paused: number;
  cooldown_until: number;
  lease_token: string;
  lease_until: number;
  cursor: string;
  last_success: string;
  last_attempt: string;
  consecutive_failures: number;
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

async function ensureRefreshRow(db: D1Database, sourceKey: string, updatedAt: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO public_refresh_state (source_key, updated_at) VALUES (?, ?)')
    .bind(sourceKey, updatedAt).run();
}

async function readRefreshRow(db: D1Database, sourceKey: string): Promise<RefreshStateRow | null> {
  const row = await db.prepare(`SELECT source_key, paused, cooldown_until, lease_token, lease_until,
      cursor, last_success, last_attempt, consecutive_failures
    FROM public_refresh_state WHERE source_key = ?`).bind(sourceKey).first<RefreshStateRow>();
  return row ?? null;
}

/**
 * Claim a source for this run. One conditional UPDATE is the whole lock: the
 * claim lands only when no live lease, pause or cooldown stands in the way, so
 * identical concurrent runs cannot both fetch. Returns the lease token, or ''
 * when the source is already held (the caller reports `busy`).
 */
async function acquireRefreshLease(
  db: D1Database,
  sourceKey: string,
  now: number,
  leaseMs: number,
  token: string,
): Promise<string> {
  const outcome = await db.prepare(`UPDATE public_refresh_state
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE source_key = ? AND lease_until <= ? AND paused = 0 AND cooldown_until <= ?`)
    .bind(token, now + leaseMs, nowIso(now), sourceKey, now, now).run();
  return outcome.meta.changes ? token : '';
}

async function releaseRefreshLease(
  db: D1Database,
  sourceKey: string,
  token: string,
  updates: { cursor?: string; lastSuccess?: string; failures?: number; paused?: boolean; cooldownUntil?: number },
  now: number,
): Promise<void> {
  const current = await readRefreshRow(db, sourceKey);
  // Only the holder releases: a crashed run's expired lease may already belong
  // to someone else, and clearing that would break the lock.
  if (!current || current.lease_token !== token) return;
  const cursor = updates.cursor ?? current.cursor;
  const failures = updates.failures ?? current.consecutive_failures;
  await db.prepare(`UPDATE public_refresh_state SET cursor = ?, last_success = ?,
      last_attempt = ?, consecutive_failures = ?, paused = ?, cooldown_until = ?,
      lease_token = '', lease_until = 0, updated_at = ? WHERE source_key = ?`)
    .bind(cursor, updates.lastSuccess ?? current.last_success, nowIso(now), failures,
      updates.paused ? 1 : current.paused, updates.cooldownUntil ?? current.cooldown_until,
      nowIso(now), sourceKey).run();
}

function freshSince(lastSuccess: string, now: number, windowMs: number): boolean {
  const seen = Date.parse(lastSuccess);
  return Number.isFinite(seen) && now - seen < windowMs;
}

/**
 * Run one bounded pass over every eligible public source. Each source costs at
 * most one fetcher batch per pass (plus bounded transient retries); refusals
 * persist their cooldown or pause; a held lease reports `busy` without any
 * upstream call. Fetcher keys outside the eligible set are ignored, never called.
 */
export async function runPublicRefresh(
  db: D1Database,
  fetchers: Record<string, PublicRefreshFetch>,
  options: PublicRefreshOptions = {},
): Promise<PublicRefreshReport> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? PUBLIC_REFRESH_WINDOW_MS;
  const leaseMs = options.leaseMs ?? PUBLIC_REFRESH_LEASE_MS;
  const maxRetries = options.maxRetries ?? PUBLIC_REFRESH_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? PUBLIC_REFRESH_RETRY_DELAY_MS;
  const defaultCooldownMs = options.defaultCooldownMs ?? PUBLIC_REFRESH_DEFAULT_COOLDOWN_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));

  const eligible = publicRefreshEligibleKeys();
  const eligibleSet = new Set(eligible);
  const ignoredKeys = Object.keys(fetchers).filter((key) => !eligibleSet.has(key)).sort();
  const results: PublicRefreshSourceResult[] = [];

  for (const sourceKey of eligible) {
    await ensureRefreshRow(db, sourceKey, nowIso(now));
    const state = (await readRefreshRow(db, sourceKey))!;
    const fetcher = fetchers[sourceKey];
    if (!fetcher) {
      results.push({ sourceKey, status: 'unavailable', advertCount: 0, cursor: state.cursor,
        retryAfterSeconds: 0, message: 'No fetcher is wired for this source yet, so it was not contacted.' });
      continue;
    }
    if (state.paused) {
      results.push({ sourceKey, status: 'paused', advertCount: 0, cursor: state.cursor,
        retryAfterSeconds: 0, message: 'The source refused access and stays paused until an operator reviews it.' });
      continue;
    }
    if (state.cooldown_until > now) {
      const retryAfterSeconds = Math.max(0, Math.ceil((state.cooldown_until - now) / 1000));
      results.push({ sourceKey, status: 'cooldown', advertCount: 0, cursor: state.cursor,
        retryAfterSeconds, message: `Rate-limited: no request for another ${retryAfterSeconds} seconds.` });
      continue;
    }
    if (freshSince(state.last_success, now, windowMs)) {
      results.push({ sourceKey, status: 'fresh', advertCount: 0, cursor: state.cursor,
        retryAfterSeconds: 0, message: `Refreshed within the window (last success ${state.last_success}); no request sent.` });
      continue;
    }
    const token = `${now}-${sourceKey}-${crypto.randomUUID()}`;
    const lease = await acquireRefreshLease(db, sourceKey, now, leaseMs, token);
    if (!lease) {
      const current = (await readRefreshRow(db, sourceKey))!;
      results.push({ sourceKey, status: 'busy', advertCount: 0, cursor: current.cursor,
        retryAfterSeconds: 0, message: 'Another refresh holds this source; this run attached instead of duplicating its requests.' });
      continue;
    }

    let batch: PublicRefreshBatch | null = null;
    let attempts = 0;
    let terminal: 'complete' | 'failed' | 'paused' | 'cooldown' = 'failed';
    let retryAfterSeconds = 0;
    let message = '';
    // Bounded retries for transient faults only. A refusal classifies out of
    // the loop on its first occurrence: no retry, no workaround.
    for (;;) {
      attempts += 1;
      try {
        batch = await fetcher(state.cursor);
        terminal = 'complete';
        break;
      } catch (error) {
        const fate = classifyUpstreamError(error);
        if (fate.fate === 'cooldown') {
          terminal = 'cooldown';
          retryAfterSeconds = fate.retryAfterSeconds ?? Math.ceil(defaultCooldownMs / 1000);
          message = `The source rate-limited this run; cooling down for ${retryAfterSeconds} seconds across restarts.`;
          break;
        }
        if (fate.fate === 'paused') {
          terminal = 'paused';
          const detail = error instanceof Error ? error.message : String(error ?? '');
          message = `${detail} The source refused access, so it is paused until an operator reviews it: no retry, no workaround.`;
          break;
        }
        if (attempts > maxRetries) {
          const detail = error instanceof Error ? error.message : String(error ?? 'Source request failed.');
          message = `${detail} Transient failure after ${attempts} attempts; kept for the next pass, never paused.`;
          break;
        }
        await sleep(retryDelayMs);
      }
    }

    if (terminal === 'complete' && batch) {
      await releaseRefreshLease(db, sourceKey, lease,
        { cursor: batch.nextCursor, lastSuccess: nowIso(now), failures: 0 }, now);
      if (options.onBatch) await options.onBatch(sourceKey, batch);
      results.push({ sourceKey, status: 'complete', advertCount: batch.adverts.length,
        cursor: batch.nextCursor, retryAfterSeconds: 0,
        message: `${batch.adverts.length} advert(s) carried; resume cursor persisted for the next pass.` });
    } else if (terminal === 'cooldown') {
      await releaseRefreshLease(db, sourceKey, lease,
        { cooldownUntil: now + retryAfterSeconds * 1000 }, now);
      results.push({ sourceKey, status: 'cooldown', advertCount: 0, cursor: state.cursor,
        retryAfterSeconds, message });
    } else if (terminal === 'paused') {
      await releaseRefreshLease(db, sourceKey, lease, { paused: true }, now);
      results.push({ sourceKey, status: 'paused', advertCount: 0, cursor: state.cursor,
        retryAfterSeconds: 0, message });
    } else {
      await releaseRefreshLease(db, sourceKey, lease, { failures: state.consecutive_failures + 1 }, now);
      results.push({ sourceKey, status: 'failed', advertCount: 0, cursor: state.cursor,
        retryAfterSeconds: 0, message });
    }
  }
  return { results, ignoredKeys };
}

/**
 * Freshness disclosure for INT-05's catalogue reads: the last successful
 * refresh per eligible source, whether it is stale, paused or cooling down.
 * This is what the Search button shows next to its catalogue counts.
 */
export async function publicRefreshFreshness(
  db: D1Database,
  options: { now?: number; windowMs?: number } = {},
): Promise<PublicRefreshFreshness[]> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? PUBLIC_REFRESH_WINDOW_MS;
  const rows: PublicRefreshFreshness[] = [];
  for (const sourceKey of publicRefreshEligibleKeys()) {
    const state = await readRefreshRow(db, sourceKey);
    rows.push({
      sourceKey,
      lastSuccess: state?.last_success ?? '',
      stale: !state || !freshSince(state.last_success, now, windowMs),
      paused: (state?.paused ?? 0) !== 0,
      retryAfterSeconds: state && state.cooldown_until > now
        ? Math.max(0, Math.ceil((state.cooldown_until - now) / 1000))
        : 0,
    });
  }
  return rows;
}

async function anyRefreshLeaseHeld(db: D1Database, now: number): Promise<boolean> {
  const row = await db.prepare('SELECT source_key FROM public_refresh_state WHERE lease_until > ? LIMIT 1')
    .bind(now).first<{ source_key: string }>();
  return Boolean(row);
}

/**
 * Queue one coalesced refresh for an expired catalogue. Never one per visitor:
 * a held lease reports `running` (attach, don't duplicate), an existing queue
 * row reports `already-queued`, and a fresh catalogue reports `fresh` without
 * queueing anything. Only staleness queues, and only once. INT-05 calls this
 * from the search path; the cron handler (or an operator) claims the queue.
 */
export async function requestCoalescedRefresh(
  db: D1Database,
  options: { now?: number; windowMs?: number } = {},
): Promise<CoalescedRefreshDecision> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? PUBLIC_REFRESH_WINDOW_MS;
  if (await anyRefreshLeaseHeld(db, now)) return 'running';
  const queued = await db.prepare("SELECT id FROM public_refresh_queue WHERE id = 'global' AND status = 'queued'")
    .first<{ id: string }>();
  if (queued) return 'already-queued';
  const freshness = await publicRefreshFreshness(db, { now, windowMs });
  const stale = freshness.filter((entry) => entry.stale && !entry.paused && entry.retryAfterSeconds <= 0);
  if (!stale.length) return 'fresh';
  const stamp = nowIso(now);
  await db.prepare(`INSERT INTO public_refresh_queue (id, status, requested_at, updated_at)
    VALUES ('global', 'queued', ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'queued', requested_at = excluded.requested_at, updated_at = excluded.updated_at`)
    .bind(stamp, stamp).run();
  return 'queued';
}

/**
 * Atomically claim a queued refresh. Exactly one claimant wins; the rest see
 * `false` and must not run. The runner clears the queue when done.
 */
export async function claimQueuedRefresh(db: D1Database): Promise<boolean> {
  const outcome = await db.prepare("UPDATE public_refresh_queue SET status = 'running', updated_at = ? WHERE id = 'global' AND status = 'queued'")
    .bind(nowIso(Date.now())).run();
  return outcome.meta.changes > 0;
}

/** Clear the queue after a claimed run finishes, whatever its outcome. */
export async function clearQueuedRefresh(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM public_refresh_queue WHERE id = 'global'").run();
}
