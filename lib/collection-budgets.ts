/**
 * INT-03 (#162): collection budgets and stop-on-block for the scrape route.
 *
 * One click fans out to every source, so one click must also bound what that fan-out may do:
 * a per-source ceiling on attempted detail imports, a whole-run ceiling across every source,
 * and a per-run refusal record. A source that refuses access — HTTP 401/403/429/451 or an
 * equivalent refusal signal — is marked blocked for the rest of that run: no retry, no proxy
 * rotation, no browser fallback. AGENTS.md forbids detection evasion of any kind, so the
 * absence of those mechanisms here is the requirement, not an omission.
 *
 * This is deliberately per-run and in-memory, following the `rateLimit` windows in
 * lib/guard.ts: it stops this run from hammering a refusing source. A 429 that must survive
 * a restart (durable cooldown) belongs to the coalesced public refresh in INT-06, not to one
 * manually triggered click. The Indeed collector already carries its own pause/cooldown/lease
 * machinery in lib/indeed/collection.ts and is untouched by this module.
 */

/**
 * Page-fetching sources cost one request per job, so they stay tightly capped.
 *
 * This cap is not a performance setting and is not lifted with the others. It limits
 * automated reading of sites whose terms prohibit it (jobs.ch, jobup.ch, JobScout24), and
 * AGENTS.md is explicit: "Do not raise the caps to hit a volume target."
 */
export const MAX_NEW_PER_PAGE_SOURCE = 4;

/**
 * Bulk sources return whole advertisements in the search response, already filtered to this
 * search before anything is capped, so an attempt here is a database write, not a request.
 *
 * Restores the pre-2026-09-14 ceiling of 200: the owner's full-coverage decision lifted it to
 * Infinity while the app runs locally, and INT-03 puts a real number back before any hosted
 * use. Anything past the ceiling stays deferred to the next run and is reported, never
 * silently dropped — see the deferred count on the run report.
 */
export const MAX_NEW_PER_BULK_SOURCE = 200;

/**
 * Whole-run ceiling on attempted detail imports across every source in one click.
 *
 * One search fans out to a dozen sources; without a run ceiling, bulk sources at 200 each
 * could still write thousands of rows per click. This bounds database writes per click the
 * way INDEED_FINAL_BUDGET bounds upstream rows per click (200 per query, 800 whole-run).
 * A maximum, never a target or a coverage guarantee.
 */
export const MAX_NEW_PER_RUN = 800;

/**
 * Whether a thrown fetch error is the source refusing access rather than a transient fault.
 *
 * Refusals (401/403/429/451, forbidden/rate-limited/blocked/challenge wording, the
 * `access_refused`/`rate_limited` reason strings the Indeed client throws) mean "stop asking".
 * Everything else — 5xx, timeouts, network failures, unparseable bodies — stays transient and
 * retryable, matching `isBoardRetryable` in lib/ats-feeds.ts, which retries only those.
 */
export function isAccessRefusal(error: unknown): boolean {
  const holder = error as { status?: unknown; statusCode?: unknown } | null | undefined;
  const status = holder?.status ?? holder?.statusCode;
  if (status === 401 || status === 403 || status === 429 || status === 451) return true;
  const text = (error instanceof Error ? error.message : String(error ?? '')).replaceAll('_', ' ');
  if (/\b(401|403|429|451)\b/.test(text)) return true;
  return /\bforbidden\b|\brate.?limit|\btoo many requests\b|\baccess (refused|denied)\b|\bservice unavailable\b|\bblocked\b|\bchallenge\b|\bcaptcha\b|\blogin required\b|\bsign.?in required\b/i.test(text);
}

/**
 * Per-run budget and refusal state for one scrape. Created fresh for every search; nothing
 * here outlives the click, so a refusal never carries over into the next run.
 */
export class CollectionRunBudgets {
  private attemptedTotal = 0;
  private readonly blockedSources = new Set<string>();

  /**
   * Leave a refusing source alone for the rest of this run. Called exactly where the
   * refusal surfaces — the search catch and the detail-fetch catch in the scrape route —
   * and read back through `allowance` before any further request to that source.
   */
  markBlocked(sourceKey: string): void {
    this.blockedSources.add(sourceKey);
  }

  isBlocked(sourceKey: string): boolean {
    return this.blockedSources.has(sourceKey);
  }

  /**
   * How many more candidates this source may start right now: its own ceiling, the run
   * remainder, or zero when it is blocked or the run ceiling binds. Zero means "defer",
   * never "retry harder".
   */
  allowance(sourceKey: string, isBulk: boolean): number {
    if (this.blockedSources.has(sourceKey)) return 0;
    const remaining = MAX_NEW_PER_RUN - this.attemptedTotal;
    if (remaining <= 0) return 0;
    return Math.min(isBulk ? MAX_NEW_PER_BULK_SOURCE : MAX_NEW_PER_PAGE_SOURCE, remaining);
  }

  /** Record started attempts: one per candidate entered, bulk or page-fetch, since both may write. */
  noteAttempted(count: number): void {
    this.attemptedTotal += count;
  }

  get attempted(): number {
    return this.attemptedTotal;
  }
}
