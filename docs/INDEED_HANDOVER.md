# Indeed handover — current as of 2026-09-23

## Final cap activation (#126)

The active collector now permits at most 200 upstream listing rows for each of the
first two distinct roles in each selected country, at most 800 rows/32 requests
for the whole click. It still asks for only 25 rows per page, keeps the seven-day
date request and local posting-date check, stops on exhaustion/refusal/cancellation,
and marks capped results partial. The administrator panel reads the same active
budget constant. The CLI uses the same server route and now has a 16-minute
search timeout, longer than the 15-minute collection lease; login/status remain
shorter. The ceilings are not a target, exhaustive coverage or a provider-safe quota.
Synthetic tests exercise eight-page and whole-run boundaries. No 800-row live
load test is authorized or claimed. The final branch passed 407 tests, lint,
typecheck, build and the static design check (11/11). A one-request live
collector smoke check returned five Dutch rows; an immediate identical repeat
sent zero requests and stayed partial. The visual harness did render a synthetic
job card at desktop/wide/phone, but failed its existing 16px type-ladder and
phone first-card-height assertions (four failures). #126 changes no stylesheet
or job-card layout; those visual failures remain separate UI debt, not a passed
check. Owner TEST and its data were not changed by the final-cap branch.

## 2026-09-23 Codex verification and collection correction (#69/#118)

The owner-approved local profile was exercised in an isolated built Worker, not in
the owner's TEST data. One website search (two provider requests, one role in NL
and CH) returned 25 rows per country and saved 26 distinct jobs: 15 CH, 11 NL;
10 passed the English gate, 8 need review, and 8 were blocked. A later operator
search against that same isolated account returned 50 rows, found 26 already
known, added zero and left saved statuses intact. Both capped queries remained
**incomplete**: a cap is not evidence of total catalogue coverage. The separate
synthetic acceptance script passed two normal accounts, guessed IDs, admin denial,
demotion, exports and reset isolation without provider traffic. After the query
correction, all 407 tests, lint, typecheck and build passed.

A single bounded live contract probe on 2026-09-23 requested five Dutch rows,
Amsterdam at 12 miles, `sort: DATE`, and `dateOnIndeed` start `168h`. It returned
HTTP 200, no GraphQL errors, five NL rows dated that day and a continuation
cursor. This verifies acceptance of the query shape, **not** exact oldest/newest
ordering, location-radius precision, full seven-day coverage, or a provider-safe
quota. The project now sends this query shape, still checks `datePublished`
locally, reuses a capped sample for 15 minutes instead of re-requesting the
same first page, and keeps a rolling seven-day window. Query identity v2 keeps
the old relevance-only checkpoints separate. Future complete checkpoints mean
only that the available filtered pages were exhausted; they are not a guarantee
that every job was indexed or returned. A separate one-request test through the
actual collector returned five Dutch rows and kept five; an immediate identical
repeat made **zero** upstream requests and stayed marked partial. This used
disposable D1 and did not modify the owner's TEST database. This paragraph records
the lower-budget evidence **before** #126 activation.

The following September 22 section is historical. Spark (public code + synthetic fixtures only) implemented the IND-Next series on
`ai/indnext-spark-20260922-220000`, reusing the timed-out #113 partial worktree as
reference. Codex owns configuration, live verification (#118), independent review
(#69) and lead review; #126 (200/800 activation), epic #112 and this task stay open
until those gates pass. No live Indeed calls were made by Spark and none are claimed.

## What changed since 2026-09-21

- **#113 settings:** per-account NL/CH place + kilometre radius
  (`GET`/`PUT /api/admin/indeed/settings`, migration v26 `indeed_settings`).
  Admin-only end to end (API 403, `/api/state` carries them for admins only,
  deleted with account/workspace). Defaults (Amsterdam/Switzerland, 16 km = 10
  provider miles) preserve previous behaviour. First-two-roles semantics and the
  five shared inputs unchanged.
- **#114 collection:** budget-parameterised collector (`INDEED_RUNNING_BUDGET`:
  25/query, 100 total, 1 req/query, ≤4/click — live and unchanged;
  `INDEED_FINAL_BUDGET`: 200/800 — design + synthetic tests only, owned by #126).
  New 168-hour local recency window (unknown dates kept); upstream sends
  `sort: RELEVANCE`, so newest-first remains unverified, stated, not assumed.
  Ceilings count upstream rows; cap/failure/cancel statuses stay truthful.
- **#115 checkpoints:** per-query coverage (`indeed_coverage`, migration v27)
  keyed by owner/role/country/place/radius/version. 15-minute repeat-click reuse
  with no upstream request (never self-extending); incremental windows from the
  last successful boundary minus 6h overlap; coverage advances to the run start
  only on full exhaustion, never on failure/cap/cancel; in-flight clicks attach
  via the lease instead of duplicating requests. No background fetching.
- **#116 website:** admin-only panel with place/distance editing + feedback, the
  two roles actually sent, live caps as caps-not-targets, latest run
  returned/new/known/matched with messages, and per-query coverage after Check
  readiness. Shared copy corrected (Indeed receives only the first two roles).
  Double-click guarded synchronously; readiness/coverage endpoint unchanged
  except an added per-owner coverage list.

## Evidence ledger

- **Mocked/synthetic (407 unit/integration tests pass, plus lint, types, build):**
  settings validation/units/migration/tenancy, budget caps (25 and 200/800),
  exhaustion, page failure, cancellation, country switches, window filtering,
  checkpoints (reuse, incremental, caps, failure, owners, attach, late jobs),
  refusal/cooldown latches, cursor protection, dismissal/isolation, UI render.
- **Live (dedicated synthetic DEV, no provider calls):** settings GET 200 with
  defaults / 403 for ordinary / hidden from ordinary state; preview totals
  server-side; panel renders with roles/settings/run report, save + restore
  round-trip, zero console errors on desktop and 390px.
- **Not tested by Spark:** any upstream request; 100-row pages (25 stays the
  page size); newest-first/date-filter upstream support; built-test flows and
  disposable-server acceptance (would disturb owner servers); Settings PUT
  against live storage (unit-covered only, to avoid mutating reusable accounts).

## Still required before close

Codex bounded live proof (#118, incl. recency/newest-first evidence and the
readiness configuration this DEV lacks), independent #69 verification, lead
review of all four commits, then #126 activation with its final regression pass
(swap to `INDEED_FINAL_BUDGET`, synchronise displayed caps, re-run evidence).
`npm run build` passed 2026-09-22 on the #116 tree.

---

## Current operator module (September 21 follow-up)

The reusable entry point is now `npm run indeed -- search --env test`, or the existing
dashboard's **Search Indeed only** button. Setup/login are one-time local operations;
neither transport research nor a readiness click is part of an everyday search. See
[INDEED_TESTING.md](INDEED_TESTING.md) for setup, exact commands, Node API and recovery.

The CLI delegates to the existing authenticated `/api/scrape` route with `sourceGroup=indeed`.
It uses the platform's saved criteria, account-scoped storage, screening, deduplication,
dismissal memory and reports. It is not a second ingestion implementation or database.
This work is isolated on `ai/indeed-acceptance-followup-20260921-180342-938897` until reviewed
and promoted. The primary checkout/server is not silently upgraded.

**Correction to the older credential section below:** provenance is known. The private
acceptance launcher read the explicitly approved JobSpy revision
`fda080a373e8226f3fd60635323f5da9af9892b1`; it was not an unexplained operator-supplied key.
The new explicit `setup --approved-jobspy` command reproduces that configuration and saves
it to the selected ignored local vars file. A routine search never downloads it again.
This does not establish provider partnership rights, indefinite validity or public-use permission.

Live CLI test against the built Worker: 25 Dutch rows, 12 previously known, 2 new jobs saved
(one pass, one review), using a persisted app session and no readiness request. The earlier
integrated test already verified both NL and CH. Fresh dev synthetic-account acceptance
passed for guessed IDs, ordinary-user denial, demotion, private/public duplicate separation,
feedback/export visibility, saved/applied/dismissed preservation and reset isolation.
The developer verifier is separate from the module and must never be a prerequisite to search.

The historical sections below describe the previous checkpoint. In particular, the statements
that provenance is unknown and `INDEED_TESTING.md` is absent are superseded by this section.

This file replaces `INDEED_WIP_HANDOVER.md` (2026-09-20), four of whose six load-bearing claims had
become false. It was the first thing anyone picked up the work would read, and it would have
sent them to fix a closed vulnerability and to set the language normalization baseline four
versions backwards — a downgrade that same document warned was dangerous. If you are reading
this to continue the work, start here and treat anything older as history.

## What is true now

**The integration is on `master`.** The commit titled "WIP … DO NOT MERGE" (`1159df5`) is an
ancestor of `master`. Nothing is waiting to be merged.

**Retrieval works, and was proved live on 2026-09-21.** Two requests returned 25 rows each;
27 advertisements were stored after filtering, 14 Swiss and 13 Dutch. No phone was involved,
which settles the phone-dependency question the acceptance list asks about: the transport
needs no device.

**The retrieved data is the best-quality of any source in this app.**

| | Indeed, 27 advertisements | For comparison |
|---|---|---|
| Description length | 2,692–8,200 chars, mean 5,115 | EURES NL arrives cut at ~2,000; Job-Room previews fall under 900 |
| Missing posting date | 0 | #88 had 193 of 193 dateless |
| Missing company | 0 | most cards elsewhere read "Company not added" |
| Truncation markers | 0 of 27 | EURES NL ads end in "..." |

Every one of the 27 ends on a real document boundary — equal-opportunity boilerplate, a
privacy statement, a reference code, a recruiter's address. **No teaser appeared in the
sample.**

## Superseded — do not act on these

These were open questions in the previous handover and are now settled. They are listed so
nobody re-opens them.

- *"Do not merge this WIP as-is."* It is merged. See above.
- *"Language normalization is version 7; this draft changes baseline 5 to 6; NEVER downgrade."*
  `NORMALIZATION_VERSION` is **10**. The rule is still right: never lower it.
- *"Check migration 18 remains free."* Runtime migrations run to **24**.
- *"P1, still NOT fixed: `app/api/feedback/route.ts` exports all corrections without filtering
  private sources, so a demoted administrator can read back Indeed rows."* **Fixed.** The
  export now joins on `j.user_id = f.user_id` and excludes administrator-only sources in SQL
  before the `LIMIT`, matching `/api/state`. There is a test for it.

## The language rule, and why it changed

`languageForIndeed` used to force `unknown` on everything the shared gate did not block. The
effect was an asymmetry nothing justified: the app trusted Indeed's text enough to **reject** a
job on it — 8 of the 27 were correctly excluded as Dutch, German or French, each with a
specific reason — while never trusting it enough to **accept** one. No Indeed job could reach
the matches list whatever it said, so the one source delivering complete advertisements was
the only one forbidden from confirming they were in English.

It now defers to the same gate as every other source. That gate already withholds a pass from
text it cannot vouch for: under `MIN_CHARS_TO_CONFIRM_ENGLISH` (900) characters, or ending in
an ellipsis, it returns `unknown` by itself — protection written for the truncated EURES ads
and applying here unchanged. Indeed adds exactly one check the shared gate has no reason to
carry: a teaser ending in a "read more" link rather than an ellipsis, tested against the tail
only, because "read more about our benefits" is ordinary copy mid-advertisement.

Verified behaviour, pinned by tests in `tests/indeed-integration.test.ts`:

| Advertisement | Verdict |
|---|---|
| Complete, English | `pass` |
| "Dutch is a plus" | `review` |
| "Dutch is required" | `blocked` |
| Ends with "Read more" | `unknown` |
| Ends with "..." | `unknown` |
| Under 900 characters | `unknown` |

`NORMALIZATION_VERSION` moved 9 → 10 so stored rows are re-screened on read.

## What still blocks this being finished

**A credential, and it is the owner's decision.** No key exists anywhere on disk — that is
deliberate, and `.env.acceptance-unused` is an intentionally empty placeholder saying so. The
live run took its values from the operator's shell. Consequences:

- `INDEED_API_KEY` and `INDEED_APP_INFO` are empty in `.dev.vars.dev` and `.dev.vars.test`, so
  both environments report `not configured` and send no requests. This is why Indeed appears
  to do nothing there.
- The live result is not reproducible without the operator supplying those values again.
- **The provenance of that credential is not recorded anywhere, and should be before anyone
  calls this complete.** Note what the transport implies: a static 64-hex key plus an
  `indeed-app-info` header against `apis.indeed.com/graphql`, working from any machine with no
  device enrolment. Whether that is a credential the project is entitled to use is a question
  for the owner, and #69 is the place to record the answer.

**The rest of the #69 acceptance list.** Not yet done: two independent normal accounts, guessed
IDs, exports, denied administrator operations, disable/disconnect, and 401/403/429 stop
behaviour simulated rather than provoked. All of it is testable with fixtures against real D1 —
**no credential needed**.

**`docs/INDEED_TESTING.md` does not exist** and the acceptance list requires it: setup,
credential renewal and disconnect, request caps, troubleshooting.

## Where the evidence lives

The 27 retrieved advertisements are in the worktree
`ajh-indeed-acceptance-followup-20260921-180342-938897`, under
`.wrangler/indeed-live/state/v3/d1/`. **Worktrees get cleaned up.** If that data matters to
you, copy it somewhere durable before it disappears — every measurement in this document came
from it, and re-obtaining it needs the credential again.
