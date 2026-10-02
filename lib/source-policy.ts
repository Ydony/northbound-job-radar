/**
 * Authoritative per-source audience and permission metadata (INT-01, #160).
 *
 * Every adapter registered in `lib/job-adapters.ts` has exactly one entry here recording:
 * audience (who may use it), policy status (what the site's own rules say about our use),
 * and whether it is currently enabled. This is pure data consolidation: it changes no
 * behaviour. Consumers that enforce the split (public/admin isolation, collection budgets,
 * public refresh) read this registry instead of re-deriving the split from code paths.
 *
 * Sources of truth for each entry, in precedence order:
 * - `docs/SOURCE_POLICY.md` §§2-3 (authoritative; supersedes the older plan's EURES row),
 * - the per-source notes in `AGENTS.md` ("Source integration boundary"),
 * - the §2 table in `docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` (target allocation).
 *
 * Where those disagree, this file follows `docs/SOURCE_POLICY.md` and says so in `basis`.
 * `basis` is mandatory on every entry: a status label without its evidence is how sources
 * silently drift back into the wrong tier.
 *
 * Planned-but-absent sources (UWV/werk.nl, Jooble) deliberately have no entry:
 * there is no adapter for them yet, and `tests/source-policy.test.ts` fails on entries
 * without an adapter as well as adapters without an entry.
 */

/** Who may search this source and receive its jobs, names, counts and run history. */
export type SourceAudience = 'public' | 'admin-only';

/**
 * What the source's own published rules say about this app's use.
 *
 * - `permitted`: an explicitly granted route (published aggregator endpoint, keyed API
 *   used within its terms, public-sector data published for jobseekers with conditions met).
 * - `owner-assumed`: no verified grant; the owner explicitly assumed permission for this
 *   use (recorded separately from evidence — an assumption is not a permission).
 * - `unresolved`: no explicit permission and no prohibition found; honest open question.
 * - `against-terms`: the site's terms or robots policy prohibit this use; retained only
 *   for local administrators at the owner's explicit instruction.
 */
export type SourcePolicyStatus = 'permitted' | 'owner-assumed' | 'unresolved' | 'against-terms';

/**
 * What an administrator may run on the hosted server, without a local computer or VPN step (F4).
 *
 * - `supported`: runs on the host with the same fixed caps, delays and refusal/cooldown
 *   handling as locally. No extra configuration.
 * - `configuration-needed`: runs on the host once the stated credentials are configured;
 *   without them it reports itself unavailable, never silently successful.
 * - `blocked`: must not run on the host. The `hostedBasis` names the exact reason, and the
 *   search reports the source as blocked with that reason rather than omitting it or
 *   claiming success. Lifting a `blocked` row needs an explicit, source-specific owner
 *   decision — never a quiet substitution of a smaller source set.
 *
 * Follows the merged T08/T12/T13 assessments and docs/SOURCE_POLICY.md; anything unresolved
 * there stays gated. The same verdicts are assessed in `lib/hosted-sources.ts` (T13):
 * `tests/hosted-admin-eligibility.test.ts` cross-checks the two so they cannot drift apart.
 */
export type HostedEligibility = 'supported' | 'configuration-needed' | 'blocked';

/** One registry row per adapter key in `jobSourceAdapters`. */
export interface SourcePolicyEntry {
  /** Adapter `key` in `lib/job-adapters.ts`. Unique across the registry. */
  key: string;
  /** `public` sources may serve ordinary accounts; `admin-only` never reaches them. */
  audience: SourceAudience;
  /** Policy standing of our use, per the definitions above. */
  policyStatus: SourcePolicyStatus;
  /** Whether the adapter's `availability` is currently `enabled`. */
  enabled: boolean;
  /** Evidence pointer: decisions, doc sections and dates behind `policyStatus`. Never empty. */
  basis: string;
  /** Whether an administrator may run this source on the hosted server (F4). */
  hosted: HostedEligibility;
  /** Exact reason behind `hosted`: what runs, what is needed, or why it is blocked. Never empty. */
  hostedBasis: string;
}

export const SOURCE_AUDIENCES: readonly SourceAudience[] = ['public', 'admin-only'] as const;
export const SOURCE_POLICY_STATUSES: readonly SourcePolicyStatus[] = [
  'permitted',
  'owner-assumed',
  'unresolved',
  'against-terms',
] as const;
export const HOSTED_ELIGIBILITIES: readonly HostedEligibility[] = [
  'supported',
  'configuration-needed',
  'blocked',
] as const;

/**
 * The registry. One entry per adapter key; kept in the same order as `jobSourceAdapters`
 * so a missing or extra row is obvious in review.
 */
export const SOURCE_POLICY_REGISTRY: readonly SourcePolicyEntry[] = [
  {
    key: 'ats-ch',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Platforms publish these board endpoints specifically for aggregators; no key or login. Advertisement text is employer-owned: screened server-side, never republished (metadata + link only per SOURCE_POLICY.md §1). SOURCE_POLICY.md §2.',
    hosted: 'supported',
    hostedBasis: 'Public bulk API already used without keys or a VPN; runs on the host with the same caps.',
  },
  {
    key: 'ats-nl',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Platforms publish these board endpoints specifically for aggregators; no key or login. Advertisement text is employer-owned: screened server-side, never republished (metadata + link only per SOURCE_POLICY.md §1). SOURCE_POLICY.md §2.',
    hosted: 'supported',
    hostedBasis: 'Public bulk API already used without keys or a VPN; runs on the host with the same caps.',
  },
  {
    key: 'eures-ch',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Public endpoint with ELA attribution as the stated reuse condition (implemented). Advertisement text is employer-owned: screened, not republished. SOURCE_POLICY.md §2, superseding the older plan §2 row.',
    hosted: 'supported',
    hostedBasis: 'Public endpoint, no key, no VPN; runs on the host with the same caps.',
  },
  {
    key: 'eures-nl',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Public endpoint with ELA attribution as the stated reuse condition (implemented). Advertisement text is employer-owned: screened, not republished. SOURCE_POLICY.md §2, superseding the older plan §2 row.',
    hosted: 'supported',
    hostedBasis: 'Public endpoint, no key, no VPN; runs on the host with the same caps.',
  },
  {
    key: 'job-room.ch',
    audience: 'public',
    policyStatus: 'owner-assumed',
    enabled: true,
    basis: 'Unauthenticated public search/detail API of the Swiss public employment service, but no verified grant: permission is an explicit owner assumption (INT-08, #167). Measured as public-sustainable: search reads at most 6 pages of 100 previews per role keyword and stops at the first short page; at most 200 short previews are re-read in full at a fixed 400ms interval (~80s worst case); searches are rate-limited per account (6 per 10min). Metadata + link only per SOURCE_POLICY.md §1. 2026-09-24 probe: an unauthenticated request from a non-local network answered HTTP 400 with a WAF block page, so volume assumes the runtime network the adapter has historically run from; stop on block, never retry. SOURCE_POLICY.md §2; AGENTS.md.',
    hosted: 'supported',
    hostedBasis: 'Unauthenticated public API; runs on the host with the same pacing and stop-on-block handling. A hosted block page would surface as a failed source, never as silent success.',
  },
  {
    key: 'freehire-ch',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Documented public full-description API (GET /agent/jobs/search) used as published: no key, identifying User-Agent sent, paced and capped. Robots.txt and llms.txt invite programmatic use; terms permit documented API use. Measured 2026-09-24: 7,962 open CH adverts, 4,349 English-tagged, 1,137 in the eligible upstream subset. No display/cache/attribution conditions found; advertisement text is employer-owned so screened server-side, never republished (SOURCE_POLICY.md §1). Upstream allowlist is the seven ATS platforms reviewed in §2 (five with verified boards configured, plus Teamtailor and Workable supported with none configured); re-served aggregators and unreviewed boards excluded. Direct redistribution confirmation still outstanding — ask before launch.',
    hosted: 'supported',
    hostedBasis: 'Documented public API used as published with an identifying User-Agent; runs on the host with the same upstream allowlist and caps.',
  },
  {
    key: 'freehire-nl',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Documented public full-description API (GET /agent/jobs/search) used as published: no key, identifying User-Agent sent, paced and capped. Robots.txt and llms.txt invite programmatic use; terms permit documented API use. Measured 2026-09-24: 23,754 open NL adverts, 11,901 English-tagged, 3,482 in the eligible upstream subset. No display/cache/attribution conditions found; advertisement text is employer-owned so screened server-side, never republished (SOURCE_POLICY.md §1). Upstream allowlist is the seven ATS platforms reviewed in §2 (five with verified boards configured, plus Teamtailor and Workable supported with none configured); re-served aggregators and unreviewed boards excluded. Direct redistribution confirmation still outstanding — ask before launch.',
    hosted: 'supported',
    hostedBasis: 'Documented public API used as published with an identifying User-Agent; runs on the host with the same upstream allowlist and caps.',
  },
  {
    key: 'adzuna-ch',
    audience: 'admin-only',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Publisher terms permit listing/research use with a key, but the standard API returns teasers too short to confirm English, so retained as administrator measurement only. Decision 2026-09-09 (#30); SOURCE_POLICY.md §3.',
    hosted: 'configuration-needed',
    hostedBasis: 'Runs on the host only with ADZUNA_APP_ID and ADZUNA_APP_KEY configured; without them it reports unavailable. Teasers remain discovery-only and never confirm English.',
  },
  {
    key: 'adzuna-nl',
    audience: 'admin-only',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Publisher terms permit listing/research use with a key, but the standard API returns teasers too short to confirm English, so retained as administrator measurement only. Decision 2026-09-09 (#30); SOURCE_POLICY.md §3.',
    hosted: 'configuration-needed',
    hostedBasis: 'Runs on the host only with ADZUNA_APP_ID and ADZUNA_APP_KEY configured; without them it reports unavailable. Teasers remain discovery-only and never confirm English.',
  },
  {
    key: 'careerjet-ch',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Publisher key plus declared site, Referer and real user details required; current registration unresolved, so local administrator discovery only with credentials unset in hosted environments. Decision 2026-09-09 (#31); SOURCE_POLICY.md §3.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: the publisher registration binds key, declared site, Referer and the real administrator IP. Leave CAREERJET_API_KEY, CAREERJET_REFERER and CAREERJET_USER_IP unset in hosted environments (#31).',
  },
  {
    key: 'careerjet-nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Publisher key plus declared site, Referer and real user details required; current registration unresolved, so local administrator discovery only with credentials unset in hosted environments. Decision 2026-09-09 (#31); SOURCE_POLICY.md §3.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: the publisher registration binds key, declared site, Referer and the real administrator IP. Leave CAREERJET_API_KEY, CAREERJET_REFERER and CAREERJET_USER_IP unset in hosted environments (#31).',
  },
  {
    key: 'jobs.ch',
    audience: 'admin-only',
    policyStatus: 'against-terms',
    enabled: true,
    basis: 'JobCloud terms prohibit automation and robots.txt disallows the detail pages read. Knowingly against both at the owner\'s explicit instruction; local administrator + VPN only, manual, capped, fixed delay. AGENTS.md; SOURCE_POLICY.md §3.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: JobCloud terms prohibit automation and the VPN boundary cannot be met there. Local administrator + VPN only; no hosted exception has been approved — lifting this needs an explicit owner decision, not a quieter source set.',
  },
  {
    key: 'jobup.ch',
    audience: 'admin-only',
    policyStatus: 'against-terms',
    enabled: true,
    basis: 'JobCloud property: same terms prohibition (its robots.txt does not disallow the detail pages). Administrator + VPN only. Portfolio retained 2026-09-09 (#32); AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: JobCloud terms prohibit automation and the VPN boundary cannot be met there. Local administrator + VPN only; no hosted exception has been approved.',
  },
  {
    key: 'jobscout24.ch',
    audience: 'admin-only',
    policyStatus: 'against-terms',
    enabled: true,
    basis: 'JobCloud property: same terms prohibition (its robots.txt does not disallow the detail pages). Kept on probation sharing the JobCloud adapter and VPN boundary. Decision 2026-09-09 (#32); AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: same JobCloud terms prohibition and VPN boundary as jobup.ch; probationary source with no hosted exception approved.',
  },
  {
    key: 'iamexpat.nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Career paths read are outside the robots.txt disallow list and the published crawl delay is honoured, but there is no explicit permission. Administrator only; no VPN required. Decision 2026-09-09 (#32); AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host pending a terms review: the career paths read sit outside the robots.txt disallow list and the published crawl delay is honoured, but there is no explicit permission and the general site terms are unreviewed. Retained for local administrators only; no VPN is required locally, which is not the same as hosted clearance.',
  },
  {
    key: 'undutchables.nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Plain listing/detail paths permitted by robots.txt; query-string searches disallowed and unused. Previously returned HTTP 403 to automation, so precautionary VPN gate stays. Administrator only. Decision 2026-09-09 (#32); AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: precautionary VPN gate stays after the site previously returned HTTP 403 to automation. Local administrator + VPN only; no hosted exception has been approved.',
  },
  {
    key: 'indeed-ch',
    audience: 'admin-only',
    policyStatus: 'owner-assumed',
    enabled: false,
    basis: 'Terms prohibit automated access without written permission; the owner reports holding authorisation for their own local assessment, which is unverified here. Disabled by default; loopback administrator experiment only. #63; SOURCE_POLICY.md §3; AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: the owner-reported authorisation covers one administrator reading Indeed locally over loopback only. A source-specific decision is required before any hosted implementation; the local experiment is never silently generalized.',
  },
  {
    key: 'indeed-nl',
    audience: 'admin-only',
    policyStatus: 'owner-assumed',
    enabled: false,
    basis: 'Terms prohibit automated access without written permission; the owner reports holding authorisation for their own local assessment, which is unverified here. Disabled by default; loopback administrator experiment only. #63; SOURCE_POLICY.md §3; AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: the owner-reported authorisation covers one administrator reading Indeed locally over loopback only. A source-specific decision is required before any hosted implementation; the local experiment is never silently generalized.',
  },
  {
    key: 'nationalevacaturebank.nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: false,
    basis: 'Automated access returned HTTP 403 and no authorized feed is configured. Not searched; kept out of ordinary responses by the restricted gate. AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: automated access returned HTTP 403 and no authorized feed is configured.',
  },
  {
    key: 'iamsterdam.com',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: false,
    basis: 'A city guide, not a vacancy feed. Never searched; kept out of ordinary responses by the restricted gate. AGENTS.md.',
    hosted: 'blocked',
    hostedBasis: 'Blocked on the host: a city guide, not a vacancy feed — never searched anywhere.',
  },
];

/** The registry entry for an adapter key, or `undefined` when the key has none. */
export function sourcePolicyFor(adapterKey: string): SourcePolicyEntry | undefined {
  return SOURCE_POLICY_REGISTRY.find((entry) => entry.key === adapterKey);
}

/** Adapter keys whose results ordinary accounts may receive. */
export function publicSourceKeys(): string[] {
  return SOURCE_POLICY_REGISTRY.filter((entry) => entry.audience === 'public').map((entry) => entry.key);
}

/** Adapter keys withheld from ordinary accounts (names, jobs, counts, run history). */
export function adminOnlySourcePolicyKeys(): string[] {
  return SOURCE_POLICY_REGISTRY.filter((entry) => entry.audience === 'admin-only').map((entry) => entry.key);
}

/** The hosted decision for an adapter key, or `undefined` when the key has none. */
export function hostedEligibilityFor(adapterKey: string): SourcePolicyEntry | undefined {
  return sourcePolicyFor(adapterKey);
}

/**
 * Adapter keys an administrator may run on the hosted server: `supported` outright,
 * `configuration-needed` once the stated credentials exist. `blocked` keys are excluded.
 */
export function hostedRunnableKeys(): string[] {
  return SOURCE_POLICY_REGISTRY.filter((entry) => entry.hosted !== 'blocked').map((entry) => entry.key);
}

/** Adapter keys that must report themselves blocked on the host, with their exact reason. */
export function hostedBlockedKeys(): string[] {
  return SOURCE_POLICY_REGISTRY.filter((entry) => entry.hosted === 'blocked').map((entry) => entry.key);
}

/** Minimal adapter shape the hosted/VPN gate needs — avoids a `job-adapters` import cycle. */
export interface HostedGateAdapter {
  key: string;
  access: string;
  availabilityMessage: string;
}

export interface HostedGateContext {
  loopback: boolean;
  vpnEnforced: boolean;
}

/**
 * Per-source hosted/VPN gate (F4, T14). Returns the truthful blocked message when this
 * source must not be contacted on this run, or null when it may run.
 *
 * - `restricted` + no VPN: blocked everywhere. Locally the message names the launcher;
 *   on the host it names the registry reason (no hosted exception approved). The scrape
 *   route's wholesale T15 refusal normally fires first for mode `all` without a VPN; this
 *   arm states the same rule per source so the matrix stays complete whatever calls it.
 * - `hosted === 'blocked'` on a non-loopback host: blocked with the exact registry
 *   reason, on its own merit. This covers every hosted-ineligible source — including
 *   grey-area admin-only rows like IamExpat that are neither `restricted` nor keyed —
 *   so a future hosted-blocked source can never slip through because it was not named
 *   here. The local experimental exceptions (IP-bound Careerjet registration,
 *   loopback-only Indeed authorisation) are never silently generalized to hosted
 *   production.
 * - Everything else: runnable under the existing caps, delays and refusal handling,
 *   which are unchanged. A missing key still reports unavailable, never success.
 *
 * Pure function over the registry: `app/api/scrape/route.ts` calls it per source,
 * and `tests/hosted-admin-eligibility.test.ts` pins the matrix on real adapters.
 */
export function hostedBlockReason(
  adapter: HostedGateAdapter,
  context: HostedGateContext,
): string | null {
  const { loopback, vpnEnforced } = context;
  if (adapter.access === 'restricted' && !vpnEnforced) {
    if (loopback) {
      return 'Start the app with "npm run dev:private" first. That checks for a full VPN route before these sources will run.';
    }
    return hostedEligibilityFor(adapter.key)?.hostedBasis ?? adapter.availabilityMessage;
  }
  if (!loopback && hostedEligibilityFor(adapter.key)?.hosted === 'blocked') {
    return hostedEligibilityFor(adapter.key)!.hostedBasis;
  }
  return null;
}
