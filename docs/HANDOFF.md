# Handover

## 2026-09-21: the reviewed design, and how to check against it

The interface was reviewed with the owner and redesigned frame by frame. **The agreed design
lives in [`docs/design/canvas/`](design/canvas/) — open `index.html` in a browser.** Thirteen
frames covering every window, including the phone views and both panels opened.

Work on it is tasks **UX-6a** to **UX-6g** on board #4. Each carries its full specification
inline, because the canvas they came from is a private artifact nobody else can open.

Before calling any of them done:

```bash
node scripts/check-design.mjs
```

It settles the mechanically checkable half — token values, the 12/14/17/24/32 ladder, the 12px
floor, and three structural changes — and names the reason behind each value. It cannot judge
layout, so also open `docs/design/canvas/index.html` beside `npm run dev` at 1400px and 375px,
signed in. **Nothing tests `app/job-radar.tsx`**, so a green gate is not evidence a screen is
right.

Colour was measured, not chosen: the old `--muted` `#657169` was **4.88** against cream while
carrying most of the supporting text, and `--signal-neutral` `#9aa09a` was **2.56**, which
fails. Do not nudge these values without re-measuring.


## 2026-09-20 close-out: CSP on a nonce, filtering in SQL, the dashboard partly tested

Master is green: lint, typecheck, **289/289**, build, and `npm run verify:dev` end to end.

- **#2 `'unsafe-inline'` is gone.** `middleware.ts` mints a per-request nonce; the header is set on
  the *request* as well as the response, because that is where vinext reads it to stamp the script
  tags. The policy builder is in `lib/security-policy.ts` so the tests read the same one the
  middleware uses, and a test asserts `next.config.ts` never sends a second policy - two policies
  means the browser enforces the intersection. Verified in a browser, not inferred: nonce rotates
  per request, all 79 script tags carry it, and the page hydrates.
- **#3 filtering and paging are in SQL** (migration 21, `search_text`, accent-folded because SQLite
  LIKE cannot fold). The audience rules moved but did not change, and are now shared by the page and
  both counts: administrator keys excluded in SQL, Indeed hidden from ordinary accounts by URL
  pattern as well as by key.
- **#17, #72, #79, #80, #83, #84, #85, #86** all merged. The Indeed epic **#63 is closed**.

**Two things that are true and easy to forget:**

- A **blob-URL Web Worker is blocked** by `worker-src 'self'` (#87). Pre-existing, not from the CSP
  change. The only worker in app code is pdf.js for PDF CV parsing, which is dormant behind
  `CV_MATCHING_ENABLED = false` - so if that flag is turned back on, check this first.
- Workers wedge silently when they stop to ask permission for a tool call. `pm.py` now closes their
  stdin and bounds each run at 45 minutes; before that, two runs sat for over ten minutes producing
  a zero-byte log while `progress` reported them as "just started".

**Nothing dispatchable is left in the queue.** What remains is yours: #1 credentials, #8 publishing
~60 local commits, #9 branding, #7 Apify, #18-#20 (a Jooble key), #35 and #43-#48 (direction),
#73 (VPN), #81 (an independent read of the lead's own merges, which no worker the lead dispatches
can give), and #6, which is Postponed pending a source-permissions decision rather than unbuilt.

## 2026-09-20 third session: keyword filtering moved into SQL, /api/state paginates

Branch `ai/server-side-filtering-20260920-071028-819440`, unmerged. `/api/state` used to
return the 2000 most recent rows and let the client filter, so the limit was spent on jobs
the saved keywords exclude while older matching jobs stayed invisible past it. The required
and excluded keywords now filter in SQL before the limit, against a new accent-folded
`jobs.search_text` column (migration 21), and the endpoint pages with a keyset cursor
(`limit` 1-2000, `nextCursor`, `matchingJobs`/`totalJobs` counts). The dashboard loads
further pages through a "Show more jobs" button. Saved, applied and dismissed rows still
ride along when the keywords exclude them, so Pipeline and Dismissed keep showing what the
person did. `NORMALIZATION_VERSION` is unchanged; pre-migration rows are backfilled on read
without rescreening or reclustering.

Found while exercising on a fresh database: **no fresh checkout could boot past migration
18** - the base schema already carried `search_netherlands`/`search_switzerland`, so the
migration's re-ADD failed with "duplicate column name" and every request 500'd. Existing
databases never noticed (their tables predate the columns). Fixed by removing the two
columns from the base in `db/runtime.ts`; `tests/migrations.test.ts` now asserts no base
column duplicates a later ALTER.

Verification: 265/265 tests (7 new in `tests/keyword-pagination.test.ts` proving the SQL
filter agrees with `matchesSearchCriteria`, including accents and LIKE metacharacters),
lint, typecheck, build, and a live exercise of register/criteria/import/filtered paging/
ride-along/400s against isolated dev (:3020) and built test (:3001) servers, each on a
fresh database. Not done: no signed-in browser check of the new button, and workspaces
past 2000 rows were exercised with small limits rather than real volume.

## 2026-09-20 second session: Indeed merged, the gate corrected, the worker hang found

Master is green: lint, typecheck, **257/257**, build, and `npm run verify:dev` end to end.

**Indeed (#66-#69) is merged** as `18ab801`, taken over after codex-lead ran out of credits
mid-reconciliation. Its work was captured in two commits first, because all 24 files were sitting
uncommitted. It ships `disabled`, `adminOnly`, loopback-only, and all nine Indeed host aliases are
confirmed in `adminOnlySourceKeys()` - the defect class that once exposed 218 Careerjet rows under
`jobviewtrack.com`. **Not claimed:** no live upstream search, no browser or API acceptance, and
stable promotion is a separate decision.

**The language gate was wrong in four places (#79)**, found by an independent review and each one
reproduced by hand before anything was changed. All four were the same mistake: a rule measured its
reach in *characters* when it meant "this sentence" or "this noun phrase". Two false passes
(`No travel. German is required.` passed; `read and write Dutch for regulatory reports` passed) and
two false blocks (`Fluent German is required, but Dutch is a plus` blocked Dutch; `Fluent Dutch is
a plus` blocked). `NORMALIZATION_VERSION` 8 -> 9, because verdicts move in both directions.

**Source conduct (#80).** The Common Crawl index is now queried one request at a time, paced before
each start rather than after, obeying `Retry-After`; the per-request timeout covers the body; and
the two country adapters share one board collection instead of each launching a 282-board batch.

**Why workers kept producing nothing.** `pm.py` ran them with inherited stdin, so a worker that
stopped to ask permission for a tool call waited for input that could never arrive, with its output
redirected to a file so nothing was ever flushed to say so. Two runs died that way. stdin is now
closed and runs are bounded at 45 minutes. The same session's `progress` command reported such a
run as "just started" forever, which is why it went unnoticed - that label now says when there is
no log at all.

**`npm run verify:dev` had been failing on a working app**, for two unrelated reasons, both
pre-existing: it parsed only `application/json` while `/api/scrape` streams NDJSON, and it still
asserted the CV gate that `CV_MATCHING_ENABLED = false` removed. `CLAUDE.md` names that harness as
the way to check a change locally and nothing tests `app/job-radar.tsx`, so a harness that cries
wolf is worse than none. #85 covers testing the harness itself.

**Still not done, deliberately:** #2 (nonce CSP) needs a signed-in browser check and is not worker
work; #81 asks for a second opinion on the lead's own merges and cannot be answered by a worker the
lead dispatches; #43-#48 and #35 are direction decisions; #8 (publishing ~60 local commits) remains
the owner's call, and the remote master is a stale squash base still at `NORMALIZATION_VERSION` 5,
so `git merge origin/master` conflicts and must not be run blind.

## 2026-09-19 - Standalone Indeed connector works; dashboard not connected

Read the current checkpoint in [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md), not the
earlier refusal-only notes below. The owner approved the specifically discussed mobile
identity header experiment. With certificate verification intact, one minimal probe returned
HTTP 200 and a description-bearing Dutch job. Then the real TypeScript connector fetched two
Dutch jobs across two pages and one Swiss job in three bounded requests. Description lengths
were 7,534, 3,954 and 12,457 HTML characters; dates, employer and country were present.
No phone, account login, personal token or cookies were needed by this tested path.

Implemented in the existing isolated auth worktree: `lib/indeed/contracts.ts`, `auth.ts`,
`client.ts` and synthetic tests. Credentials are explicit backend config, never tracked.
Caps, timeouts, refusal/cooldown behavior, query escaping, response validation and partial
result reporting are included. This is version 1 of the downstream transport interface.

Verification: 212 automated tests passed, including 18 focused Indeed tests; typecheck,
lint and production build passed. Live evidence is limited to the three connector requests
above (plus the initial probe), not volume testing or dashboard acceptance. #64/#65 are
ready for review; downstream tasks remain separate and no stable-test promotion occurred.

The stable app has **not** been changed: #66 normalization/completeness, #67 source integration
and tenancy, #68 reporting, #69 UI/QA remain. Do not mark the whole Indeed feature done or
claim 200-400 results were tested. Records deliberately retain unknown completeness until
that is validated. No owner database, account, dev/test configuration or server was touched.

## 2026-09-19 - JobSpy comparison and second desktop probe

Latest evidence is in [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md). JobSpy's
Indeed connector has no personal OAuth flow, so the earlier OAuth-only direction
was too narrow. One owner-requested, modified JobSpy-style query for one job and
its description returned non-JSON HTTP 403. No data was retrieved and no retry ran.

The test kept certificate verification and a truthful client identity. It did not
copy JobSpy's iPhone app identity headers, so it is not evidence that unmodified
JobSpy succeeds or fails here. Preserve that distinction. Auth/client tasks remain
incomplete, adapters disabled, and the owner servers/data untouched.

## 2026-09-19 - Indeed auth evidence, not a working connector

Continue from [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md), especially the new
authentication checkpoint. Static inspection found session-derived token handling,
a renewal path and a query selecting job-description text. Private implementation
details and research artifacts stay outside this public repository.

The only desktop probe so far returned 403; no successful search/detail or token
renewal was demonstrated. Phone diagnostics did not expose a usable live auth
exchange. No account cookies/tokens were extracted, no source was enabled and no
owner servers or data were changed. #64 and #65 are still incomplete. Next needs
provider-supported dynamic evidence or provisioned desktop access, not blind
request retries or treating the embedded app key as sufficient authentication.

## 2026-09-18 - Indeed task ownership (#63)

The owner requested a multi-LLM task breakdown and explicitly assigned Indeed authentication and
connection implementation to Codex. Read [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md) for the
worker boundaries, dependencies and acceptance criteria. GitHub parent #63 and child issues #64-69
are the execution records on Project 4. Codex owns #64/#65 in run
`ajh-indeed-auth-connection-20260918-171415-590073`; other implementation tasks are unclaimed.

This checkpoint creates coordination documents only. Indeed is still disabled; no working search,
authentication lifecycle, unlimited quota or complete-description request has been demonstrated.
The owner reports authorization for local assessment. Private research and credentials stay outside
Git and public issues. Other LLMs consume a sanitized frozen contract and synthetic fixtures, not
phone or account artifacts. Contract revision 1 is the next Codex deliverable. Do not restart the
owner's server or enable the source merely because these tasks exist.
## 2026-09-20 five worker changes merged (#59, #60, #74, #75, #76)

Five isolated worker runs landed on master together. Gate green afterwards: lint, typecheck,
**220/220 tests**, build.

- **#74 loosened the language gate**, which is the change to watch. A language mention can now be
  *exempt* as well as required or optional, so an explicit denial ("No German is required"), a
  language offered as lessons, and a nationality or market use stop costing a review. Exemption is
  per-occurrence: one ordinary mention elsewhere still means review, and a requirement anywhere
  still blocks. `NORMALIZATION_VERSION` 6 -> 7 so stored rows are re-screened rather than keeping
  verdicts the old rules produced. "bilingual in X" now blocks, where it used to under-block to
  review.
- **#76** taught the excerpt where the requirements section starts in Dutch, German and French ads.
  Chosen for precision over recall; the rejected near-misses are recorded in `lib/excerpt.ts` so
  they are not re-added.
- **#75** made `fetchCompany` return an outcome rather than an empty array on every failure, and
  added exactly one retry of timeouts, network failures and 5xx. Never retries a 429 or any 4xx:
  a refusal is a stop signal. Measured at 281/282 boards and an identical 30,057 postings across
  six consecutive passes, zero 429s in ~1,700 fetches.
- **#59** added `scripts/discover-boards.mjs`, board discovery we own. **Its index half has never
  returned a candidate** - `index.commoncrawl.org` answered 502/504 all day - so a zero-candidate
  run currently means the index did not answer, not that there is nothing to find. The verification
  half is proven against live boards.
- **#60** recorded in `docs/SOURCE_POLICY.md` why employer boards carry the public tier, what an
  employer must pass to be added, and why Workday is excluded.

Epic **#54 is closed**: 60 -> 282 verified boards, Teamtailor and Workable adapters, our own
discovery, and the policy written down. No Workable *employer* is configured - every account probed
answered with an empty `jobs` array.

**No pull requests.** The remote master is far behind local master, so a PR against it reads as
thousands of unrelated additions; PR #77 was opened by the tooling and closed for that reason.
Publishing those commits is #8 and remains the owner's decision.

## 2026-09-09 restricted-source decision (#32)

Keep the small private source portfolio. jobs.ch, jobup.ch and JobScout24 remain local
administrator/VPN-only; IamExpat remains local-administrator-only without a VPN requirement;
Undutchables remains local-administrator/VPN-only because it previously blocked automation. No
source was removed, no stored rows were deleted, and no caps, schedules or access paths were added.

The reason is quality, not volume. The measured data contains 12 full-advertisement
English-confirmed jobs from this portfolio: jobs.ch 3, jobup.ch 6, IamExpat 1 and Undutchables 2,
alongside 114 confirmed jobs from the public tier. JobScout24 has no separate measured yield and is
retained on probation because it shares the existing JobCloud adapter and VPN boundary. Revisit only
after repeated successful zero-yield searches, recurring maintenance failures, changed rules or a
block.

JobCloud's current terms still prohibit automation and jobs.ch robots.txt still disallows the detail
paths read. The owner accepted that risk only for the private administrator tier. The fixed delay,
four-new-details-per-source cap, manual trigger, unauthenticated access, VPN gate and no-evasion rule
remain non-negotiable. Undutchables robots.txt is readable again and permits the exact plain listing
and detail paths used while disallowing query-string searches; its prior blocking is why the VPN
precaution stays. Running servers and local data were not touched.

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
- Configured sources include Job-Room (67k Swiss vacancies, no key), Adzuna (CH + NL), Careerjet
  (CH + NL), 61 public company career boards, and five private page-fetching adapters. Four of the
  five require the VPN launcher; all five are restricted to administrators.
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

**Sources sit in three tiers, and the tier plus `adminOnly` decides who can run them.**
`authorized-api` and `grey-area` are eligible without the VPN, but an adapter such as IamExpat can
still be administrator-only. `restricted` means the site explicitly prohibits automated access or
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
