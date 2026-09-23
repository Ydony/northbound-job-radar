# Architecture and decision record

Last updated: 2026-09-09.

> Historical decision record, not a current implementation map. CV upload, matching, R2
> storage and related API paths described below were removed on 2026-09-23. See
> `docs/FUNCTIONALITY_MAP.md` and `docs/PUBLIC_DEPLOYMENT_READINESS.md` for current state.

The accepted Swiss + Netherlands multi-source architecture in
`docs/MULTI_SOURCE_PLAN.md` is implemented. The supported runtime is now local-only with isolated
`dev` and `test` environments.

## 1. Goal and acceptance rule

The user wants Switzerland and Amsterdam-area Netherlands jobs where English alone is enough. “The ad contains the word English” is not sufficient. A match must satisfy both:

- the full job advertisement is predominantly English; and
- German, French, Italian, and Dutch are not mandatory.

Local languages described as optional, preferred, a plus, or an asset may pass, but the optional wording is shown. Any unclear mention is routed to manual review.

## 2. Source policy and the 2026-08-26/27 decisions

jobs.ch is the chosen Swiss source because of its market coverage and native search
filters. The [JobCloud terms](https://www.jobs.ch/en/terms/) prohibit crawlers,
scrapers, bots, scripting, and other automation across its platforms, and `robots.txt`
separately disallows crawling job-detail pages specifically (the pages containing the
full ad text). JobCloud publishes [technical XML solutions](https://www.jobcloud.ch/c/en/technical-solution/xml-fields/?tpc=eqk)
for employers to submit vacancies; these are not a public job-seeker search API.

The MVP originally enforced a compliant, manual-copy boundary for exactly these reasons.
**On 2026-08-26, the user explicitly reversed that decision for jobs.ch** after being told
both findings above and declining detection-evasion behavior. On 2026-08-27, after a
source-specific review, the user explicitly requested the same manually triggered search
for other Swiss and Netherlands sources. The current flow is:

```text
Ik ben een appel builds role searches for every enabled adapter
        ↓
POST /api/scrape fetches capped public result pages (no login)
        ↓
For a few new listings per source, reads schema.org JobPosting data
        ↓
Ik ben een appel canonicalizes/deduplicates, verifies language, and scores CV fit
        ↓
Every source records an honest run report; the user opens the source and applies personally
```

The user can still search/paste manually instead — both paths exist side by side.

The source roster is deliberately mixed:

- jobs.ch, jobup.ch, and JobScout24 are retained for local administrators at the user's accepted
  risk. They are all JobCloud properties covered by the same automation prohibition, are not
  sanctioned, and require the VPN launcher. jobs.ch + jobup.ch produced nine English-confirmed jobs.
- IamExpat is retained for local administrators against its current public career listing/detail
  paths, with its published crawl delay and no VPN requirement. It produced one confirmed job.
- Undutchables is retained for local administrators only through the plain `/vacancies` listing
  and public detail pages; query-string vacancy search is not used because robots.txt disallows it.
  It produced two confirmed jobs and remains VPN-gated because it previously blocked automation.
- Indeed Switzerland and Netherlands are blocked because their rules prohibit automated
  access without written permission and live requests returned HTTP 403.
- Job-Room is enabled and public. The line previously here said it was unavailable because
  its published API is for employers posting adverts - that is a different interface. Its
  unauthenticated public search and detail API is what this app reads, and the detail endpoint
  returns whole advertisements where search returns only a preview.
- Nationale Vacaturebank is unavailable after HTTP 403, and I amsterdam is disabled because it
  is a guide rather than a vacancy feed.
- LinkedIn is not configured by user request.

This is bounded on purpose:
- Manually triggered only (`app/job-radar.tsx`'s search buttons calling
  `POST /api/scrape`) — no cron/schedule.
- At most five distinct normalized search roles and four new detail fetches per enabled
  source per click, with fixed delays inside each adapter.
- No authentication — only pages that are public without a source-site session are read.
- A plain, identifiable User-Agent and no anti-detection behavior of any kind
  (no randomized timing, fingerprinting, headless-browser stealth, or proxy rotation) —
  that boundary held even though the automation boundary did not, and stays unchanged
  regardless of any future scope increase here.

The retention decision is based on quality rather than volume. These sources contributed 12
full-advertisement English-confirmed jobs alongside 114 from the public tier. They are a private
supplement, not the product's coverage foundation. Do not increase the four-detail-per-source cap;
revisit an adapter only after repeated measured zero yield, recurring failures, changed rules or a
block. See `docs/SOURCE_POLICY.md` §3.

A sanctioned, higher-volume, or scheduled integration still requires source permission or
an authorized API/feed; see `ROADMAP.md` for that path.

## 3. Runtime architecture

```text
React client
  ├─ PDF/DOCX/TXT text extraction in browser
  ├─ two CV-specific role overrides + five general role keywords
  ├─ persisted criteria and country/application/source/result filtering
  ├─ VPN-off / VPN-on search triggers + manual ad import fallback
  ├─ source-run and cumulative performance dashboards
  └─ saved/applied/dismissed controls
         │ JSON / multipart
         ▼
Next-compatible API routes on Vinext/Cloudflare
  ├─ manual-import URL safety validation (`lib/job-sources.ts`)
  ├─ shared source adapters and availability roster (`lib/job-adapters.ts`)
  ├─ canonical/source/fingerprint identity (`lib/job-identity.ts`)
  ├─ public-page fetching + JobPosting JSON-LD parsing
  ├─ deterministic language and fit analysis
  ├─ ordered runtime migrations (`db/migrations.ts`)
  ├─ D1 structured persistence (`DB`)
  └─ R2 original CV file storage (`CV_FILES`)
```

The application is multi-user. Every API route except authentication requires a signed session,
and every user-data query is scoped to the session account. The supported environments are local
`dev` and local `test`; hosting is intentionally disabled.

## 4. Data model

`search_settings` holds each account's filters. `search_roles` holds up to five ordered
role keywords, deduplicated before adapter searches.

`language_feedback` holds an optional user verdict per job. `correct` confirms the detector result. `incorrect` stores a user-selected corrected status (`pass`, `review`, or `blocked`) and an optional reason. It is separate from `jobs`, so a criteria rescore or job re-import updates detector output without erasing user feedback.

`jobs` stores source/canonical URL, source identity, country, title, company, location,
original posting date, full description, language evidence,
cross-source identity fingerprint, first/last seen, and independent saved, application, and
visibility fields. Exact source IDs/URLs and a conservative title+company+location+posting-
day fingerprint suppress duplicates.

`dismissed_jobs` holds durable identity tombstones so clearing a dismissed job row does not
allow the same advert back on a later search. Restoring a card deliberately removes its
matching tombstone.

`search_runs` and `search_run_sources` store the run status and per-source roles, found,
known, new, imported, matched (migration 25, `matched_count`, NULL means unknown), duplicate,
skipped, and safe message fields. Blocked or unavailable sources therefore remain visible
without being misreported as successful searches.

Results clarity (#123/#124, 2026-09-22): the dashboard shows **New this search**
(first-time unique jobs this run added), **Matched this search** (those new jobs
English-confirmed and meeting the saved criteria at search time — a snapshot, later
corrections do not rewrite it) and **Total collected** (unique retained jobs from this
and previous searches, saved/applied/dismissed included, deleted gone). Totals come from
the server (`queryCollectionTotals`), never from loaded pages or summed found counts;
unknown renders as —. Per-source totals attribute to the first-keeping source; the
overall deduplicates and the card says so. Job cards show employer requirements extracted
from the available advertisement (#125, `lib/requirements.ts`), with unextractable text
labelled as such and linked to the original ad — never a CV-match explanation and never
a language-eligibility claim.

The client never receives the CV text or R2 object key. Original CV files are capped at 10 MB. Replacing a CV removes the previous object after the new one is stored.

## 5. Language gate

`lib/analysis.ts` is deterministic and intentionally conservative:

1. Count common English and non-English markers across the full advertisement.
2. Inspect sentence-level context around every local-language mention.
3. Mark mandatory wording such as `required`, `must`, `fluent`, `minimum B2`, or `working knowledge` as blocked.
4. Recognize optional wording such as `nice to have`, `preferred`, `a plus`, `an asset`, and `advantageous`.
5. Route insufficient text, uncertain ad language, or unqualified language mentions to review.

The heuristic is explainable but not complete. It must be covered with a growing regression corpus before production. False positives are especially risky because they waste the user's application time.

The result views use the detector status unless the user explicitly marks it incorrect and selects a replacement. A correction never destroys the detector status or explanation: cards show both, making the feedback auditable and suitable for a future labeled regression corpus.

## 6. Job scoring (removed 2026-09-23)

There is no fit score. Every job was once scored against one or two uploaded CVs, with the
role searched for derived from the CV text; the feature was shelved behind a flag and then
removed outright, along with CV upload, CV storage in R2, and the derived-role heuristic.

Migration 28 (`remove_cv_storage_and_fit_scoring`) drops the `cvs` table, the `fit_score_a`,
`fit_score_b`, `best_cv_slot`, `matched_keywords` and `missing_keywords` columns on `jobs`,
and the two `search_settings` role overrides. Earlier migrations are untouched so an
installation can still advance from any recorded version.

What remains is the language gate (§5). A job is kept or set aside on the evidence of the
advertisement's own language, and on the role keywords the account saved - not on a
similarity judgement about the reader. Nothing in the product may display a fit score,
a match percentage, or a per-CV breakdown.

## 7. API surface

- `GET /api/state` — criteria/roles, analyzed jobs, and recent source runs, one page at a time
- `PUT /api/criteria` — validate and persist the five role keywords and the filters
- `POST /api/jobs` — validate and analyze one user-supplied public HTTPS job ad; the URL is never fetched by this route
- `POST /api/scrape` — run every configured adapter, deduplicate, analyze, and persist the full source report
- `POST /api/admin/job-room-backfill` — administrator-only, bounded repair of that administrator's
  preview-length legacy Job-Room rows, with detector-transition reporting
- `PATCH /api/jobs/:id` — independently update saved/application/visibility state and language feedback; dismissal writes a tombstone
- `DELETE /api/jobs/:id` — delete one analyzed job and its language feedback
- `DELETE /api/jobs` — delete selected job IDs or all jobs and their associated language feedback
- `DELETE /api/workspace` — confirmation-gated deletion of jobs, feedback, and criteria

The per-job delete and the JSON/CSV export were removed from the screen on 2026-09-22: a
delete that leaves no tombstone returns the same advertisement on the next search, which
reads as a bug. `DELETE /api/jobs`, `DELETE /api/jobs/:id` and `lib/export.ts` still exist
behind the API and are unreferenced by the client.

Changing role criteria recalculates every stored job's language result in D1 batches. The
client reloads state afterward so classifications and labels are current.

## 7a. Schema changes and local state (read before changing a column)

The schema is represented by the legacy base plus ordered upgrades:

- `db/runtime.ts` creates the legacy-compatible base tables for a brand-new local state.
- `db/migrations.ts` contains ordered, additive upgrades that `ensureSchema()` applies and
  records in `schema_migrations`.

Fresh databases run the same upgrades as existing ones. Do not add an already-migrated column
to the legacy base, or its later `ALTER TABLE` will fail. The Drizzle model and generator were removed.

Never edit an applied migration version. Add a new version containing one SQL statement
per D1 `prepare()` call, inspect the SQL, and test against
both a copied existing `.wrangler/` state and a fresh state. The 2026-08-27 multi-source
upgrade followed this process: all 18 local state files were copied before migration and
the two CV profiles plus 48 jobs survived. Do not reset `.wrangler/` as a migration shortcut.

### Versioned duplicate links (2026-09-14, #50)

Migration 17 adds `jobs.cluster_version` and an index on `(user_id, cluster_version)`.
Version 16 is reserved for the independently pending Job-Room backfill in PR #52.
`CLUSTER_VERSION` in `lib/server-data.ts` must be bumped when clustering/date matching or primary
selection changes. The authenticated state route first normalizes matching fields, then calls
`ensureCurrentJobClusters`; any stale member causes the entire owner's group to be recomputed.
This covers links created under older rules, new imports, and rows with no usable cluster key.

Only cluster keys, duplicate links and their versions change. Saved/applied/dismissed state,
corrections and tombstones remain untouched. Version markers are written with their corresponding
links in each D1 batch, scoped to snapshot row IDs and owner. If a later batch fails, unprocessed
rows remain stale and the next state request retries. No failed pass returns a partial dashboard.

Real D1 tests cover a populated upgrade, account isolation, preservation and interrupted-batch
recovery. The new workflow verifier also passed against synthetic dev and built-test accounts.
The owner's populated workspace has been backed up but has not been migrated with this branch;
that promotion remains pending review. This remains an account-wide recomputation on the first
read after a rule change; large-catalogue background processing belongs to the separate pagination
and catalogue work, not this fix.

## 7b. Authorized high-volume sources (2026-08-28)

Page-fetching adapters cost one request per job and are capped at four new jobs per source per
run, which limits discovery badly. Three API sources were added that return whole advertisements
in the search response, so a run costs a few requests instead of hundreds. These are capped at
200 new jobs per source per run (`MAX_NEW_PER_BULK_SOURCE`).

**Job-Room (`lib/job-room.ts`)** is the most important of the three. It is the official Swiss
public employment service (SECO / arbeit.swiss). Its Angular front end calls an unauthenticated
public JSON search API, which this adapter uses directly:
`POST https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search?page=N&size=100`.
It exposes 67,000+ live Swiss vacancies, and since 2018 shortage-occupation roles must be posted
there before anywhere else. Unlike jobs.ch, its `robots.txt` does not disallow the API path — but
that file's comment reads "Do not crawl Job Adverts", so this is materially cleaner than the
jobs.ch adapter without being an explicit grant. Re-check before increasing volume.

Rows imported before Job-Room detail fetching existed are repaired through the administrator page,
not during an ordinary search or page read. A run selects only that administrator's descriptions
below 900 characters, requests at most 120 details with the same 400 ms fixed delay, and records a
per-row detail version so it is safe to repeat. It updates content and derived analysis only;
saved/application/dismissed state and explicit language corrections remain separate and survive.
The returned report includes every raw detector transition and how many rows still need a later run.

**Expired advertisements (#97, 2026-09-20).** Refusing expired imports (#88) did nothing for rows
already stored: a card looked current and its link led to "no longer active". The decision, as the
issue framed it: store `publication.endDate` at collection (migration 23, `expires_at`) rather than
re-fetch every stored job — one request per job against someone else's server is exactly the traffic
this project caps. The card derives an `Expired` / `Closes today` chip from that date with no
request; the row is never hidden or deleted for it, since the person may have applied. Whatever the
posting-date backfill (#91) already re-reads records its expiry in the same single request — a
re-fetch that finds the advertisement closed marks it expired (counted as `expiredCount`, leaving
eligibility so reruns terminate) instead of looking like a failure and retrying forever. Not done:
sources other than Job-Room publish no end date the app reads, so their cards carry no expiry; a
closed advertisement whose detail endpoint answers 404 rather than a closed body still reads as a
failed fetch and retries, because a missing body carries no date to store.

Job-Room publishes **employer-declared `languageSkills`** (ISO code plus spoken/written level from
`NONE | BASIC | INTERMEDIATE | PROFICIENT`). `analyzeStructuredLanguages` in `lib/analysis.ts`
consumes these and takes precedence over the prose heuristic, because a declared requirement is
stronger evidence than inferred wording. It matters in both directions: an advertisement written
in German may only require English, which the prose gate cannot tell. The rules are conservative —
any local language at INTERMEDIATE or above blocks; English at INTERMEDIATE or above with no local
requirement passes; anything else goes to review. Listed languages with null levels are not
treated as requirements, so those ads fall back to prose analysis.

**Adzuna and Careerjet** are administrator-only aggregator APIs covering both Switzerland and the
Netherlands. Both need credentials (`ADZUNA_APP_ID`/`ADZUNA_APP_KEY`, `CAREERJET_API_KEY`) and report
themselves `unavailable` with setup instructions until those are set — a missing key never fails a
run. Their short teasers cannot support the language evidence gate, so they are retained only as
private discovery/coverage measures and their rows and run records are withheld from ordinary
accounts. Adzuna rows are stored under `adzuna.ch` / `adzuna.nl`, so those result-host aliases are
part of the server-side hidden-source set as well as the adapter keys.

**Adzuna decision (2026-09-09, #30).** The current API terms allow publishing listings and personal
research but impose attribution and default free limits (25 requests/minute, 250/day). The standard
search API supplies the 500-character teaser already used here; Adzuna presents full job details as
a separate data service. The app will not follow `redirect_url` to copy full text from third-party
providers. Administrators still see Adzuna in the conversion report and a “The Adzuna API”
acknowledgement with links to the relevant local domains; no stored verdicts are changed. Careerjet is additionally local-administrator-only (#31); its credentials are deliberately
absent from hosted environments.

Careerjet's legacy `public.api.careerjet.net/search` endpoint with an `affid` query parameter is
dead. The current API is `https://search.api.careerjet.net/v4/query`, authenticated with HTTP
Basic where the API key is the username and the password is empty.

**Careerjet decision (2026-09-09, #31): retained for local administrators only.** The current API
documentation gives each publisher website a unique key and requires the real end-user IP and user
agent plus an originating-page Referer. The existing placeholder registration does not establish a
compliant public integration. Careerjet therefore stays behind the server-side administrator gate
and is not a hosted feature: hosted environments leave all three `CAREERJET_*` values unset. A local
administrator may enable it only with correctly registered credentials and real request details.
Its 279-character teasers remain `unknown`; the retained 237 rows are private discovery leads, not
English-sufficiency evidence. See `docs/SOURCE_POLICY.md` §3 for the full retention rationale.

Two dead ends were confirmed and should not be re-investigated without new information: werk.nl /
UWV (the Dutch public employment service) publishes only aggregated open data and has no vacancy
API, and recruitment agencies were measured directly — ten major CH/NL agencies yielded twelve
jobs in total across Greenhouse, Lever, Recruitee, SmartRecruiters and Personio, because agencies
use those platforms for their own internal hiring while client vacancies sit in closed recruitment
CRMs. The same ATS endpoints are rich for direct employers.

## 8. Known risks and missing production controls

- **Indeed experiment (2026-09-19, #64/#65):** an isolated backend client successfully
  retrieved description HTML for two NL jobs across two pages and one CH job. The owner
  approved a narrow mobile-header-profile experiment; TLS verification remains enabled.
  No phone or personal OAuth was used. Source adapters remain disabled; normalization,
  description-completeness validation, dashboard integration, tenancy/export checks and
  end-to-end dev/test validation are still separate tasks. No public entitlement, stable
  key lifetime, unlimited quota or 200-400-job yield follows from this small sample. See
  `docs/INDEED_INTEGRATION.md`. Caller-supplied local/admin flags must come from current
  server authorization, never browser input; refusal/cooldown state is per client instance.
- The three enabled JobCloud adapters are unsanctioned (§2). Realistic consequences include
  IP blocking or legal demands. Caps and manual triggers limit load, not legal exposure.
- Public-page markup and structured data can change independently for every enabled
  adapter. Runs now show failed/partial/skipped counts, but parser fixtures still need to
  be refreshed when a site changes.
- The existing database upgrade was verified with two real CV profiles and 48 distinct
  jobs (7 pass, 1 review, 40 blocked; 4 dismissed). The new external multi-source run has
  not been executed because `npm run dev:private` found no active full VPN route.
- The generated Drizzle migrations that were described here no longer exist. The whole
  Drizzle layer was removed on 1 September because nothing imported it and its schema had
  silently drifted from the real one - `db/schema.ts` was missing `user_id` on `jobs` for
  months without anything failing. `schemaStatements` in `db/runtime.ts` plus
  `runtimeMigrations` in `db/migrations.ts` are now the only description of the schema, and
  are applied and versioned as described in §7a.
- Authentication and tenant scoping exist, but the complete second-user regression exercise in
  `docs/TASKS.md` A3 must be rerun after the environment split.
- Deterministic language detection has focused regression tests, a reviewed 24-ad live
  sample, and persisted correction controls. The user still needs to label a representative
  set before it can be treated as an evaluation corpus.
- The local persistence emulator is not a backup.
- A user-triggered full workspace reset is available. Per-job deletion and export were
  removed from the screen (§7). There is still no automated retention schedule, encryption
  policy, consent screen, or audit log.
- No scheduled discovery, alerts, or expiry checks. Scheduling remains restricted to
  authorized sources.
- Page-fetch rejection memory (2026-09-20, #93): remembered rejections, the
  transient/permanent split, and the run-report counts are covered by real-D1 tests plus
  lint/typecheck/build, but no live page-fetching search was run — that path needs
  `npm run dev:private` with an active VPN route, which was unavailable here. The first live
  private search should confirm remembered rows accumulate and the queue head advances.
- Results clarity (#123/#124/#125, 2026-09-22, unmerged): New/Matched/Total-collected
  counting, `matched_count` persistence and the requirements-extraction widening are covered
  by synthetic unit plus real-D1 tests, lint, typecheck, build and the design gate — 371/371
  green. No signed-in browser exercise ran: the owner's dev (:3000) and test (:3001) servers
  were up and this worktree could not bind those ports, and verification must never write to
  owner state. Before merge, exercise in isolated dev and built test at 1400px and 375px:
  latest-run New/Matched/Total with per-source unknown (—), admin "view as user" preview
  hiding admin counts, requirements expand plus original-ad links, and a correction moving
  its card. Nothing tests `app/job-radar.tsx`, so the green gate is not evidence the panel
  renders correctly.
- Source URLs, rules, and availability can change; revalidate them before releases and
  keep the adapter feature states truthful. LinkedIn remains excluded.

## 9. Optional local VPN launcher

The Windows-only scripts under `scripts/` provide an optional privacy wrapper for local
use. `setup-vpn.ps1` installs the official Windscribe or Proton VPN client through
Windows Package Manager. `start-private.ps1` refuses to launch the development server
unless `check-vpn.ps1` finds a supported active adapter carrying a full IPv4 route.

Provider account creation, sign-in, country selection, and Firewall/Kill Switch settings
remain a one-time visible provider step. The free Windows clients do not publish a
supported interface for automating those settings, and Ik ben een appel must never capture VPN
credentials or manipulate undocumented provider state. The route check is a guardrail,
not proof of anonymity; its optional exit-IP display calls Cloudflare's trace endpoint.

The equivalent macOS scripts use the official Homebrew casks and require a full IPv4 route
over a `utun` interface. Windows was live-verified on 2026-08-27 with Windscribe through a
Netherlands exit; macOS scripts were syntax-checked but require live validation on the
Apple device.
