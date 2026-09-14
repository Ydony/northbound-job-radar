# Handover

## 2026-09-09 Careerjet decision (#31)

Careerjet is retained as a **local administrator-only discovery source**. It is not a public or
hosted feature. Leave `CAREERJET_API_KEY`, `CAREERJET_REFERER` and `CAREERJET_USER_IP` unset in every
hosted environment; local use is allowed only with a correctly registered publisher site/key and
real request details. The server-side audience gate and the `jobviewtrack.com` storage alias remain
mandatory.

The existing 237 leads were deliberately preserved. They produced zero English-confirmed jobs and
233 `unknown` verdicts because the API supplies 279-character teasers, but they may still be useful
for an administrator to inspect manually. A Careerjet result must never be presented as proof that
English is sufficient. The admin conversion report is the basis for any later retirement decision.

The current official publisher documentation was rechecked before recording this decision. It
requires a unique key per publisher website, the real end-user IP and user agent, and an originating
page Referer. The current placeholder registration remains unresolved and is not permission for a
public integration. No database rows, credentials, environments or running servers were changed.

## 2026-09-09 Adzuna public-tier decision (#30)

Adzuna is retained as an administrator-only coverage measure and removed from ordinary accounts.
The current publisher terms permit listing publication and personal research, but the standard API
only supplies the 500-character teasers that produced zero English-confirmed jobs. Full job details
are a separate Adzuna data service; the app does not follow redirect targets to copy third-party
text.

Both adapter keys and the stored result hosts (`adzuna.ch`, `adzuna.nl`) are in the server-derived
administrator-only set. This hides existing jobs, future searches and per-run rows from ordinary
accounts while preserving the administrator conversion report. No rows or detector verdicts are
changed. The administrator result view acknowledges “The Adzuna API” and links to the relevant
local domain. `/sources` now uses the same audience split, so it does not disclose Adzuna or the
other private discovery sources to an ordinary visitor.

Source decision and current terms links are in `docs/SOURCE_POLICY.md` §3. Verified against an
isolated copy of the populated test database: the administrator received 346 visible Adzuna cards
and Adzuna run rows, with all four hidden keys advertised to the client-side preview. A fresh
ordinary account received zero jobs after importing its own `adzuna.nl` row, received no private
source names, and its `/sources` page did not contain Adzuna; the administrator page did. All 155
tests, lint, typecheck and the production build pass. The temporary port 3013 Worker was stopped;
the owner's dev/test servers and databases were not touched.

## 2026-09-14 — stored duplicate links (#50)

Implemented in isolated branch `ai/recluster-stored-jobs-20260914-132120-382758`;
not yet integrated into the owner's primary checkout or its saved test workspace.
The GitHub board is https://github.com/users/Ydony/projects/4.

- Previously `/api/state` reclustered only if a job had an empty `cluster_key`. Existing
  links therefore retained the old date rules, hiding some distinct reposts indefinitely.
- Migration 17 adds an indexed per-row `cluster_version`. Version 16 is reserved for the
  separately pending Job-Room backfill in PR #52; do not reuse that number when integrating.
- `ensureCurrentJobClusters` rechecks the whole signed-in account if any member is stale.
  New imports default to stale; normalization invalidates links after changing matching fields.
  Keyless jobs are marked complete too, so they do not force repeated full recomputation.
- Each batch writes links and versions together. An interrupted later batch leaves stale
  members, so the next read retries the whole group. No user actions, verdict corrections,
  dismissal tombstones or other accounts are rewritten by clustering.
- Validation: 159 tests, lint, typecheck and build passed. Four new tests exercise real D1
  SQL for a populated pre-upgrade table, owner isolation, personal-state preservation,
  a 51-row interrupted batch, new imports and normalization invalidation.
- `scripts/verify-cluster-workflow.mjs` passed against isolated hot-reload dev and the built
  test Worker, each with newly registered ordinary accounts and synthetic data. It checks CV
  upload, criteria, duplicate folding, distinct reposts, actions, correction retention,
  cross-account mutation refusal and dismissal on repeated import. No external sources are called.
  Test verification used port 3011 and an **absolute** `--env-file` path; a relative one initially
  omitted the session secret and returned 503. The normal test launcher already uses an absolute path.
- Fresh owner-workspace backups were created and hash/restore-copy verified before work:
  `local-backups/test/2026-09-14T11-22-07-004Z` and
  `local-backups/dev/2026-09-14T11-22-07-951Z` in the primary checkout. No saved owner data was migrated.

Next: review/integrate this branch with the existing unpushed primary commits, then promote to
the owner's stable test environment. Public hosting, new sources and pagination are separate tasks.
The historical sections below still contain older counts and superseded feature descriptions.

## 2026-09-08 Job-Room legacy-description backfill (#29)

Implemented on the isolated `ai/source-portfolio-20260908-165232-234475` branch; it has not been
applied to the stable test workspace. The administrator page now has a manually triggered
**Backfill Job-Room descriptions** action for the signed-in administrator's own stored jobs.

- It selects only `job-room.ch` rows below the existing 900-character full-text threshold, fetches
  at most 120 details per run, and keeps the existing fixed 400 ms pace. Failed details remain
  eligible for a later retry.
- Migration 16 adds `job_room_detail_version`. A successful detail fetch is marked even when the
  source's complete advert is unusually short, so rerunning never loops over it forever.
- A longer detail replaces only the description and derived language/CV/workplace analysis.
  Saved, applied, dismissed, duplicate, and `language_feedback` state are not updated.
- The report shows attempted, fetched, updated, already-complete, failed and remaining counts plus
  every raw detector transition such as `unknown → blocked`. User corrections continue to control
  the effective verdict because they remain separate.
- The backfill's structured/prose precedence is covered with the same cases as normal Job-Room
  search: employer-declared local requirements and explicit blocking text both win.

Verification: all 128 tests on this branch, lint, typecheck and the production build pass. Migration 16 was applied
to a verified offline backup containing 1,004 jobs and two language-feedback rows; job/action and
feedback counts were unchanged. A fresh throwaway local Worker on port 3012 fetched one current
Job-Room detail, expanded 215 characters to 1,476, changed `unknown → blocked`, preserved card
state, refused an ordinary account with 403, and fetched zero rows on rerun. That temporary server
was stopped; the owner's dev/test servers and saved state were not touched.

After this branch is reviewed and merged, rebuild test, sign in as its administrator, and run the
button until Remaining reaches zero. The issue's measured 234 short rows should require two runs,
apart from any detail failures that need a retry.

## 2026-09-07 integration planning handover

The owner now intends a free public service plus separate administrator discovery. Read
[PUBLIC_ADMIN_INTEGRATION_PLAN.md](PUBLIC_ADMIN_INTEGRATION_PLAN.md) for the recommended source
allocation, architecture, ordered INT-01 to INT-14 task specifications and existing issue links.
It supersedes older future-scope/source-permission assumptions below, not the current runtime.

Documentation only was changed: no adapters, schedules, accounts, secrets, database state or
servers were changed. Dev/test remain local. Public sources need permitted reuse; uncertain or
restricted sources stay admin-only under the owner's accepted risk. UWV and Job-Room permission
is an explicit owner planning assumption, not independently verified evidence. UWV still needs
an actual retrieval interface. EURES is proposed admin-only; its currently public-enabled registry
has not yet been changed. No guarantee against IP blocking is made.

Next implementation step: INT-01 source-policy consolidation, followed by server-side audience
isolation and collection budgets. The GitHub board remains the execution tracker. The sections
below are the 2026-08-31 historical snapshot; do not treat their counts, incomplete-task labels,
or removed-schema references as current verification.

Last updated: 2026-08-31, after the project was converted to isolated local-only dev and test
environments.

**Read `docs/TASKS.md` first** — it is the ordered list of what still needs doing, with the
blocking items at the top. This file explains where the project is and the things that will
surprise you. `AGENTS.md` holds the rules that must not be broken.

## 1. What this is

A private job-search tool for Switzerland and the Netherlands, for someone whose usable working
language is English. It gathers public job advertisements, screens each one for whether English
alone is enough, and scores it against the user's CVs.

Product name is **Ik ben een appel**. Active interface and setup references use that name.

## 2. State right now

Working and verified locally:

- Multi-user accounts with per-account isolation. Every table has an owner column and all queries
  are scoped. A second account genuinely cannot see or touch the first's data — tested.
- Sign-in, sign-out, account settings, account deletion, and an administrator panel.
- Seven job sources: Job-Room (67k Swiss vacancies, no key), Adzuna (CH + NL), Careerjet (CH + NL),
  61 public company career boards, and three page-fetching sources restricted to administrators.
- `dev` at `http://localhost:3000` with disposable state under `.wrangler/dev/state`. **Its
  database is empty** — no jobs, no CVs. Task A3 needs an account registered and a CV uploaded
  there first, which is deliberate: testing against freshly created data is exactly what exposes
  the write paths that adopted data never touches.
- `test` at `http://localhost:3001` with a stable built Worker and separate state under
  `.wrangler/test/state`.
- The populated test workspace contains 916 jobs, 2 real CVs, and 12 recorded search runs.
- The local-environment change passed `lint`, all 90 tests, `typecheck`, and `build` on 2026-08-31.
  The built test Worker was then restarted and `/login`, `/privacy`, and `/sources` returned 200.
- Isolation between the two environments was independently re-verified on 2026-08-31 by signing in
  to each and cross-sending the cookies: a test session against dev returns 401 and a dev session
  against test returns 401, and the two workspaces differ (test 916 jobs and 2 CVs, dev empty). The
  separation is real, not just configured.

Not built yet: self-service password reset, email verification, pagination past 1,000 jobs, and
backups. All listed with context in `docs/TASKS.md`.

## 3. Things that will surprise you

**Both administrator passwords must be treated as compromised.** Test uses
`admin-test@ikengels.test`, dev uses `admin-dev@ikengels.test`. The generated passwords for both
were posted in plain text into a chat transcript, so they are exposed — not merely temporary. The
owner must change the email and password on **both** environments in `/settings`, not only test.
Changing a password also revokes that account's existing sessions. Never write these into a file,
a commit, or a chat message.

**Registration is closed by default.** `ALLOW_SIGNUPS=false`, so only the first account on an
empty database can be created. To add a second account in dev, set `ALLOW_SIGNUPS=true` in
`.dev.vars.dev` and restart dev. Test has its own `.dev.vars.test`; do not open it casually.

**There is no supported hosted environment.** A short-lived hosted test was removed from public
access on 2026-08-31. Do not deploy again without a new explicit owner decision; see
`docs/DEPLOY.md`.

**The first account created claims any ownerless data.** Rows left from the single-user era carry
`user_id = 'legacy'` and are adopted by the first account registered. On an empty database this
does nothing.

**Sources sit in three tiers, and the tier decides who can run them.** `authorized-api` (keyed or
official APIs) and `grey-area` (public pages whose robots.txt permits the paths read and whose terms
say nothing) run for everyone. `restricted` means the site explicitly prohibits automated access or
actively blocks it: administrator only, and refused unless the process was started through
`npm run dev:private`, which verifies a full VPN route and sets `VPN_ENFORCED`. The button label is
not the enforcement; that env marker is.

**Page-fetching of restricted sites is administrator-only, and that is enforced server-side.** A non-admin calling
`/api/scrape` with `mode=all` is refused, and the names of those sources are filtered out of both
the live report and the stored history so ordinary accounts never learn they exist. The `/sources`
page hides that section from non-administrators too. Do not "simplify" this into a UI-only check.

**Uniqueness is per owner, not global.** `jobs.source_url` and `cvs.slot` are unique per
`user_id`. They were global, which would have let the first user to import a vacancy block everyone
else. Migration 7 rebuilds both tables because SQLite cannot drop the implicit index a `UNIQUE`
column creates. If you add a table holding user data, scope its uniqueness the same way.

**Sessions carry an epoch.** The cookie holds `userId:epoch:expiry`, signed. `requireSession`
compares the epoch against the account, so raising it revokes every existing cookie. Changing a
password, disabling an account, or resetting its password all do this. Changing the cookie format
signs everyone out, which is expected.

**Careerjet cannot work from Cloudflare.** Its key is bound to at most 8 declared IPs, and Workers
have no static outbound IP. See `docs/TASKS.md` A2 for the options.

**`ensureSchema()` runs migrations on the first request**, in order, recorded in
`schema_migrations`. It also backfills job identities and work types, and purges `auth_events`
older than 30 days. It is safe to call on every request and memoised per instance.

## 4. Rules that are not negotiable

From `AGENTS.md`, repeated because they are easy to erode:

- **No detection evasion, ever.** No randomised or human-imitating timing, no fingerprint spoofing,
  no stealth browser plugins, no proxy or IP rotation. This held even when the no-scraping rule was
  reversed, and it is not up for reconsideration.
- **Page-fetching stays manually triggered, capped, unauthenticated, and administrator-only.**
- **Prefer false negatives on "English is sufficient".** A wrong `pass` wastes a real application.
- **A user's CV never leaves the server.** Not to a job site, not to an aggregator, not to any
  model.
- `/sources` and `/privacy` describe what the code actually does. If you change data handling,
  change those pages in the same commit or they become a lie.

## 5. Where things live

| Area | Files |
|---|---|
| Auth, sessions, guard | `lib/auth.ts`, `lib/guard.ts`, `lib/users.ts` |
| Sources | `lib/job-adapters.ts` (registry), `lib/job-room.ts`, `lib/job-aggregators.ts`, `lib/ats-feeds.ts`, `lib/jobsch.ts` |
| Screening | `lib/analysis.ts` (language gate, fit score), `lib/workplace.ts`, `lib/role-detection.ts` |
| Storage | `db/runtime.ts` (schema + migrations runner), `db/migrations.ts`, `lib/server-data.ts` |
| Pages | `app/job-radar.tsx` (dashboard), `app/login`, `app/settings`, `app/admin`, `app/sources`, `app/privacy` |
| Docs | `docs/TASKS.md`, `docs/ENVIRONMENTS.md`, `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` |

## 6. Working on it

```bash
npm run dev          # hot-reload dev at http://localhost:3000
npm run test:local   # stable local build at http://localhost:3001
npm test             # 90 tests
npm run lint
npm run typecheck
npm run build
npm run init-secrets # creates separate .dev.vars.dev and .dev.vars.test secrets
```

All four checks must pass before a commit. `.dev.vars.dev` and `.dev.vars.test` hold local secrets
and are gitignored; `.dev.vars.example` documents every variable.

The test launcher intentionally runs the emitted Cloudflare Worker with Wrangler rather than a
second hot-reload Vinext server. This makes the test instance both production-build-equivalent and
independent of dev while keeping all traffic and data on loopback/local disk.

Environment notes: only one hot-reload `vinext dev` can run per project. `test:local` runs the
built Worker through Wrangler, so dev and test can run together. On Windows, Git Bash needs
`taskkill //PID <pid> //F` with doubled slashes.

## 7. A caution from experience

The multi-user change touched 61 queries across 8 routes. A pre-deployment review then found that
CV upload had been completely broken by it — the insert never set `user_id` — and that four other
routes had cross-tenant defects, including a workspace reset that would have deleted **every**
account's jobs.

None of that showed up in ordinary use, because the existing data had been adopted rather than
freshly created. When you change anything touching tenancy, exercise the whole flow as a **second**
account with **new** data, not just the account that already has rows.

## 8. Next action

The environment conversion is complete. Continue at `docs/TASKS.md` A3: exercise the entire dev
workflow as a fresh second account, report findings before fixing them, and verify cross-account
access fails. A1 remains a personal owner action, and now covers both environments: replace the administrator
email and password in `http://localhost:3001/settings` **and** `http://localhost:3000/settings`,
because both passwords were exposed in a chat transcript.
