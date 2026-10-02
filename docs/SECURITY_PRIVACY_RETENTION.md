# Security/privacy retention and release evidence (F13 / T42)

Status of this file: **evidence assembly, not an approval**. Every row is marked
IMPLEMENTED (enforced in code and covered by a test) or PROPOSED (needs an owner
decision before anyone implements it). PROPOSED rows must not be treated as decided
periods, and nothing here authorizes secret provisioning, rotation, or host access —
those are owner checkpoints on F13 and stay closed.

Reproduce the gate: `npm run verify:security-privacy`. It runs the unit checks
below, the static log/secret hygiene checks, and `npm audit --omit=dev`, then writes
redacted JSON evidence (counts and pass/fail only — no emails, tokens, or file
contents) to stdout and, with `--out <path>`, to a file. Synthetic fixtures only;
never run it against production or with real credentials.

## 1. Retention table

"No indefinite retention by default": every row has a period or an explicit reason
why time-based expiry does not apply. `daily_visits` aggregates are the only rows
kept indefinitely, and they hold no personal data (counts only).

| Data | Period | Enforced by | Status |
|---|---|---|---|
| Account row (`users`) | Until account deletion, immediate | `lib/account-deletion.ts` (`DELETE FROM users WHERE id = ?`) | IMPLEMENTED |
| Owned workspace (`jobs`, `search_runs`, `search_run_sources`, `search_settings`, `search_roles`, `language_feedback`, `indeed_settings`, `indeed_coverage`, `dismissed_jobs`, `rejected_listings`, `user_vacancy_state`) | Until workspace reset or account deletion, immediate | `ownedDataDeletionStatements` / `accountDeletionStatements` | IMPLEMENTED |
| Verification tokens (`email_verifications`) | 24 h TTL, swept on issue, single-use, deleted with workspace/account | `lib/email.ts` (`VERIFICATION_TOKEN_TTL_MS`, `expires_at <= ?` sweep) | IMPLEMENTED |
| Password-reset tokens (`password_resets`) | 1 h TTL, swept on issue, single-use, deleted with account | `lib/email.ts` (`PASSWORD_RESET_TOKEN_TTL_MS`, `expires_at <= ?` sweep) | IMPLEMENTED |
| Sign-in records (`auth_events`: email, IP, outcome) | 30 days, purged on schema ensure | `db/runtime.ts` purge + migration `expire_auth_events` | IMPLEMENTED |
| Rate-limit buckets (`rate_limits`, may embed IP/email) | 15-minute window, swept on rollover | `lib/rate-limit.ts` (`DELETE FROM rate_limits WHERE reset_at <= ?`) | IMPLEMENTED |
| Session cookie (`ike_session`) | 14 days, or immediately on sign-out | `lib/auth.ts`, `lib/privacy-policy.ts` (`cookieNotice`) | IMPLEMENTED |
| Visit de-duplication markers (`visit_markers`) | Deleted on day rollover | `lib/analytics.ts` (`DELETE FROM visit_markers WHERE day < ?`) | IMPLEMENTED |
| Daily visit aggregates (`daily_visits`: totals only) | Indefinite — aggregate counters, no personal data | `lib/analytics.ts`; recorded as aggregate-only in `tests/account-deletion.test.ts` | IMPLEMENTED (exception documented) |
| Time-based expiry of dormant accounts / old searches | No time-based deletion: accounts and searches live until the owner deletes them | — | PROPOSED (needs owner-approved periods before implementation) |
| Backup expiry (local copies, litestream snapshots, D1 time travel) | litestream `retention: 720h` (30 days) in `deploy/litestream.yml`; local `local-backups/` copies have no automatic expiry | `deploy/litestream.yml`; `scripts/backup-local.mjs` | PROPOSED (owner to approve concrete backup periods and a deletion procedure) |
| Deleted-account reappearance after restore | Restores overwrite the target database: rehearse on disposable state first; re-run account deletion for accounts deleted after the backup was taken | Procedure only — no code enforces post-restore re-deletion | PROPOSED (owner to approve the restore runbook) |

Covered by: `tests/account-deletion.test.ts` (deletion completeness + cross-account
isolation on synthetic fixtures), `tests/email.test.ts` (token hashing, TTL, single
use), `tests/privacy-policy.test.ts` (notice matches behavior).

## 2. Recipients, regions, and data sent

| Recipient | Region / policy | Data sent | Status |
|---|---|---|---|
| Resend (`https://api.resend.com/emails`) | Vendor infrastructure; governed by their policy | Recipient address + single transactional email (verification or password reset) | IMPLEMENTED and disclosed in `lib/privacy-policy.ts` |
| Cloudflare Turnstile (`https://challenges.cloudflare.com`) | Vendor infrastructure; governed by their policy | Registration bot-check token verification; Cloudflare sees the visitor IP as part of the check | IMPLEMENTED and disclosed in `lib/privacy-policy.ts` |
| Configured job sources (see `app/sources`, `lib/job-adapters.ts`) | Public websites (CH/NL/EU) | Role keywords and locations only — never email, credentials, or saved advertisements | IMPLEMENTED and disclosed in `lib/privacy-policy.ts` |
| No model/AI provider | — | Job advertisements are never sent to a third-party model; no CV/scoring exists | IMPLEMENTED (no such call in code; `tests/privacy-policy.test.ts` pins no-CV copy) |

No other sharing exists. There is no advertising, analytics, tracking cookie, or
referrer/session logging.

## 3. Log policy

- `lib/` and `app/` contain no `console.*` logging of request bodies, passwords,
  tokens, keys, or cookies (checked statically by the verifier).
- Email tokens are stored as SHA-256 hashes (`token_hash`); raw tokens exist only in
  the emailed link and are never persisted (`lib/email.ts`).
- Passwords are never stored: only a PBKDF2-SHA256 hash with a per-account salt
  (`lib/auth.ts`, `lib/users.ts`).
- Security events are limited to sign-in rows (`auth_events`: email, IP, outcome);
  there is no production-grade audit trail, alerting, or incident process — recorded
  as a High blocker in `docs/PUBLIC_DEPLOYMENT_READINESS.md`, not claimed here.

## 4. Account-data export

Owner decision 2026-09-24: **no self-service export, by design** (GDPR Article 20
gap explicitly accepted; `lib/export.ts` deleted). The privacy notice offers a copy
via the installation owner instead (`lib/privacy-policy.ts`, "Access and
portability"). If export is ever revisited, it needs an authenticated process,
cross-account tests, and expiring temporary copies — none of which exists, and none
is built here.

## 5. What Codex reviews at the release SHA

1. Run `npm run verify:security-privacy` at the release commit; attach its JSON.
2. Confirm every IMPLEMENTED row above still points at code + a passing test.
3. Confirm no PROPOSED row was implemented without an owner decision.
4. Confirm the privacy notice (`app/privacy`) still matches `lib/privacy-policy.ts`
   (`tests/privacy-policy.test.ts` is the tripwire).
5. Confirm the evidence contains no secrets, emails, or user data (the verifier
   emits counts and digests only; the contract test pins this).
6. Missing or failed evidence blocks T23 / public opening. Passing it is not a
   security guarantee or legal certification.

Open gaps the evidence does NOT close (see `docs/PUBLIC_DEPLOYMENT_READINESS.md`):
first-admin bootstrap atomicity, email-ownership/recovery completeness, shared
public catalogue budgets, no-store on all private GETs, audit trail/alerting,
server-side paging beyond 2,000 rows, recoverable deletion reporting.
