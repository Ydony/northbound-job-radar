# Private data, trust boundaries and secret lifecycle (T28, F11 baseline)

Derived from public code on this branch — `db/migrations.ts` (versions 1–31),
`db/runtime.ts`, `db/sqlite-adapter.ts`, `lib/auth.ts`, `lib/guard.ts`,
`lib/email.ts`, `lib/privacy-policy.ts`, `db/env.d.ts`, `deploy/*`,
`scripts/run-local.mjs`, `scripts/init-secrets.mjs` — not from memory. Every
table named below appears in the migration chain; every secret named below
is declared in `db/env.d.ts`, read in `db/runtime.ts`, or documented in
`deploy/litestream.yml` (the test asserts all three directions).

**Status: baseline map, not an approval.** This is the inventory F11's
protection contract must cover. Owner review of the storage/key-custody
approach precedes T30/T32. Nothing here authorizes encryption work, real-data
handling, or host changes.

**Synthetic fixtures only.** All example values in §6 use the
`synthetic-… / example.invalid` namespace and are fake. No real secrets,
production data, or host paths appear in this file.

Guarded by `tests/private-data-map.test.ts`; exercised with throwaway
fixtures by `scripts/verify-private-data-map.mjs`.

## 1. The one distinction everything else hangs on

Public job content is distinct from a user's private relationship to a job
(migration 30, `lib/catalogue.ts`):

- **Public catalogue (shared, not personal):** `vacancies` holds one row per
  distinct advert across ALL accounts — employer's public text plus
  provenance. No `user_id` **by design**. `vacancy_sources` records which
  source copies built each catalogue row. Encrypting these buys nothing; they
  are public text.
- **Private relationship (per account, must be protected):**
  `user_vacancy_state` (`user_id`, `job_id` → saved / applied / dismissed /
  language correction), plus the legacy per-owner rows in `jobs`,
  `language_feedback`, `dismissed_jobs`, `rejected_listings` that INT-05 has
  not yet rewired. These reveal what a person is pursuing and must be
  encrypted at rest under F11.

Until INT-05 rewires reads, every account additionally holds its own full
copy of each advert's public text inside its `jobs` rows — so today the
private store also carries duplicated public text. Field-level versus
whole-file encryption must account for that duplication, not assume the
catalogue split already removed it.

## 2. Private-data inventory: storage / encryption / key access / retention

Encryption state is the **current** state: SQLite/D1 plaintext at rest (see
§5 gaps). "Key access" names what unlocks the data today, so the gap is
explicit.

| # | Category | Tables / artifacts | Storage today | Encryption today | Key access today | Retention |
|---|---|---|---|---|---|---|
| P1 | Account identity | `users`: id, email (UNIQUE), `password_hash` (PBKDF2-SHA256, per-user salt, `lib/auth.ts`), role, status, `session_epoch`, `email_verified_at`, created/last-seen timestamps | D1 prod; SQLite file (`SQLITE_PATH`) self-hosted | None at rest beyond platform (D1 managed; file permissions) | DB file / D1 operator access; password itself never stored | Until account deletion (immediate, per `/privacy`) |
| P2 | Session tokens | `ike_session` cookie: `userId:epoch:expiry`, HMAC-signed (`SESSION_SECRET`); `HttpOnly; SameSite=Strict; Secure` on HTTPS (`lib/auth.ts`, `lib/guard.ts`) | Browser cookie store; server verifies, never stores sessions | HMAC signature only (integrity, not confidentiality of the id inside) | `SESSION_SECRET` in memory | 14 days, or sign-out; epoch bump revokes all cookies for the user |
| P3 | Sign-in abuse records | `auth_events`: email tried, IP, kind | Same DB as P1 | None | DB access | Auto-deleted after 30 days (`ensureSchema()` purge + migration 9) |
| P4 | Rate-limit counters | `rate_limits`: bucket, count, reset_at; buckets can contain an IP (`lib/privacy-policy.ts`) | Same DB | None | DB access | Deleted when the 15-minute window rolls over |
| P5 | Email tokens | `email_verifications`, `password_resets`: **token hashes only** (`hashEmailToken`, `lib/email.ts`); single-use, delete-on-consume | Same DB | Hash (SHA-256) — reading the DB never yields a usable link | DB access; usable token exists only in the sent email | Verification 24 h, reset 1 h; expired tokens swept on issue |
| P6 | Private search criteria | `search_settings`, `search_roles` (per `user_id`), `indeed_settings` (per-user places/radii, migration 26) | Same DB, `user_id`-scoped | None | DB access + session of that user | Until changed/deleted; account deletion removes |
| P7 | Private job relationship | `user_vacancy_state` (saved/applied/visibility/corrections per `user_id, job_id`); `jobs` per-owner copies (incl. duplicated public text until INT-05); `language_feedback` (user corrections + frozen detector snapshot); `dismissed_jobs` (per-user tombstones); `rejected_listings` (per-user skip reasons + roles); `search_runs` / `search_run_sources` (per-user run history incl. `matched_count`); `indeed_coverage` (per-user, per-query coverage checkpoints keyed by owner + role + country + place) | Same DB, `user_id`-scoped, served only through `requireSession()` + `user_id` binding | None | DB access + that user's session | Individual delete, workspace reset, or account deletion; catalogue rows nobody holds are removed |
| P8 | Operational (not personal) | `indeed_control`, `public_refresh_state`, `public_refresh_queue` (per-source locks/cursors/cooldowns; no `user_id` anywhere), `daily_visits` + `visit_markers` (salted daily hash, markers deleted at day rollover, migration 8) | Same DB | None (not required — no personal data) | DB access | Locks/cursors rolling; visit markers ≤ 1 day; daily totals indefinite aggregates |
| P9 | Journals, temp files, snapshots | SQLite `-wal` / `-shm` / `-journal` beside `SQLITE_PATH` (WAL mode, `db/sqlite-adapter.ts`); `.local/<env>-server/` per-env build output (static assets; private rows are runtime-fetched, not baked in); `local-backups/` manifests + `state/` copies; Litestream replica pages off-box | Host disk; object storage (replica) | None — WAL carries the same rows as the main file | Host/process file access | WAL transient (checkpointed); backups per Litestream retention 720 h (30 days, `deploy/litestream.yml`) |
| P10 | Logs and error paths | Server stdout/stderr (systemd journal on VPS), Turnstile/Resend provider logs, `auth_events` (P3) | Host / provider | TLS in transit; none at rest under app control | Host access; provider's own policy | Journal per host rotation; provider-side per their policy |
| P11 | Deletion tombstones | `deleted_accounts`: **hashes only** — SHA-256 of the user id and of the address with a deletion-specific prefix (`lib/account-deletion.ts`); no id, no address, no `user_id` column by design | Same DB as P1 | Hash (SHA-256) — reading the DB never yields the account | DB access | 720 h (30 days, the same bound as the P9 backups they protect); purged on boot; copied into restored copies and reconciled before they serve traffic |

Out of scope for encryption but in scope for tenancy: P8 rows must never gain
a `user_id` (public-refresh scheduler refuses non-public keys); P1 e-mail
addresses are visible to installation administrators as account metadata
(`whereDataLives`, `lib/privacy-policy.ts`) but job lists are not readable
through the admin screen. Two tables complete the schema but hold no live
private data: `schema_migrations` (version bookkeeping, no personal data) and
the historical `cvs` base (removed from the final schema by migration 28; kept
in `db/runtime.ts` only so pre-28 databases can upgrade).

## 3. Trust boundaries

```text
Browser ──B1── Server ──B2── job sources (role keywords + locations only)
                ├──B3── Resend (address + single-use link only, HTTPS)
                ├──B4── Cloudflare Turnstile (token verification only)
                ├──B5── backup store (Litestream → S3/R2/B2, whole DB file)
                └──B6── host/process (env, SQLite file, WAL, dumps)
Accounts ──B7── each other (requireSession + user_id on every user-data query)
```

| Boundary | Enforcement in code | What crosses | What must never cross |
|---|---|---|---|
| B1 browser↔server | Verified HTTPS (nginx + certbot, or Cloudflare proxy to VPS); `HttpOnly; SameSite=Strict` cookie; origin check on mutations (`isSameOrigin`, `lib/auth.ts`); per-request CSP nonce (`middleware.ts`, `lib/security-policy.ts`); security headers (`next.config.ts`) | Session cookie, job facts/verdicts/apply links (full advert text stays server-side — it is the employer's text, not the user's) | Passwords (only hashes stored), secret values, secrets in bundles/localStorage/URLs |
| B2 server↔job sources | Source registry + admin-only gating (`lib/job-adapters.ts`); `VPN_ENFORCED` launcher for restricted sources; URL validation (`lib/job-sources.ts`); fixed delays + hard caps, no evasion (`lib/jobsch.ts`) | Role keywords, locations | Account e-mail, credentials, saved-job state |
| B3 server↔Resend | Plain HTTPS fetch, no SDK (`lib/email.ts`); `.dev.vars.example` documents key handling | Address + single-use link | Anything else about the workspace |
| B4 server↔Turnstile | Secret read only in `turnstileSecrets()` (`db/runtime.ts`), never serialized; sitekey is public | Token verification | `TURNSTILE_SECRET_KEY` in responses/bundles/logs |
| B5 server↔backup store | Litestream tails WAL → off-box S3-compatible bucket (`deploy/litestream.yml`); secrets from environment, never from the yml | Whole SQLite file incl. P1–P8 rows (**plaintext today — F11 gap**) | Decryption keys bundled with the backup (must stay separate under F11) |
| B6 host/process | systemd `EnvironmentFile=/etc/ikbeneenappel/env` root-owned `0600` (`deploy/*.service`); `.dev.vars.*` gitignored; `wrangler secret put` on Cloudflare; `SQLITE_PATH` file permissions | Necessary values injected at runtime only | Secrets in Git, bundles, command arguments, logs, error messages, tracker content, model prompts |
| B7 account↔account | `requireSession()` (signed revocable session + active-status re-read, `lib/guard.ts`) **plus** `user_id` binding in every user-data query; uniqueness scoped per owner (migration 7); admin role checked per request | Nothing cross-account by design | Any row of another `user_id` (four such leaks were caught in review — see AGENTS.md; exercise tenancy as a second account with new data) |

## 4. Secret lifecycle

"Fail closed" means: the app refuses to serve / use the feature rather than
running without the secret (`lib/guard.ts`, `db/runtime.ts`).

| Secret | Stored (dev/test) | Stored (prod Cloudflare) | Stored (VPS) | Injected at runtime | Bootstrap | Unlock | Rotation | Revocation | Recovery | Absent behaviour |
|---|---|---|---|---|---|---|---|---|---|---|
| `SESSION_SECRET` | `.dev.vars.<env>` via `npm run init-secrets` (per-env values) | `wrangler secret put` | `EnvironmentFile` `0600` (`deploy/ikbeneenappel-web.service`) | `process.env` → `authSecrets()` | `init-secrets.mjs`; run-local keeps a per-env file so restarts keep sessions | Process start reads env | Re-run with `--rotate` (**signs everyone out**) | Epoch bump per user; rotate for global | Re-bootstrap; old cookies stay dead | **503** "installation is not configured" — serves nothing |
| `APP_PASSWORD_HASH` | `.dev.vars.<env>` (if set) | `wrangler secret put` (if set) | `EnvironmentFile` `0600` (if set) | `authSecrets()` — currently **unread**: no route or module consumes `passwordHash`, so it gates nothing today (legacy single-password gate, superseded by per-user accounts; only `lib/auth.ts` still mentions the old `set-password` helper in a comment, and no such script ships) | Legacy; owner value if ever reactivated | Process start | Set a new hash | Unset / delete account | Owner re-sets | No effect today — nothing reads it; per-user `password_hash` rows (P1) are the live gate |
| Per-user `password_hash` (PBKDF2) | DB row | DB row | DB row | Compared in memory, never logged | Registration | Password entry | Password change | Epoch bump + status change | Password reset (P5, 1 h single-use) | Registration impossible without a password |
| `TURNSTILE_SECRET_KEY` | Empty locally → documented always-pass test pair, this computer only | `wrangler secret put` | `EnvironmentFile` `0600` | `turnstileSecrets()` | Owner sets before any public use (`docs/DEPLOY.md`) | Process start | Replace value | Replace value | Owner re-sets | Local test pair only; public registration unprotected until set |
| `TURNSTILE_SITE_KEY` | Empty locally | Plain variable | Plain variable | Served to registration form | — | — | — | — | — | **Public/nonsecret** by design |
| `RESEND_API_KEY` | Empty locally (mocked endpoint in tests) | `wrangler secret put` | `EnvironmentFile` `0600` | `emailConfiguration()` | Owner sets (`docs/DEPLOY.md`) | Process start | Replace; revoke at Resend dashboard | Replace; revoke at provider | Owner re-sets | Signup still works; verification/reset e-mails unsent |
| `RESEND_FROM` | Empty locally | Plain variable | Plain variable | `emailConfiguration()` | — | — | — | — | — | **Nonsecret** configuration |
| `INDEED_API_KEY` / `INDEED_USER_AGENT` / `INDEED_APP_INFO` | `.dev.vars.<env>`, empty by default | Not set (experiment never enabled on hosted prod) | Not set | `indeedConfiguration()` (loopback-admin only) | Explicit local/admin experiment only (`docs/INDEED_TESTING.md`) | Operator profile file, loopback only | Replace profile | `INDEED_ENABLED=false`; cooldown/pause in `indeed_control` | Re-issue with provider | Sources report unavailable; nothing else breaks |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | `.dev.vars.<env>`, empty by default | Plain variables or secrets (low-sensitivity quota keys) | `EnvironmentFile` | `aggregatorCredentials()` | Provider signup (free tier) | Process start | Replace at provider | Unset → source unavailable | Re-issue | Source reports unavailable |
| `CAREERJET_API_KEY` / `REFERER` / `USER_IP` | Local-admin only, never hosted | Never set on hosted/public | Never set | `aggregatorCredentials()` | Publisher account | Process start | Provider-side | Unset | Re-issue | Source unavailable |
| Litestream replica (`AWS_*`, `LITESTREAM_REPLICA_URL`, endpoint, region) | N/A (no Litestream locally) | N/A (D1 managed) | Same `EnvironmentFile` `0600`, never in `litestream.yml` | Litestream process env | Owner provisions bucket + credentials | Service start | Rotate at provider, update env file | Revoke at provider | **Separately protected recovery access** (F11 must demonstrate; not yet implemented) | No off-box replication |
| `ALLOW_SIGNUPS`, `VPN_ENFORCED`, `PUBLIC_REFRESH_*` | `.dev.vars.<env>` / launcher | Plain variables | `EnvironmentFile` / plain | `authSecrets()` / launcher / scheduler | — | — | — | — | — | **Nonsecret** flags; defaults are closed (`false` / unset = no-op) |

Decryption keys for F11 database/secret-store encryption do not exist yet —
there is nothing to rotate. Key custody (bootstrap, unlock, rotation,
revocation, independent recovery, keys separate from ciphertext/backups) is
the T29 investigation and the owner checkpoint before T30/T32.

## 5. Known gaps this map hands to T29/T30 (current state, not accusations)

1. The SQLite file, its `-wal`/`-shm`/`-journal`, and any `local-backups/`
   copy contain readable P1–P7 rows. A copied file passes a string scan for
   private content **today** — that scan is the baseline
   `scripts/verify-private-data-map.mjs` records, not proof of anything.
2. The Litestream replica (`deploy/litestream.yml`) ships the same plaintext
   pages off-box. F11 requires encrypted-before-it-leaves-the-host backups
   and proof Litestream works unchanged with the chosen encryption — T29
   must establish compatibility, not assume it.
3. Secrets rest in `0600` env files / `wrangler secret` store: permissioned
   plaintext, not an encrypted secret store. No rotation/revocation test
   with synthetic secrets exists yet (F11 bullet 4).
4. No browser/log/build/Git leak check runs in CI yet; that check with
   redacted evidence is F11 bullet 5.
5. D1 production has managed at-rest encryption, which is a disk layer only:
   a copied export is still readable. Volume/disk encryption is an
   additional layer where supported, never the answer to the protection
   contract.

## 6. Synthetic examples (fake; `example.invalid` namespace)

Provenance: these illustrate the categories using the schema, never real
rows. The verify script inserts same-shaped throwaway rows into a temp
database and deletes it afterwards.

```text
P1  users: id='synthetic-user-7f3a', email='synthetic-7f3a@example.invalid',
    password_hash='pbkdf2$100000$<salt>$<hash>', role='user', session_epoch=1
P2  cookie: ike_session='synthetic-user-7f3a:1:<expiry>.<hmac>' (HttpOnly; SameSite=Strict)
P5  email_verifications: token_hash='<sha256-of-token-never-stored>', user_id='synthetic-user-7f3a',
    expires_at='<now+24h>'   (usable token exists only in the sent e-mail)
P6  search_roles: user_id='synthetic-user-7f3a', position=0, role='synthetic-widget-engineer'
P7  vacancies (public): id='synthetic-vac-9c1e', title='Synthetic Widget Engineer',
    description='Public advert text, English-only, fictional employer.'
    user_vacancy_state (private): user_id='synthetic-user-7f3a', job_id='synthetic-job-9c1e',
    is_saved=1, application_status='not_applied', visibility_status='active'
P8  public_refresh_state: source_key='<public-source>', lease_token='<opaque>',
    cursor='<resume-position>'   (no user_id by design)
P9  artifacts: /tmp/synthetic-XXXX/check.sqlite, check.sqlite-wal, check.sqlite-shm
```

## 7. What was already true before this map (no re-verification claimed)

- Tenancy rules, origin/CSP posture, and `/privacy`–`/sources` accuracy
  (`docs/FUNCTIONALITY_MAP.md`, `tests/tenant-route-bindings.test.ts`,
  `tests/privacy-policy.test.ts`, `tests/source-policies.test.ts`).
- Backup copy/restore shape (`scripts/verify-local-backup.mjs`,
  `scripts/verify-sqlite-import.mjs`, `scripts/verify-sqlite-restore.mjs`).
- Password hashing parameters, session signing, single-use hashed email
  tokens (`tests/auth.test.ts`, `tests/email.test.ts`).

This map adds the missing piece: one place naming every private category
with its storage, encryption state, key access, and retention, plus the
trust boundaries and the full secret lifecycle — against which T29/T30
changes can be diffed.
