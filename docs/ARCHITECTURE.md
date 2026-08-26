# Architecture and decision record

Last updated: 2026-08-26.

## 1. Goal and acceptance rule

The user wants Switzerland and, later, Amsterdam-area Netherlands jobs where English alone is enough. “The ad contains the word English” is not sufficient. A match must satisfy both:

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
  ├─ "Find new jobs" trigger + manual ad import + jobs.ch search handoff
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

`cvs` holds up to two rows, keyed by a unique `slot` (`a` or `b`) for one person's two CV versions: CV filename, private R2 object key, extracted CV text, the role derived from that CV's content (§6a), and an update timestamp. There is no user-entered target role.

`jobs` stores the source URL, title, company, location, full description, language result and evidence, one fit score per CV slot (`fit_score_a`, `fit_score_b`) plus `best_cv_slot` and the winning slot's keywords, pipeline status, and timestamps. `source_url` is unique so re-importing an ad refreshes its analysis without duplicating it.

The client never receives the CV text or R2 object key. Original CV files are capped at 10 MB. Replacing a CV removes the previous object after the new one is stored.

## 5. Language gate

`lib/analysis.ts` is deterministic and intentionally conservative:

1. Count common English and non-English markers across the full advertisement.
2. Inspect sentence-level context around every local-language mention.
3. Mark mandatory wording such as `required`, `must`, `fluent`, `minimum B2`, or `working knowledge` as blocked.
4. Recognize optional wording such as `nice to have`, `preferred`, `a plus`, and `an asset`.
5. Route insufficient text, uncertain ad language, or unqualified language mentions to review.

The heuristic is explainable but not complete. It must be covered with a growing regression corpus before production. False positives are especially risky because they waste the user's application time.

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
frequency with a bonus for appearing early in the document (a title under the name or in a
summary line beats one mentioned in passing), and returns the top phrase.

It is a heuristic and can return `''` for an unconventionally-worded CV. That is handled, not
an error: the CV still saves and still scores jobs; it just contributes no search term, and
`POST /api/scrape` fails with a clear message only if *no* CV yields a role.

## 7. API surface

- `GET /api/state` — saved CV metadata (both slots) and analyzed jobs
- `POST /api/profile` — one CV slot (`a`/`b`): extracted CV text and CV file; derives and stores that CV's role
- `POST /api/jobs` — validate and analyze one user-supplied jobs.ch ad against every saved CV
- `POST /api/scrape` — fetch and analyze new jobs.ch listings for each distinct derived role (see §2 for the compliance decision behind this route)
- `PATCH /api/jobs/:id` — update `new`, `saved`, `applied`, or `ignored`
- `DELETE /api/jobs/:id` — delete an analyzed job (API support; UI currently uses hide)

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
- **The two-CV schema change is not verified end to end (2026-08-26).** Lint, build, and
  type-check pass, and CV upload plus role derivation were confirmed working against
  `POST /api/profile`. `POST /api/scrape` was last observed returning `500` against a
  local database created under the previous single-CV schema — see §7a; it has not been
  re-run against a freshly created database, so the two-CV scrape and the per-CV score
  breakdown in the UI remain unconfirmed.
- **`drizzle/` is stale.** It still describes the pre-two-CV schema. `npm run db:generate`
  needs an interactive terminal to resolve the `profiles` → `cvs` table rename, so it has
  not been regenerated. This does not affect runtime (see §7a) but means `db/schema.ts`
  and `drizzle/` disagree.
- No authentication or multi-user isolation.
- Deterministic language detection needs a larger labeled test corpus.
- Role derivation (§6a) is a small hand-written heuristic with no test corpus. It was
  corrected once already for pulling a stray word off a CV's name line into the role; other
  CV layouts will surface similar cases.
- Scanned/image-only PDFs require OCR; the MVP reports that the file is unreadable.
- The local persistence emulator is not a backup.
- No retention controls, CV delete/export flow, encryption policy, consent screen, or audit log yet.
- No automatic discovery, alerts, deduplication across sources, or expiry checks.
- jobs.ch URL structure and terms can change; revalidate them before releases.
