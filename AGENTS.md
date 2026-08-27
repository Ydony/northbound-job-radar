# Northbound: instructions for coding agents

**Read `docs/HANDOFF.md` first** — current state, what is unfinished or broken, and the next
action. Use `docs/TASKS.md` for execution status. Read `docs/MULTI_SOURCE_PLAN.md` before
changing discovery, job identity, filters, pipeline state, or source adapters. Then read
`README.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP.md` before making product or integration changes.

## Product objective

Build a private job-search companion for a user seeking roles where English alone is sufficient. It provides one manually triggered, multi-source search across configured Swiss and Netherlands adapters; LinkedIn is excluded. A job is a match only when the full advertisement is predominantly English and German, French, Italian, and Dutch are not mandatory. Ambiguous ads must go to `review`, never `pass`.

## Source integration boundary

- **2026-08-26, revised same day:** the MVP originally forbid any jobs.ch automation
  (see git history / `docs/ARCHITECTURE.md` decision record for the original reasoning).
  The user explicitly reversed that decision after being told: JobCloud's
  [terms](https://www.jobs.ch/en/terms/) prohibit crawlers/scrapers/bots/scripting, and
  `robots.txt` separately disallows crawling job-detail pages specifically. Automated
  fetching of jobs.ch (`lib/job-adapters.ts`, `POST /api/scrape`) now runs anyway, knowingly
  against both. Re-check current platform terms before extending this further, and don't
  assume the reversal generalizes to other sites without the same explicit conversation.
- **The line that did not move: no detection evasion.** Never add randomized/human-like
  timing, fingerprint spoofing, headless-browser stealth plugins, proxy/IP rotation, or
  anything else designed to defeat jobs.ch's bot detection. `lib/jobsch.ts` uses a plain
  `fetch()` with a standard (non-spoofed) browser User-Agent, a fixed inter-request
  delay, and hard caps (`RESULTS_PAGE`, `MAX_NEW_JOBS_PER_RUN`) — keep it that way.
- The search is **manually triggered only** (the "Search all job sites" button calls
  `POST /api/scrape`) — no scheduled/cron automation exists or should be added without
  a fresh explicit decision, since unattended background fetching is a materially bigger
  step than a user-clicked action.
- Do not automate jobs.ch login or application submission. `lib/jobsch.ts` never
  authenticates; it only reads pages that are public without a session.
- A full, sanctioned jobs.ch ingestion integration (higher volume, scheduled, or
  authenticated) still requires written JobCloud permission or an authorized API/feed.
  Employer-side XML ingestion is not a public job-seeker search API.
- **2026-08-27 source expansion:** after a source-specific terms/robots/technical review,
  the user explicitly asked the same manually triggered automatic behavior to cover other
  Swiss and Netherlands sites. The currently enabled adapters are jobs.ch, jobup.ch,
  JobScout24, IamExpat, and Undutchables. The three Swiss sites are JobCloud properties and
  therefore share the known unsanctioned-automation risk. IamExpat uses current public job
  paths. Undutchables uses only its plain public listing page, not the query-string paths
  disallowed by its robots policy. Keep caps, fixed delays, and truthful source reporting.
- Indeed Switzerland/Netherlands remain `blocked`: their rules prohibit automated access
  without written permission and live requests returned HTTP 403. Job-Room is
  `unavailable` because its documented API is for employer publication, Nationale
  Vacaturebank is `unavailable` after HTTP 403, and I amsterdam is `disabled` because it
  is a guide rather than a job feed. Never bypass these outcomes. LinkedIn is excluded.
- Every configured source must write a truthful per-run status. Do not label a blocked,
  unavailable, disabled, or failed source as searched successfully.

## Technical shape

- Next-compatible React app built with Vinext/Vite and the OpenAI Sites scaffold.
- Cloudflare D1 binding `DB` stores the saved CVs and analyzed jobs.
- Cloudflare R2 binding `CV_FILES` stores the original CV files.
- CV text is extracted in the browser from PDF, DOCX, or TXT, then submitted with the file.
- API routes live under `app/api`; deterministic analysis lives in `lib/analysis.ts` and
  `lib/role-detection.ts`.
- The app is single-user for the MVP. It holds up to two CV versions for that one person,
  keyed by `slot` (`a`/`b`) in the `cvs` table. Each search role is derived locally from
  its CV, with an optional persisted override in `search_settings`; every job is scored
  against both CVs. Explicit language-result feedback lives separately in
  `language_feedback` so rescoring never overwrites the user's judgment.

## Commands

```text
npm install
npm run dev
npm run lint
npm test
npm run typecheck
npm run build
npm run db:generate
```

On Windows, `@rolldown/binding-win32-x64-msvc` is an explicit dev dependency because npm can omit the optional native binding. Local Sites/Miniflare state is under `.wrangler/` and is intentionally ignored by Git.

## Engineering rules

- Preserve the strict three-state language result: `pass`, `review`, `blocked`.
- Prefer false negatives over false positives for “English sufficient.”
- Keep the reason for every language decision visible to the user.
- Preserve the detector result when applying user language corrections; only an explicit
  user correction may change the effective result shown in Matches or Review.
- Never send a CV or job description to a third-party model without explicit user consent and a documented retention policy.
- Never store VPN credentials or private tunnel keys in the project. Preserve the
  provider-supported, user-visible sign-in boundary in `docs/VPN.md`; do not replace it
  with UI automation, public proxies, proxy rotation, or IP cycling.
- Validate all manually imported URLs server-side; do not trust browser input.
- Keep one SQL statement per D1 `prepare()` call. Add indexes for new recurring queries.
- The schema lives in three hand-synced places: base creation in `db/runtime.ts`, ordered
  applied upgrades in `db/migrations.ts`, and Drizzle's generation model in `db/schema.ts`.
  Add a new migration version for every deployed schema change; never edit an applied
  migration or reset `.wrangler/` as a shortcut. Back up local state and test both existing
  and fresh databases. See `docs/ARCHITECTURE.md` §7a.
- Do not expose `cv_text` or the R2 object key in API responses.
- Preserve user-controlled external navigation for every source login and application.
- Add tests whenever the language rules change, especially “optional” versus “mandatory” wording.

## Definition of done for changes

Run lint and production build, exercise the affected API or UI flow, update the relevant documentation, and record any unresolved platform-permission or privacy issue.

Lint and build passing is not the same as working. If a flow was not actually exercised —
or was exercised and failed — say so plainly in the summary and record it under "Known
risks" in `docs/ARCHITECTURE.md` rather than implying the feature is done. The current
two-CV verification evidence and remaining gaps are recorded in `docs/HANDOFF.md`.
