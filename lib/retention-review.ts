/**
 * Data-minimization, retention and processor tables for owner review (T38, F13).
 *
 * This module is a REVIEW PACKET, not an enforcement mechanism. Every period in
 * `retentionTable` has status `proposed`: the owner approves concrete periods
 * before anything here is implemented (T39–T41), and no proposed period may be
 * presented to users as already enforced. `tests/retention-review.test.ts`
 * pins that invariant: adding an `enforced` row without an implementation is a
 * test failure, and implementing a period means moving its row to a module that
 * the runtime actually reads.
 *
 * `currentBehavior` strings describe what the code does today, each with the
 * file and line that proves it. The matching narrative, rationale and approval
 * checklist live in `docs/RETENTION_AND_PROCESSORS_REVIEW.md`.
 */

export const RETENTION_REVIEW_STATUS = 'proposed — pending owner approval' as const;

export type RetentionStatus = typeof RETENTION_REVIEW_STATUS;

export interface RetentionRow {
  /** What is kept: accounts, searches, logs, tokens, backups (F13 wording). */
  category: string;
  /** What the code does today, with the file that proves it. */
  currentBehavior: string;
  /** The concrete period put to the owner. Never presented as enforced. */
  proposedPeriod: string;
  /** Why this period, and what implementing it would take. */
  proposedBasis: string;
  status: RetentionStatus;
}

function row(
  category: string,
  currentBehavior: string,
  proposedPeriod: string,
  proposedBasis: string,
): RetentionRow {
  return { category, currentBehavior, proposedPeriod, proposedBasis, status: RETENTION_REVIEW_STATUS };
}

export const retentionTable: RetentionRow[] = [
  row(
    'Accounts (users row: email, password hash, role, verification state)',
    'Kept until the account is deleted by its owner or an administrator, then removed immediately '
    + 'in the same batch (`lib/account-deletion.ts:accountDeletionStatements`, `app/api/account/route.ts:DELETE`). '
    + 'No expiry while the account exists.',
    'Delete immediately on verified request (unchanged), plus review accounts inactive for 24 months '
    + 'with the owner before any action.',
    'Immediate deletion on request already matches the privacy notice. The 24-month inactivity review '
    + 'is new: it ends indefinite retention by default without silently deleting a job-seeker’s history. '
    + 'Needs an inactivity definition (no sign-in) and an owner-approved contact-before-delete step (T39).',
  ),
  row(
    'Workspace and search data (jobs, search_runs, search_run_sources, language_feedback, '
    + 'dismissed_jobs, rejected_listings, search_settings, search_roles, indeed_settings, '
    + 'indeed_coverage, user_vacancy_state)',
    'Kept indefinitely until the owner deletes rows individually, resets the workspace, or deletes '
    + 'the account (`lib/account-deletion.ts:ownedDataDeletionStatements`). Search runs have no age-out.',
    'Jobs and corrections follow the account lifetime (unchanged). Search-run history older than '
    + '12 months is pruned; rejected-listing memory older than 12 months is reconsidered rather than '
    + 'trusted blindly.',
    'Run history is diagnostic, not the product: 12 months keeps debugging possible while bounding '
    + 'growth. Rejected listings encode past role keywords, so re-checking them after a year avoids '
    + 'hiding jobs behind stale assumptions. Needs a scheduled purge plus a pre-delete count report (T39).',
  ),
  row(
    'Sign-in and security logs (auth_events: email tried, IP, outcome)',
    'Automatically deleted after 30 days on every boot (`db/runtime.ts:ensureSchema`, migration 9 '
    + '`db/migrations.ts:expire_auth_events`). Email-change rows under a superseded address age out '
    + 'the same way; live-address rows are also removed at account deletion.',
    'Keep the 30-day purge (unchanged). Additionally cap platform/edge logs (Worker logs, '
    + 'systemd journal, reverse-proxy access logs) at 30 days with no request bodies.',
    '30 days is already implemented and proportionate for password-guessing defence. The edge-log '
    + 'cap is new: the app never writes bodies or secrets there (see logHygiene), but the platform '
    + 'defaults are not ours until the owner sets them (T40).',
  ),
  row(
    'Abuse-prevention counters (rate_limits buckets, 15-minute windows)',
    'Swept when their window rolls over — inline on the next fresh window (`lib/rate-limit.ts:'
    + 'durableRateLimit`) — and deliberately excluded from account deletion because they are '
    + 'not account data (`lib/account-deletion.ts`).',
    'Keep window-rollover sweeping (unchanged); no per-account retention beyond the active window.',
    'Counters contain an IP or email key for minutes only. There is nothing to minimise further; '
    + 'the ask is only that the owner confirms this reading.',
  ),
  row(
    'Single-use tokens (email_verifications 24h, password_resets 1h; hash-only storage)',
    'Verification links expire after 24h and reset links after 1h (`lib/email.ts:VERIFICATION_TOKEN_TTL_MS`, '
    + '`PASSWORD_RESET_TOKEN_TTL_MS`); only SHA-256 hashes are stored, one token per account, consumed '
    + 'tokens are deleted on use, and expired tokens are swept on issue. Outstanding reset tokens are '
    + 'voided on password change; both token tables are emptied at account deletion.',
    'Keep the 24h/1h TTLs and hash-only storage (unchanged). Confirm that password_resets surviving '
    + 'a workspace reset stays deliberate (recovery state, not provisioning state).',
    'Token handling is already minimal. The only decision is confirming the existing reset-survives-'
    + 'reset split, documented in `lib/account-deletion.ts`, rather than changing it.',
  ),
  row(
    'Sessions (ike_session cookie, 14-day TTL, epoch revocation)',
    'Cookie expires after 14 days or immediately on sign-out; password change and the admin reset '
    + 'revoke all sessions by bumping the epoch (`lib/auth.ts:SESSION_TTL_MS`, `lib/users.ts:revokeSessions`). '
    + 'Account deletion removes the user row, so every remaining cookie for it fails closed.',
    'Keep the 14-day TTL and epoch revocation (unchanged).',
    'Sessions hold no personal data beyond the account id and are already bounded. Ask is confirmation only.',
  ),
  row(
    'Visit counters (daily_visits aggregates, visit_markers de-duplication hashes)',
    'Markers are deleted when the day rolls over and cannot link visits across days (`lib/analytics.ts:'
    + 'recordVisit`). The daily totals (visits, distinct visitors) are aggregates kept indefinitely.',
    'Keep daily marker deletion (unchanged). Cap the aggregate daily totals at 24 months, then delete '
    + 'or roll up to monthly counts.',
    'The aggregates identify nobody, but “kept indefinitely” is exactly the default F13 forbids. '
    + '24 months keeps trend insight while giving every number an end date. Needs a tiny scheduled '
    + 'delete plus a privacy-notice correction (T39).',
  ),
  row(
    'Backups (no automated backup on Cloudflare D1 today; Litestream replica proposed for the VPS target)',
    'Today: no app-managed backup exists — local `.wrangler/` state and ad-hoc copies are explicitly '
    + 'not backups. Proposed VPS path replicates the SQLite WAL off-box with 30-day snapshot+WAL '
    + 'retention (`deploy/litestream.yml`, not deployed; VPS itself undecided, gate #193).',
    'Approve 30-day backup retention with restore-into-scratch-only procedure and a re-deletion step: '
    + 'any account deleted after the backup timestamp is re-deleted before the restored copy serves '
    + 'traffic, so deleted accounts cannot silently reappear.',
    '30 days survives an unnoticed bad migration while staying inside object-storage free tiers. '
    + 'The re-deletion step is the whole of the “deleted accounts reappearing” fix. Needs the owner’s '
    + 'backup-provider and region choice first (T40), then a rehearsed restore drill (T41).',
  ),
  row(
    'Shared catalogue copies (vacancies, vacancy_sources: employer text, no user_id by design)',
    'A catalogue row survives while any account holds it and is removed once nobody does '
    + '(`lib/catalogue.ts`, migration 30). Personal state per account is deleted with the account.',
    'Keep hold-based expiry (unchanged); confirm that catalogue text is employer-owned public text, '
    + 'not personal data, with per-source redisplay limits in `docs/SOURCE_POLICY.md` §1.',
    'Hold-based deletion already bounds catalogue lifetime by real use. The ask is confirming the '
    + 'personal vs employer-text split rather than adding a clock.',
  ),
];

/** Recipients that receive personal data or search content, for the privacy notice. */
export interface ProcessorRow {
  /** Who receives data (provider or category). */
  recipient: string;
  /** Why they receive it. */
  purpose: string;
  /** Exactly what is sent — and what is explicitly not sent. */
  dataSent: string;
  /** Where it is processed, or honestly TBD. */
  region: string;
  /** Live, conditional, or undecided — never overstated. */
  status: string;
}

export const processorTable: ProcessorRow[] = [
  {
    recipient: 'Cloudflare (Workers + D1)',
    purpose: 'Hosts the private production installation: compute and the remote database.',
    dataSent: 'Everything the installation stores (accounts, jobs, runs, logs, tokens). Nothing is sent onward by the host.',
    region: 'Cloudflare-managed; D1 location is not pinned in this repo — owner to confirm.',
    status: 'Live for the single-admin production installation; local dev/test never leave this computer.',
  },
  {
    recipient: 'VPS host (provider undecided; Hetzner/OVH evaluated as EU examples)',
    purpose: 'Proposed self-hosted target: Node process, SQLite file, systemd units.',
    dataSent: 'Same database content as D1, on the owner’s server. No third party receives it by hosting there.',
    region: 'TBD — owner choice; proposal is EU (see review doc §4).',
    status: 'Proposed, gated on owner scope decision #193. Not deployed.',
  },
  {
    recipient: 'Backup object storage (R2, B2 or S3-compatible — undecided)',
    purpose: 'Off-box Litestream replica of the SQLite file.',
    dataSent: 'Full database copy, including personal data. Encrypted in transit; at-rest per provider.',
    region: 'TBD — owner choice; proposal is EU with a different provider than the VPS.',
    status: 'Undecided. Credentials never enter the repo (root-owned 0600 EnvironmentFile).',
  },
  {
    recipient: 'Resend (resend.com)',
    purpose: 'Delivers verification and password-reset emails only.',
    dataSent: 'Recipient address plus a single-use link. Nothing else about the workspace.',
    region: 'Vendor-managed (US) — confirm at contracting; governed by their policy.',
    status: 'Only when the owner configures a key. The closed single-admin installation sends no email.',
  },
  {
    recipient: 'Cloudflare Turnstile',
    purpose: 'Registration bot check.',
    dataSent: 'The challenge token and the visitor IP (as part of any web request). The token is verified, never stored.',
    region: 'Cloudflare-managed (global challenge infrastructure).',
    status: 'Documented test keys on loopback only; real keys required before any open registration.',
  },
  {
    recipient: 'Job sources (EURES/ELA, arbeit.swiss/Job-Room, employer ATS boards, FreeHire; '
      + 'admin-only: Adzuna, Careerjet, JobCloud sites, IamExpat, Undutchables)',
    purpose: 'Answer the searches the user explicitly triggers (plus the bounded shared-catalogue refresh).',
    dataSent: 'Role keywords and chosen locations/countries only. Never the email address, credentials or saved jobs.',
    region: 'Varies by source operator (EU/CH/US). Full list and gates: sources page + `docs/SOURCE_POLICY.md`.',
    status: 'Public tier limited to approved public sources; admin-only sources are server-gated per account.',
  },
  {
    recipient: 'No AI/model providers, no analytics, no advertisers — nobody else',
    purpose: 'Data minimisation boundary: these categories receive nothing.',
    dataSent: 'Advertisement text is screened server-side and never sent to a model or tracker; no tracking cookies, pixels or fingerprinting exist.',
    region: 'Not applicable.',
    status: 'Verified against the dependency list and the fetch call sites (see review doc §2).',
  },
];

/** What the app deliberately does not collect — the minimisation half of the story. */
export const dataMinimizationNotes: string[] = [
  'No CV upload, file storage, role derivation or fit scoring exists anymore (removed 2026-09-23, migration 28); the privacy notice must never promise or imply it.',
  'No advertising, marketing, third-party analytics, tracking cookies, pixels, fingerprinting, cross-site tracking, profiling, or sale of data.',
  'No page-by-page browsing history, referrer logging, or session recording. The only IP storage is auth_events (30 days) and the 15-minute rate-limit buckets.',
  'Search keywords and locations go to the searched job sources; account credentials and saved advertisements never go to job sites or AI services.',
  'Single-use email tokens are stored as SHA-256 hashes only, one per account, so reading the database never yields a usable link.',
];

/** Log-hygiene claims, each paired with the evidence a reviewer can re-check. */
export interface LogHygieneRow {
  claim: string;
  evidence: string;
}

export const logHygieneTable: LogHygieneRow[] = [
  {
    claim: 'The app itself writes no request, password, token, key or body to any log.',
    evidence: 'Zero `console.*` call sites in `app/` and `lib/` (re-check: search for `console.`); routes return generic errors and never echo secrets.',
  },
  {
    claim: 'Password-reset answers identically whether or not the address exists.',
    evidence: '`docs/EMAIL_SETUP.md`: the route must not become an account-existence oracle; outcomes are tallied server-side, never messaged to the caller.',
  },
  {
    claim: 'Email refusal reasons are not stored: only a 24-hour sent/failed tally is kept.',
    evidence: '`docs/EMAIL_SETUP.md` §“Where failures show up”: Resend’s refusal text can quote the refused address and auth_events is not account-scoped, so the reason is deliberately dropped.',
  },
  {
    claim: 'auth_events stores only the email tried, the IP and the outcome — never passwords, tokens or keys.',
    evidence: 'Schema migration 6 (`db/migrations.ts`): columns are id, email, ip, kind, created_at; writers pass kind labels only.',
  },
  {
    claim: 'Turnstile tokens are verified with Cloudflare and never stored.',
    evidence: '`lib/turnstile.ts:verifyTurnstileToken` posts the token to siteverify and keeps nothing; `lib/privacy-policy.ts` discloses the IP visibility.',
  },
  {
    claim: 'Remaining log risk is platform-owned, not app-owned: Worker logs, systemd journal and proxy access logs.',
    evidence: 'No repo configuration sets their retention or redaction today — that is the T40 owner action (cap at 30 days, no bodies).',
  },
];
