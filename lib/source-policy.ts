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
 * Planned-but-absent sources (UWV/werk.nl, FreeHire, Jooble) deliberately have no entry:
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
}

export const SOURCE_AUDIENCES: readonly SourceAudience[] = ['public', 'admin-only'] as const;
export const SOURCE_POLICY_STATUSES: readonly SourcePolicyStatus[] = [
  'permitted',
  'owner-assumed',
  'unresolved',
  'against-terms',
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
    basis: 'Platforms publish these board endpoints specifically for aggregators; no key or login. SOURCE_POLICY.md §2.',
  },
  {
    key: 'ats-nl',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Platforms publish these board endpoints specifically for aggregators; no key or login. SOURCE_POLICY.md §2.',
  },
  {
    key: 'eures-ch',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Public endpoint with ELA attribution as the stated reuse condition (implemented). Advertisement text is employer-owned: screened, not republished. SOURCE_POLICY.md §2, superseding the older plan §2 row.',
  },
  {
    key: 'eures-nl',
    audience: 'public',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Public endpoint with ELA attribution as the stated reuse condition (implemented). Advertisement text is employer-owned: screened, not republished. SOURCE_POLICY.md §2, superseding the older plan §2 row.',
  },
  {
    key: 'job-room.ch',
    audience: 'public',
    policyStatus: 'owner-assumed',
    enabled: true,
    basis: 'Unauthenticated public search/detail API of the Swiss public employment service, but no verified grant: permission is an explicit owner assumption (INT-08, #167). Measured as public-sustainable: search reads at most 6 pages of 100 previews per role keyword and stops at the first short page; at most 200 short previews are re-read in full at a fixed 400ms interval (~80s worst case); searches are rate-limited per account (6 per 10min). Metadata + link only per SOURCE_POLICY.md §1. 2026-09-24 probe: an unauthenticated request from a non-local network answered HTTP 400 with a WAF block page, so volume assumes the runtime network the adapter has historically run from; stop on block, never retry. SOURCE_POLICY.md §2; AGENTS.md.',
  },
  {
    key: 'adzuna-ch',
    audience: 'admin-only',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Publisher terms permit listing/research use with a key, but the standard API returns teasers too short to confirm English, so retained as administrator measurement only. Decision 2026-09-09 (#30); SOURCE_POLICY.md §3.',
  },
  {
    key: 'adzuna-nl',
    audience: 'admin-only',
    policyStatus: 'permitted',
    enabled: true,
    basis: 'Publisher terms permit listing/research use with a key, but the standard API returns teasers too short to confirm English, so retained as administrator measurement only. Decision 2026-09-09 (#30); SOURCE_POLICY.md §3.',
  },
  {
    key: 'careerjet-ch',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Publisher key plus declared site, Referer and real user details required; current registration unresolved, so local administrator discovery only with credentials unset in hosted environments. Decision 2026-09-09 (#31); SOURCE_POLICY.md §3.',
  },
  {
    key: 'careerjet-nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Publisher key plus declared site, Referer and real user details required; current registration unresolved, so local administrator discovery only with credentials unset in hosted environments. Decision 2026-09-09 (#31); SOURCE_POLICY.md §3.',
  },
  {
    key: 'jobs.ch',
    audience: 'admin-only',
    policyStatus: 'against-terms',
    enabled: true,
    basis: 'JobCloud terms prohibit automation and robots.txt disallows the detail pages read. Knowingly against both at the owner\'s explicit instruction; local administrator + VPN only, manual, capped, fixed delay. AGENTS.md; SOURCE_POLICY.md §3.',
  },
  {
    key: 'jobup.ch',
    audience: 'admin-only',
    policyStatus: 'against-terms',
    enabled: true,
    basis: 'JobCloud property: same terms prohibition (its robots.txt does not disallow the detail pages). Administrator + VPN only. Portfolio retained 2026-09-09 (#32); AGENTS.md.',
  },
  {
    key: 'jobscout24.ch',
    audience: 'admin-only',
    policyStatus: 'against-terms',
    enabled: true,
    basis: 'JobCloud property: same terms prohibition (its robots.txt does not disallow the detail pages). Kept on probation sharing the JobCloud adapter and VPN boundary. Decision 2026-09-09 (#32); AGENTS.md.',
  },
  {
    key: 'iamexpat.nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Career paths read are outside the robots.txt disallow list and the published crawl delay is honoured, but there is no explicit permission. Administrator only; no VPN required. Decision 2026-09-09 (#32); AGENTS.md.',
  },
  {
    key: 'undutchables.nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: true,
    basis: 'Plain listing/detail paths permitted by robots.txt; query-string searches disallowed and unused. Previously returned HTTP 403 to automation, so precautionary VPN gate stays. Administrator only. Decision 2026-09-09 (#32); AGENTS.md.',
  },
  {
    key: 'indeed-ch',
    audience: 'admin-only',
    policyStatus: 'owner-assumed',
    enabled: false,
    basis: 'Terms prohibit automated access without written permission; the owner reports holding authorisation for their own local assessment, which is unverified here. Disabled by default; loopback administrator experiment only. #63; SOURCE_POLICY.md §3; AGENTS.md.',
  },
  {
    key: 'indeed-nl',
    audience: 'admin-only',
    policyStatus: 'owner-assumed',
    enabled: false,
    basis: 'Terms prohibit automated access without written permission; the owner reports holding authorisation for their own local assessment, which is unverified here. Disabled by default; loopback administrator experiment only. #63; SOURCE_POLICY.md §3; AGENTS.md.',
  },
  {
    key: 'nationalevacaturebank.nl',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: false,
    basis: 'Automated access returned HTTP 403 and no authorized feed is configured. Not searched; kept out of ordinary responses by the restricted gate. AGENTS.md.',
  },
  {
    key: 'iamsterdam.com',
    audience: 'admin-only',
    policyStatus: 'unresolved',
    enabled: false,
    basis: 'A city guide, not a vacancy feed. Never searched; kept out of ordinary responses by the restricted gate. AGENTS.md.',
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
