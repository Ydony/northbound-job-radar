# Retention, processors and data minimisation — owner review packet (T38, F13)

**Status: proposed, not implemented. Nothing in this document is enforced by code yet.**
The machine-readable tables live in `lib/retention-review.ts` (`retentionTable`,
`processorTable`, `dataMinimizationNotes`, `logHygieneTable`); this document is the
rationale and the approval checklist. Tests pin the tables: every retention row must
keep status `proposed — pending owner approval` until its enforcement ships
(`tests/retention-review.test.ts`), so the privacy notice can never silently start
promising periods the code does not honour.

Known baseline from the 2026-09-29 review: `lib/privacy-policy.ts` generates
`/privacy`; no retention periods existed. What *did* exist: the 30-day `auth_events`
purge, 24h/1h single-use token TTLs, the 14-day session cookie, 15-minute rate-limit
windows, daily visit-marker deletion, and complete account-deletion coverage
(`tests/account-deletion.test.ts`). This packet builds on those; it does not rebuild them.

## 1. What already expires today (implemented, tested)

| Mechanism | Period | Proved by |
|---|---|---|
| `auth_events` purge | 30 days, on every boot | `db/runtime.ts:ensureSchema`, migration 9, `tests/` |
| Email verification tokens | 24h, single-use, hash-only | `lib/email.ts`, `tests/email.test.ts` |
| Password-reset tokens | 1h, single-use, hash-only, voided on password change | `lib/email.ts`, `app/api/account/route.ts:PATCH` |
| Session cookie | 14 days, epoch-revoked on password change/reset | `lib/auth.ts`, `lib/users.ts:revokeSessions` |
| Rate-limit buckets | swept at window rollover (~15 min) | `lib/rate-limit.ts` |
| Visit markers | deleted at day rollover | `lib/analytics.ts` |
| Account deletion | immediate, all owned rows + tokens + sessions | `lib/account-deletion.ts`, `tests/account-deletion.test.ts` |

## 2. Data minimisation: what is (and is not) collected

See `dataMinimizationNotes` in the module. The load-bearing points for review:

- No CV upload, storage, scoring, or model-provider calls exist. Advertisement text is
  screened server-side and never sent to an AI service, a tracker, or another account.
  Verified against the dependency list (`package.json`: no model SDK) and the fetch
  call sites (Resend, Turnstile siteverify, job-source APIs only).
- The only IP storage is `auth_events` (30 days) and the 15-minute rate-limit buckets.
  No browsing history, referrers, or session recording exist.
- Job sources receive role keywords and locations only — never email, credentials, or
  saved jobs. The per-source gates are in `docs/SOURCE_POLICY.md`.

## 3. Proposed retention table (needs owner approval)

Full rows in `retentionTable`. Summary of what changes vs what is confirmed as-is:

| Category | Proposal |
|---|---|
| Accounts | Immediate deletion on request (as today) + 24-month inactivity review before any action |
| Workspace/search data | Follows account lifetime (as today); **run history pruned after 12 months; rejection memory re-checked after 12 months** |
| `auth_events` / edge logs | 30-day purge (as today); **cap platform/proxy logs at 30 days, no bodies** |
| Rate-limit counters | Window rollover (as today, confirm only) |
| Tokens / sessions | TTLs as today (confirm only, incl. the deliberate reset-survives-workspace-reset split) |
| Visit aggregates | **Cap daily totals at 24 months** (markers already daily-deleted) |
| Backups | **30-day replica retention, restore-into-scratch-only, re-delete accounts removed after the backup timestamp** |
| Shared catalogue | Hold-based expiry (as today, confirm only) |

Bold items are the actual decisions. Everything else asks the owner to confirm the
current behaviour is the intended policy. No indefinite retention survives: the two
current indefinite cases (run history, aggregate visit totals) both get an end date.

## 4. Proposed processor table (needs owner approval)

Full rows in `processorTable`. Decisions the owner must make:

1. **VPS provider and region** (gated #193). Proposal: EU provider, EU region, so
   account data stays under EU/EEA-equivalent protection alongside the current
   Cloudflare posture. Hetzner/OVH were evaluated as cost examples only, not chosen.
2. **Backup bucket and region.** Proposal: EU region with a *different* provider than
   the VPS (off-box is the requirement; same-disk is not a backup).
3. **Confirm D1 location** for the live private production database (not pinned in
   this repo) and record it here.
4. **Confirm Resend’s processing region** at contracting (vendor-managed, US) and keep
   their DPA on file. Note the closed single-admin installation sends no email at all.
5. **Job-source regions vary by operator** (EU/CH/US); the data sent is deliberately
   minimal (keywords + location) and the admin-only gates stay server-side.

No AI/model providers, analytics, or advertisers receive anything — that negative is
part of the table so a future integration must add a row (and a privacy-notice change)
rather than slipping in silently.

## 5. Log hygiene (verified in code, T38)

See `logHygieneTable`. The app writes no logs of its own (zero `console.*` in
`app/`/`lib/`/`db/`/`worker/`); sensitive failures are tallied, not stored; reset
flows are oracle-free. The open item is platform-owned logs (Worker runtime logs,
systemd journal, proxy access logs): retention and body-redaction there are a T40
owner/host action, recorded as such rather than assumed.

## 6. Backup expiry and deleted-account reappearance

- Account deletion today removes all live personal rows and tokens and invalidates
  sessions (`lib/account-deletion.ts` + catalogue cleanup). Verified by test.
- Any backup taken *before* a deletion still contains that account. A naive restore
  over the live database would silently resurrect it. The proposed procedure (T40/T41):
  restores go to a scratch path only, are verified there, and before serving traffic
  every account deleted after the backup timestamp is re-deleted (deletion log or
  re-issued delete). Backup retention of 30 days bounds how far back a resurrection
  can reach.
- D1 Time Travel is a short-window operational undo, not the backup; the VPS
  Litestream replica (`deploy/litestream.yml`, 30-day retention proposed) is the
  backup once #193 lands. Neither is deployed as the backup today — stated plainly
  so nobody assumes coverage.

## 7. Privacy-notice changes shipped with this packet (T38)

`lib/privacy-policy.ts` + `app/privacy/page.tsx`, same commit per AGENTS.md:

- “Where the data lives” no longer claims the installation is unhosted: it now
  describes the local self-hosted database AND the private Cloudflare production
  installation (Worker + D1, single admin, closed registration) honestly.
- Recipients now name Cloudflare hosting, Resend, Turnstile, the job-source
  category and the undecided backup replica — matching `processorTable`, without
  overstating undecided regions/providers.
- A “retention under review” note states that concrete periods are proposed in this
  document and pending owner approval, and points at the per-row “Kept for” values
  as current behaviour. Proposed periods are NOT presented as enforced.

## 8. Owner approval checklist (the gate before T39–T41)

- [ ] Approve each `proposedPeriod` in `retentionTable` (or amend: the module is the edit point).
- [ ] Choose VPS provider + region; choose backup provider + region (EU proposals above).
- [ ] Confirm D1 location and Resend region/DPA; record both in §4.
- [ ] Authorise secret provisioning/rotation and host access for T39–T41 (separate step).
- [ ] Confirm the reset-survives-workspace-reset split and the 24-month inactivity-review approach.

Codex reviews this packet and its evidence at the release SHA; missing/failed evidence
blocks T23/public opening. This packet is not a security guarantee or legal certification.
