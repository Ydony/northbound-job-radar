# Architecture and decision record

Last updated: 2026-08-31.

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
Ik Engels builds role searches for every enabled adapter
        ↓
POST /api/scrape fetches capped public result pages (no login)
        ↓
For a few new listings per source, reads schema.org JobPosting data
        ↓
Ik Engels canonicalizes/deduplicates, verifies language, and scores CV fit
        ↓
Every source records an honest run report; the user opens the source and applies personally
```

The user can still search/paste manually instead — both paths exist side by side.

The source roster is deliberately mixed:

- jobs.ch, jobup.ch, and JobScout24 are enabled at the user's accepted risk. They are all
  JobCloud properties covered by the same automation prohibition and are not sanctioned.
- IamExpat is enabled against its current public career listing/detail paths.
- Undutchables is enabled only through the plain `/vacancies` listing and public detail
  pages; query-string vacancy search is not used because its robots policy disallows it.
- Indeed Switzerland and Netherlands are blocked because their rules prohibit automated
  access without written permission and live requests returned HTTP 403.
- Job-Room is unavailable because its published API is for employers posting adverts,
  Nationale Vacaturebank is unavailable after HTTP 403, and I amsterdam is disabled
  because it is a guide rather than a vacancy feed.
- LinkedIn is not configured by user request.

This is bounded on purpose:
- Manually triggered only (`app/job-radar.tsx`'s "Search all job sites" button calling
  `POST /api/scrape`) — no cron/schedule.
- At most five distinct normalized search roles and four new detail fetches per enabled
  source per click, with fixed delays inside each adapter.
- No authentication — only pages that are public without a source-site session are read.
- A plain, identifiable User-Agent and no anti-detection behavior of any kind
  (no randomized timing, fingerprinting, headless-browser stealth, or proxy rotation) —
  that boundary held even though the automation boundary did not, and stays unchanged
  regardless of any future scope increase here.

A sanctioned, higher-volume, or scheduled integration still requires source permission or
an authorized API/feed; see `ROADMAP.md` for that path.

## 3. Runtime architecture

```text
React client
  ├─ PDF/DOCX/TXT text extraction in browser
  ├─ two CV-specific role overrides + five general role keywords
  ├─ persisted criteria and country/application/source/result filtering
  ├─ "Search all job sites" trigger + manual ad import fallback
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

`cvs` holds up to two rows per account, keyed by `user_id` plus `slot` (`a` or `b`): CV filename,
private R2 object key, extracted CV text, the role derived from that CV's content (§6a), and an
update timestamp.

`search_settings` holds each account's filters and optional role override for each CV.
`search_roles` holds up to five ordered general role keywords. Normalized CV roles and
general roles are deduplicated before adapter searches.

`language_feedback` holds an optional user verdict per job. `correct` confirms the detector result. `incorrect` stores a user-selected corrected status (`pass`, `review`, or `blocked`) and an optional reason. It is separate from `jobs`, so a CV replacement, criteria rescore, or job re-import updates detector output without erasing user feedback.

`jobs` stores source/canonical URL, source identity, country, title, company, location,
original posting date, full description, language evidence, one fit score per CV,
cross-source identity fingerprint, first/last seen, and independent saved, application, and
visibility fields. Exact source IDs/URLs and a conservative title+company+location+posting-
day fingerprint suppress duplicates.

`dismissed_jobs` holds durable identity tombstones so clearing a dismissed job row does not
allow the same advert back on a later search. Restoring a card deliberately removes its
matching tombstone.

`search_runs` and `search_run_sources` store the run status and per-source roles, found,
known, new, imported, duplicate, skipped, and safe message fields. Blocked or unavailable
sources therefore remain visible without being misreported as successful searches.

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

## 6. CV-fit score

Every job is scored once per saved CV (`scoreFitAcrossCvs` in `lib/analysis.ts`), so a job
can fit the generalist CV better than the specialist one. The UI shows the best score and
the per-CV breakdown; the stored keyword lists belong to the winning slot.

Each individual score is a transparent lexical heuristic, not an employability prediction. It combines:

- overlap with known skill phrases;
- frequent, meaningful job-description terms found in the CV;
- title-term overlap; and
- overlap with that CV's derived role (§6a).

Matched keywords are displayed. Later semantic ranking must preserve explanations and should be calibrated against user feedback.

## 6a. Role derivation

`lib/role-detection.ts` derives each CV's likely target role locally and deterministically —
no third-party model call, consistent with the CV-privacy rule in `AGENTS.md`. It scans for
`modifier? word{0,2} title-noun` phrases (e.g. "senior software engineer"), ranks them by
frequency with a strong bonus for a specific phrase near the document header (a target title
under the name beats older titles repeated in work history), and returns the top phrase.

It is a heuristic and can return `''` for an unconventionally-worded CV. That is handled,
not an error: the CV still saves and scores jobs. `POST /api/scrape` fails clearly only if
neither a CV-derived/overridden role nor one of the five general roles exists.

## 7. API surface

- `GET /api/state` — saved CV metadata, criteria/roles, analyzed jobs, and recent source runs
- `POST /api/profile` — one CV slot (`a`/`b`): extracted CV text and CV file; derives and stores that CV's role
- `DELETE /api/profile?slot=a|b` — delete one stored CV/file, clear its role override, and rescore jobs with the remaining CV
- `PUT /api/criteria` — validate and persist CV role overrides, five general roles, and filters
- `POST /api/jobs` — validate and analyze one user-supplied public HTTPS job ad against every saved CV; the URL is never fetched by this route
- `POST /api/scrape` — run every configured adapter, deduplicate, analyze, and persist the full source report
- `PATCH /api/jobs/:id` — independently update saved/application/visibility state and language feedback; dismissal writes a tombstone
- `DELETE /api/jobs/:id` — delete one analyzed job and its language feedback
- `DELETE /api/jobs` — delete selected job IDs or all jobs and their associated language feedback
- `DELETE /api/workspace` — confirmation-gated deletion of CV objects, jobs, feedback, and criteria

JSON and CSV export are generated client-side from `GET /api/state`. JSON includes only
the CV metadata already safe for the client, never extracted CV text or R2 object keys.

Saving either CV or changing role criteria recalculates every stored job's language result
and two fit scores in D1 batches. The client reloads state afterward so classifications,
visible scores, labels, and the winning CV are current.

## 7a. Schema changes and local state (read before changing a column)

The schema is represented in three places and must be kept in sync:

- `db/runtime.ts` creates the legacy-compatible base tables for a brand-new local state.
- `db/migrations.ts` contains ordered, additive upgrades that `ensureSchema()` applies and
  records in `schema_migrations`.
- `db/schema.ts` is the latest Drizzle model used by `npm run db:generate`; generated SQL
  is review/deployment material, not the local runtime executor.

Never edit an applied migration version. Add a new version containing one SQL statement
per D1 `prepare()` call, update the Drizzle model, generate/inspect the SQL, and test against
both a copied existing `.wrangler/` state and a fresh state. The 2026-08-27 multi-source
upgrade followed this process: all 18 local state files were copied before migration and
the two CV profiles plus 48 jobs survived. Do not reset `.wrangler/` as a migration shortcut.

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

Job-Room publishes **employer-declared `languageSkills`** (ISO code plus spoken/written level from
`NONE | BASIC | INTERMEDIATE | PROFICIENT`). `analyzeStructuredLanguages` in `lib/analysis.ts`
consumes these and takes precedence over the prose heuristic, because a declared requirement is
stronger evidence than inferred wording. It matters in both directions: an advertisement written
in German may only require English, which the prose gate cannot tell. The rules are conservative —
any local language at INTERMEDIATE or above blocks; English at INTERMEDIATE or above with no local
requirement passes; anything else goes to review. Listed languages with null levels are not
treated as requirements, so those ads fall back to prose analysis.

**Adzuna and Careerjet** are authorized aggregator APIs covering both Switzerland and the
Netherlands. Both need free credentials (`ADZUNA_APP_ID`/`ADZUNA_APP_KEY`, `CAREERJET_API_KEY`) and
report themselves `unavailable` with setup instructions until those are set — a missing key never
fails a run. Note their APIs return short teaser descriptions, so their jobs will usually land in
review rather than pass; they are best understood as discovery breadth, not language evidence.

Careerjet's legacy `public.api.careerjet.net/search` endpoint with an `affid` query parameter is
dead. The current API is `https://search.api.careerjet.net/v4/query`, authenticated with HTTP
Basic where the API key is the username and the password is empty.

**Open licensing question on Careerjet (2026-08-28).** Careerjet issues its key against one
registered publisher website and states the key is "provided exclusively for integration on the
registered website". Ik Engels is a local private tool with no public site, and the key in
use was registered against a placeholder domain, so this usage sits outside the registered scope —
this is a licensing question, not a technical one, and it is unresolved. Adzuna carries no
equivalent per-site restriction and is the safer default of the two. If Careerjet's scope matters,
either register the real deployment through their "add another website" flow or leave
`CAREERJET_API_KEY` unset, which cleanly disables both Careerjet sources.

Two dead ends were confirmed and should not be re-investigated without new information: werk.nl /
UWV (the Dutch public employment service) publishes only aggregated open data and has no vacancy
API, and recruitment agencies were measured directly — ten major CH/NL agencies yielded twelve
jobs in total across Greenhouse, Lever, Recruitee, SmartRecruiters and Personio, because agencies
use those platforms for their own internal hiring while client vacancies sit in closed recruitment
CRMs. The same ATS endpoints are rich for direct employers.

## 8. Known risks and missing production controls

- The three enabled JobCloud adapters are unsanctioned (§2). Realistic consequences include
  IP blocking or legal demands. Caps and manual triggers limit load, not legal exposure.
- Public-page markup and structured data can change independently for every enabled
  adapter. Runs now show failed/partial/skipped counts, but parser fixtures still need to
  be refreshed when a site changes.
- The existing database upgrade was verified with two real CV profiles and 48 distinct
  jobs (7 pass, 1 review, 40 blocked; 4 dismissed). The new external multi-source run has
  not been executed because `npm run dev:private` found no active full VPN route.
- `drizzle/0000_open_whirlwind.sql` matches the two-CV schema and
  `drizzle/0001_lush_silvermane.sql` adds saved search settings;
  `drizzle/0002_cultured_squadron_supreme.sql` adds language feedback, and
  `drizzle/0003_cloudy_toro.sql` represents the multi-source schema. Runtime migrations
  are separately applied and versioned as described in §7a.
- Authentication and tenant scoping exist, but the complete second-user regression exercise in
  `docs/TASKS.md` A3 must be rerun after the environment split.
- Deterministic language detection has focused regression tests, a reviewed 24-ad live
  sample, and persisted correction controls. The user still needs to label a representative
  set before it can be treated as an evaluation corpus.
- Role derivation (§6a) is a small hand-written heuristic. Its focused tests now cover
  header specificity and older repeated roles, but other CV layouts will surface new cases.
- Scanned/image-only PDFs require OCR; the MVP reports that the file is unreadable.
- The local persistence emulator is not a backup.
- User-triggered CV/job deletion, full reset, and JSON/CSV export are available. There is still no automated retention schedule, encryption policy, consent screen, or audit log.
- No scheduled discovery, alerts, or expiry checks. Scheduling remains restricted to
  authorized sources.
- Source URLs, rules, and availability can change; revalidate them before releases and
  keep the adapter feature states truthful. LinkedIn remains excluded.

## 9. Optional local VPN launcher

The Windows-only scripts under `scripts/` provide an optional privacy wrapper for local
use. `setup-vpn.ps1` installs the official Windscribe or Proton VPN client through
Windows Package Manager. `start-private.ps1` refuses to launch the development server
unless `check-vpn.ps1` finds a supported active adapter carrying a full IPv4 route.

Provider account creation, sign-in, country selection, and Firewall/Kill Switch settings
remain a one-time visible provider step. The free Windows clients do not publish a
supported interface for automating those settings, and Ik Engels must never capture VPN
credentials or manipulate undocumented provider state. The route check is a guardrail,
not proof of anonymity; its optional exit-IP display calls Cloudflare's trace endpoint.

The equivalent macOS scripts use the official Homebrew casks and require a full IPv4 route
over a `utun` interface. Windows was live-verified on 2026-08-27 with Windscribe through a
Netherlands exit; macOS scripts were syntax-checked but require live validation on the
Apple device.
