# Architecture and decision record

Last updated: 2026-08-27.

## 1. Goal and acceptance rule

The user wants Switzerland and Amsterdam-area Netherlands jobs where English alone is enough. “The ad contains the word English” is not sufficient. A match must satisfy both:

- the full job advertisement is predominantly English; and
- German, French, Italian, and Dutch are not mandatory.

Local languages described as optional, preferred, a plus, or an asset may pass, but the optional wording is shown. Any unclear mention is routed to manual review.

## 2. Why the MVP is a jobs.ch companion — and the 2026-08-26 reversal

jobs.ch is the chosen Swiss source because of its market coverage and native search
filters. The [JobCloud terms](https://www.jobs.ch/en/terms/) prohibit crawlers,
scrapers, bots, scripting, and other automation across its platforms, and `robots.txt`
separately disallows crawling job-detail pages specifically (the pages containing the
full ad text). JobCloud publishes [technical XML solutions](https://www.jobcloud.ch/c/en/technical-solution/xml-fields/?tpc=eqk)
for employers to submit vacancies; these are not a public job-seeker search API.

The MVP originally enforced a compliant, manual-copy boundary for exactly these reasons.
**On 2026-08-26, the user explicitly reversed that decision** after being told both
findings above, and after explicitly declining any request to add detection-evasion
behavior. The current flow is:

```text
Northbound builds a jobs.ch search URL
        ↓
POST /api/scrape fetches the search-results page directly (no login, one page, capped)
        ↓
For each new listing, fetches the detail page and reads its schema.org
JobPosting JSON-LD block (the same structured data job aggregators consume)
        ↓
Northbound verifies language + scores CV fit
        ↓
User opens jobs.ch and applies personally
```

The user can still search/paste manually instead — both paths exist side by side.

**This is a knowing ToS and robots.txt violation, done at the user's explicit
instruction, not a compliant integration.** It is bounded on purpose:
- Manually triggered only (`app/job-radar.tsx`'s "Find new jobs" button calling
  `POST /api/scrape`) — no cron/schedule.
- One search-results page **per distinct derived role** (so at most 2 search requests per
  click, since there are at most 2 CVs, and 1 when both CVs derive the same role), capped
  to `MAX_NEW_JOBS_PER_RUN` new detail-page fetches per click in total (`lib/jobsch.ts`),
  with the same fixed delay between every request.
- No authentication — only pages that are public without a jobs.ch session are read.
- A plain, non-spoofed browser User-Agent and no anti-detection behavior of any kind
  (no randomized timing, fingerprinting, headless-browser stealth, or proxy rotation) —
  that boundary held even though the automation boundary did not, and stays unchanged
  regardless of any future scope increase here.

A sanctioned, higher-volume, or scheduled integration still requires written JobCloud
permission or an authorized API/feed; see `ROADMAP.md` for that path.

## 3. Runtime architecture

```text
React client
  ├─ PDF/DOCX/TXT text extraction in browser
  ├─ persisted search criteria and local result filtering
  ├─ "Find new jobs" trigger + manual ad import + Swiss/Netherlands source handoffs
  ├─ results UI
  └─ shortlist/application controls
         │ JSON / multipart
         ▼
Next-compatible API routes on Vinext/Cloudflare
  ├─ validation and jobs.ch URL allowlist (`lib/jobsch.ts`)
  ├─ jobs.ch search + detail-page fetch and JobPosting JSON-LD parsing (`lib/jobsch.ts`)
  ├─ deterministic language and fit analysis
  ├─ D1 structured persistence (`DB`)
  └─ R2 original CV file storage (`CV_FILES`)
```

The MVP is single-user. Authentication and tenant isolation are post-MVP requirements before public hosting.

## 4. Data model

`cvs` holds up to two rows, keyed by a unique `slot` (`a` or `b`) for one person's two CV versions: CV filename, private R2 object key, extracted CV text, the role derived from that CV's content (§6a), and an update timestamp.

`search_settings` holds the single-user search profile: optional role override for each CV, location/canton, workplace, seniority, contract type, required keywords, exclusions, and an update timestamp. Role overrides take precedence over the derived roles for discovery and scoring but do not overwrite the detected metadata.

`language_feedback` holds an optional user verdict per job. `correct` confirms the detector result. `incorrect` stores a user-selected corrected status (`pass`, `review`, or `blocked`) and an optional reason. It is separate from `jobs`, so a CV replacement, criteria rescore, or job re-import updates detector output without erasing user feedback.

`jobs` stores the source URL, title, company, location, full description, language result and evidence, one fit score per CV slot (`fit_score_a`, `fit_score_b`) plus `best_cv_slot` and the winning slot's keywords, pipeline status, and timestamps. `source_url` is unique so re-importing an ad refreshes its analysis without duplicating it.

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

It is a heuristic and can return `''` for an unconventionally-worded CV. That is handled, not
an error: the CV still saves and still scores jobs; it just contributes no search term, and
`POST /api/scrape` fails with a clear message only if *no* CV yields a role.

## 7. API surface

- `GET /api/state` — saved CV metadata (both slots), search criteria, and analyzed jobs
- `POST /api/profile` — one CV slot (`a`/`b`): extracted CV text and CV file; derives and stores that CV's role
- `DELETE /api/profile?slot=a|b` — delete one stored CV/file, clear its role override, and rescore jobs with the remaining CV
- `PUT /api/criteria` — validate, persist, and apply role/location/workplace/seniority/contract/keyword criteria
- `POST /api/jobs` — validate and analyze one user-supplied public HTTPS job ad against every saved CV; the URL is never fetched by this route
- `POST /api/scrape` — fetch and analyze new jobs.ch listings for each distinct derived role (see §2 for the compliance decision behind this route)
- `PATCH /api/jobs/:id` — update pipeline status and save, change, or clear language feedback
- `DELETE /api/jobs/:id` — delete an analyzed job (API support; UI currently uses hide)
- `DELETE /api/jobs` — delete selected job IDs or all jobs and their associated language feedback
- `DELETE /api/workspace` — confirmation-gated deletion of CV objects, jobs, feedback, and criteria

JSON and CSV export are generated client-side from `GET /api/state`. JSON includes only
the CV metadata already safe for the client, never extracted CV text or R2 object keys.

Saving either CV or changing role criteria recalculates every stored job's language result
and two fit scores in D1 batches. The client reloads state afterward so classifications,
visible scores, labels, and the winning CV are current.

## 7a. Schema changes and local state (read before changing a column)

The schema is defined **twice** and the two must be kept in sync by hand:

- `db/runtime.ts` (`schemaStatements`) is what actually creates tables at runtime, via
  `CREATE TABLE IF NOT EXISTS`.
- `db/schema.ts` is the drizzle source used only by `npm run db:generate` to emit files
  into `drizzle/`. Those files are **not** applied automatically by anything.

Because `ensureSchema()` uses `CREATE TABLE IF NOT EXISTS`, **it never alters an existing
table.** Adding or renaming a column therefore leaves any already-created local database
on the old shape, and queries against the new columns fail at runtime (a `500` from the
route, and `undefined` values reaching the client). After changing a column you must reset
local state — move or remove the emulator's `.wrangler/` directory and let the dev server
recreate the database — not just restart the server.

There is no migration/backfill path for real data. Before this app holds anything worth
keeping, replace the `CREATE TABLE IF NOT EXISTS` approach with applied, ordered
migrations.

## 8. Known risks and missing production controls

- `POST /api/scrape` knowingly violates jobs.ch's ToS and `robots.txt` (§2). Realistic
  consequences include IP-level blocking or a cease-and-desist; there is no legal
  authorization behind this path. It is capped and manually triggered to limit exposure,
  not to hide it.
- The scrape depends on jobs.ch continuing to server-render search/detail pages and
  embed `schema.org JobPosting` JSON-LD; either changing would silently return zero
  results (fails closed — `fetchJobDetail`/`fetchSearchResultIds` return null/empty
  rather than throwing per-listing) rather than erroring loudly.
- The real-CV flow was verified end to end on 2026-08-26: both text-based PDFs parsed,
  roles derived as `Data Analyst` and `Data Governance Analyst`, more specific role
  overrides persisted across reload, two bounded searches produced 24 real jobs, and
  rescoring classified them as five pass, one review, and 18 blocked.
- `drizzle/0000_open_whirlwind.sql` matches the two-CV schema and
  `drizzle/0001_lush_silvermane.sql` adds saved search settings;
  `drizzle/0002_cultured_squadron_supreme.sql` adds language feedback. However, generated
  migrations are still not applied by the runtime; the broader migration limitation in
  §7a remains.
- No authentication or multi-user isolation.
- Deterministic language detection has focused regression tests, a reviewed 24-ad live
  sample, and persisted correction controls. The user still needs to label a representative
  set before it can be treated as an evaluation corpus.
- Role derivation (§6a) is a small hand-written heuristic. Its focused tests now cover
  header specificity and older repeated roles, but other CV layouts will surface new cases.
- Scanned/image-only PDFs require OCR; the MVP reports that the file is unreadable.
- The local persistence emulator is not a backup.
- User-triggered CV/job deletion, full reset, and JSON/CSV export are available. There is still no automated retention schedule, encryption policy, consent screen, or audit log.
- No scheduled discovery, alerts, cross-source deduplication, or expiry checks.
- jobs.ch URL structure and terms can change; revalidate them before releases.
- Netherlands sources are handoff-only: I amsterdam, IamExpat, Undutchables, Indeed
  Netherlands, and Nationale Vacaturebank. LinkedIn is excluded. Their links and terms can
  change, and no automation permission has been established for them.

## 9. Optional local VPN launcher

The Windows-only scripts under `scripts/` provide an optional privacy wrapper for local
use. `setup-vpn.ps1` installs the official Windscribe or Proton VPN client through
Windows Package Manager. `start-private.ps1` refuses to launch the development server
unless `check-vpn.ps1` finds a supported active adapter carrying a full IPv4 route.

Provider account creation, sign-in, country selection, and Firewall/Kill Switch settings
remain a one-time visible provider step. The free Windows clients do not publish a
supported interface for automating those settings, and Northbound must never capture VPN
credentials or manipulate undocumented provider state. The route check is a guardrail,
not proof of anonymity; its optional exit-IP display calls Cloudflare's trace endpoint.

The equivalent macOS scripts use the official Homebrew casks and require a full IPv4 route
over a `utun` interface. Windows was live-verified on 2026-08-27 with Windscribe through a
Netherlands exit; macOS scripts were syntax-checked but require live validation on the
Apple device.
