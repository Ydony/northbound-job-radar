# Security/privacy release evidence (F13, T42)

For the independent reviewer (Codex): everything on this page is reproducible
from the code at one commit, with synthetic fixtures only. Nothing here uses
real secrets, production data, or host access. This is not an
absolute-security guarantee or legal certification.

- Release SHA: _to be filled at the release commit_ (re-assembled on `edb9d70` + T42, rebased 2026-10-02).
- Evidence bundle: `npm run verify:security-privacy` (prints redacted JSON;
  `-- --strict` exits non-zero while any `blocking` finding remains).
- Unit pins: `tests/security-privacy-evidence.test.ts`.
- Status at re-assembly: **23 pass, 2 blocking, 1 accepted gap** — T23/public
  opening is **blocked** until the two blocking findings clear. The third
  blocker from the first assembly (`R7-no-store`) is fixed by T19 (see §10).

## 1. Retention table

Periods are implemented in code. **Owner approval is pending (T38 gate)** —
the table below is the proposal awaiting that decision, not an approved
schedule. No indefinite retention by default: every row below has a bounded
period enforced in code.

| Data | Period | Enforced in | Privacy copy |
|---|---|---|---|
| Account (email + password hash) | Until account deletion (immediate) | `lib/account-deletion.ts` | "Until you delete your account, which removes it immediately." |
| Jobs, notes, corrections, settings, roles, rejection memory | Until individual delete / workspace reset / account deletion; shared catalogue copy collected once nobody holds it | `lib/account-deletion.ts`, `lib/catalogue.ts` | Stated per item in `dataWeHold` |
| Email verification token (hash only) | 24 h, single-use, consume-then-delete | `lib/email.ts` (`VERIFICATION_TOKEN_TTL_MS`) | "verification links expire after 24 hours" |
| Password-reset token (hash only) | 1 h, single-use, consume-then-delete | `lib/email.ts` (`PASSWORD_RESET_TOKEN_TTL_MS`) | "reset links after 1 hour" |
| Sign-in records (email, IP, outcome) | 30 days, purged on every request | `db/runtime.ts` `ensureSchema()`, migration 9 | "automatically deleted after 30 days" |
| Rate-limit counters (may embed IP/email in bucket key) | 15-minute window, swept on rollover | `app/api/auth/route.ts`, `lib/rate-limit.ts` | "deleted when their 15-minute window rolls over" |
| Session cookie | 14 days, cleared immediately on sign-out | `lib/auth.ts` (`SESSION_TTL_MS`) | "14 days, or immediately when you sign out." |
| Visit de-duplication markers | Deleted on day rollover; daily totals are aggregate-only | migrations v8, visit counting code | "deleted once the day ends" |
| Backups (Litestream replica) | 30 days of snapshots + WAL | `deploy/litestream.yml` (`retention: 720h`), `docs/DEPLOY.md` | n/a (operational, not account data) |

## 2. Recipients, regions, data sent

| Recipient | Region / endpoint | Data sent | Basis |
|---|---|---|---|
| Resend (email delivery) | `https://api.resend.com/emails`; production sender `noreply@mail.ikbeneenappel.nl` (Ireland region, click/open tracking off) | Recipient address + single-use link, verification/reset only | Named in `/privacy` (`lib/privacy-policy.ts`); see `docs/EMAIL_SETUP.md` |
| Cloudflare Turnstile (registration bot check) | `https://challenges.cloudflare.com` (script + frame; the only non-self CSP allowances) | Token verification; Cloudflare sees the IP as part of the check, token not stored | Named in `/privacy`; pinned by `tests/security-headers.test.ts` |
| Job sources being searched | Per-source site being queried | Role keywords + chosen locations only — never the account email | Stated in `/privacy` ("They never receive your email.") |
| Backup object storage | R2/B2 S3-compatible bucket on a different provider than the VPS (bucket TBD — owner procurement #204) | Ciphertext-only encrypted envelopes (T33, AES-256-GCM `NBENC1`, separate recovery key) plus Litestream replica pages in transit | `deploy/litestream.yml`, `docs/DEPLOY.md`, `lib/backup-encryption.ts` |

No CV/scoring flows exist (removed 2026-09-23; migration 28 drops `cvs`;
`lib/export.ts` deleted). No lib/ module posts job data to a third-party
model endpoint. Test fixtures are synthetic (`@example.test`); the evidence
script scans `tests/` for production addresses, live keys and key material.

## 3. Logs, access, expiry

- Zero `console.*` call sites in `app/`, `lib/`, or `worker/` (T39) — if
  nothing is ever written to a server log, no password, token, key, request
  body, or private search data can leak through one (checks `R2-no-secret-logs`
  and `R13-log-redaction`; pinned by `tests/log-redaction.test.ts`).
- `auth_events` holds outcomes only (`id/email/ip/kind/created_at`, plus
  administrator `actor` in migration 33/T44) — refusal reasons are never
  stored, because a provider refusal can quote the address (see `docs/HANDOFF.md`
  2026-09-27 email entry). Email tokens are hash-only with a boot-time expiry
  sweep (`lib/email.ts` `purgeExpiredTokens`, T39).
- Exactly one script prints a secret value, and only to the local terminal:
  `scripts/reset-prod-admin-password.mjs` prints the temporary password as the
  owner handover. `bootstrap-prod-admin` prompts hidden and stores only the
  hash. No other script prints a secret value (check `R2-operator-handover`).
- Access: administrators see that an account exists, its email, and job
  counts — never another account's job list through the admin screen
  (`whereDataLives`, `scripts/verify-admin-actions.mjs` 9/9).

## 4. Deletion, backups, restore

- All three delete paths delegate to one helper (`lib/account-deletion.ts`);
  the owned-table list is derived from the schema, so a new user-scoped table
  fails the suite until covered (`tests/account-deletion.test.ts`, incl. a
  live two-account emptying proof).
- Deletion writes hash-only tombstones (`deleted_accounts`, SHA-256 hashes
  only, T40b) in the same batch. The restore procedure copies the live
  tombstone set into any restored copy and re-deletes every tombstoned row
  before it serves traffic (`scripts/reconcile-deletions.mjs`, `docs/DEPLOY.md`;
  checks `R15-deletion-tombstones`; end-to-end `npm run verify:deletion-restore`
  passes). Backup expiry (30 days) bounds how long a resurrecting backup can
  exist; tombstones close the window inside it.
- Backup encryption (T33): ciphertext-only AES-256-GCM envelopes (`NBENC1`,
  separate `BACKUP_RECOVERY_KEY`, fingerprint-only manifest,
  `lib/backup-encryption.ts`); the synthetic drill
  (`npm run verify:encrypted-backup`) passes, including wrong-key/tamper/absent-key
  fail-closed and rotation.
- **Gap (blocking, `R8-encrypted-restore`):** the real-target
  restore-into-scratch drill (never over the live file, scratch deleted after,
  `docs/DEPLOY.md`) is owner-run and unwitnessed at this SHA. Codex must
  witness the real drill — the synthetic rehearsals above do not replace it.

## 5. Export position (accepted gap, `R6-no-export`)

No self-service export exists — owner decision 2026-09-24, by design. Users
contact the installation owner for a copy of their data. The NL GDPR
Article 20 portability gap was stated to the owner and explicitly accepted
(see `docs/PUBLIC_DEPLOYMENT_READINESS.md`, accepted-gap row). Revisiting
export requires a privacy review first; it does not block retention/deletion
work.

## 6. Known blockers for T23 (from the evidence script)

1. `R1-approval` — retention periods implemented, owner approval pending (T38).
2. `R8-encrypted-restore` — see §4 (T33 synthetic drill passes; real-target
   witness pending).

Fixed since the first assembly: `R7-no-store` — T19 now covers every private
API route via `noStoreJson`/`withNoStore` (`lib/no-store.ts`, re-exported from
`lib/guard.ts`); the only bare `Response.json` left is the public Turnstile
sitekey route by design (check `R7-no-store`, `tests/no-store.test.ts`).

Unrelated pre-existing failure recorded honestly, not hidden: at assembly,
the full suite is 554/555 with `tests/job-room.test.ts` → "the end date is
kept at collection" failing because its fixture endDate `2026-10-01` is now
in the past and the parser refuses expired ads (date-bomb fixture, Job-Room
area — not F13). Left for its owning workstream; cited here so the release
SHA comparison is not misread.

## 7. Redaction rules (binding on all evidence)

- Evidence prints counts, presence booleans and short code quotes only.
- Never print emails, tokens, keys, secrets, password hashes, or personal data.
- Never read `.dev.vars.*`, `.wrangler/`, buckets, or any live database from
  an evidence command; the script asserts it reads none of them.
- Restored/throwaway copies holding real account data are never committed,
  pasted into issues, or quoted in transcripts (`docs/DEPLOY.md` procedure).

## 8. Reproduce (reviewer commands)

```bash
git rev-parse HEAD                                   # the release SHA under review
npm run verify:security-privacy                      # evidence JSON (exit 0 = assembled)
npm run verify:security-privacy -- --strict          # exit 1 while any blocking finding remains
npx tsx --test tests/security-privacy-evidence.test.ts tests/privacy-policy.test.ts \
  tests/account-deletion.test.ts tests/security-headers.test.ts tests/email.test.ts
npx tsx --test tests/no-store.test.ts tests/password-hash-policy.test.ts \
  tests/security-matrix.test.ts tests/deploy-hardening.test.ts tests/log-redaction.test.ts \
  tests/security-events.test.ts tests/deletion-tombstones.test.ts
npm run verify:encrypted-backup                      # T33 synthetic encrypted-restore drill
npm run verify:deletion-restore                      # T40/T40b deletion + tombstone reconcile proof
npm run verify:deploy-hardening                      # T37 host/template checks
npm test                                             # full suite (see §6 for the known unrelated failure)
npm run lint && npm run typecheck
node --import tsx scripts/verify-sqlite-restore.mjs  # synthetic restore rehearsal
```

Live two-account and admin-harness proofs need disposable local servers and
are operator-run, never in the gate (rate limits bucket loopback traffic):

```bash
npm run verify:dev          # 10/10 fresh synthetic accounts + cross-account isolation
npm run verify:admin        # 9/9 admin actions on a disposable target account
```

## 9. Codex review checklist (sign-off)

- [ ] Ran §8 at the release SHA; evidence JSON `sha` matches.
- [ ] `--strict` passes (no `blocking` findings), or each remaining one has a
      dated owner decision recorded below.
- [ ] Retention table (§1) approved or amended by the owner (T38).
- [ ] Encrypted-restore drill witnessed on the real target (§4), not just the
      synthetic rehearsal.
- [ ] Cross-account checks re-run: `tests/account-deletion.test.ts` (live
      two-account emptying) plus `verify:dev` / `verify:admin` on disposable
      servers; no production data in fixtures/prompts.
- [ ] Verdict: PASS (release SHA cleared for T23) / FAIL (missing/failed
      evidence — T23 stays blocked). Record the SHA, date, and reviewer here.

## 10. Newly merged controls in this evidence (rebase onto `edb9d70`)

These landed on master after the first T42 assembly and are now pinned in the
evidence script (`R7`, `R9`–`R15`) rather than rebuilt here. All fixtures are
synthetic; no real secrets, production data, or host access.

| Control | What it is | Evidence (code + test + verifier) |
|---|---|---|
| T19 no-store/limiter | Every private API response carries `Cache-Control: no-store` via `noStoreJson`/`withNoStore`; atomic fail-closed `durableRateLimit`, native/edge limiter refusals, and guard denials are uncacheable at the source | `lib/no-store.ts`, `lib/guard.ts`, `lib/rate-limit.ts`; `tests/no-store.test.ts` (route-wide scan + limiter/guard sections); check `R7-no-store`, `R9-limiter` |
| T34 password hashing | Versioned PBKDF2 policy: 600k iterations on Node, 100k Workers cap, iteration-as-version, legacy-login rehash without touching the password | `lib/auth.ts` (`NODE_PBKDF2_ITERATIONS`, `WORKERS_PBKDF2_CAP`, `parsePasswordHash`, `passwordHashNeedsRehash`), `lib/users.ts`; `tests/password-hash-policy.test.ts`; `npm run benchmark:password-hash`; check `R10-password-hashing` |
| T36 SSRF hardening | Manual-URL ingestion refuses metadata hosts and numeric-IP encodings; account/role matrix exercised with XSS/SQL/SSRF cases | `lib/job-sources.ts` (`isSafeManualJobUrl`), `lib/source-policy.ts`; `tests/security-matrix.test.ts`; check `R11-ssrf` |
| T37 unit hardening | Service/proxy templates run unprivileged and contained; dependency/artefact/secret checks | `deploy/ikbeneenappel-*.service`, `deploy/nginx-ikbeneenappel.conf`; `tests/deploy-hardening.test.ts`; `npm run verify:deploy-hardening`; `docs/VPS_HOST_CHECKS.md`; check `R12-unit-hardening` |
| T39 log redaction | Zero server-side `console.*`, `auth_events` kinds only, hash-only single-use tokens with boot-time expiry sweep | `lib/email.ts` (`purgeExpiredTokens`), `db/runtime.ts`, `db/migrations.ts`; `tests/log-redaction.test.ts`; check `R13-log-redaction` |
| T44 security events | Outcome-only security-event log (no job content, passwords, tokens, or provider reasons), 30-day retention, administrator-only reads | `lib/security-events.ts`, `app/api/admin/security-events/route.ts`; `tests/security-events.test.ts`; check `R14-security-events` |
| T40b deletion tombstones | Hash-only deletion tombstones written in the deletion batch; restore procedure re-applies them before serving traffic | `lib/account-deletion.ts`, `db/migrations.ts` (`deleted_accounts`), `scripts/reconcile-deletions.mjs`, `docs/DEPLOY.md`; `tests/deletion-tombstones.test.ts`; `npm run verify:deletion-restore`; check `R15-deletion-tombstones` |
