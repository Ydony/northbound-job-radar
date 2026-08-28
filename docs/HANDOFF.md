# Handover

Last updated: 2026-08-28 after adding authorized high-volume API sources (Job-Room, Adzuna,
Careerjet) and employer-declared language screening.

## 0. Most recent change: authorized bulk sources

Discovery was limited by page-fetching adapters costing one request per job (four new jobs per
source per run). Three API-based sources now return whole advertisements in the search response:

- **Job-Room (arbeit.swiss)** — official Swiss public employment service, unauthenticated public
  search API, 67,000+ vacancies, and **employer-declared language requirements** that now take
  precedence over the prose heuristic. No key needed; live and working.
- **Adzuna** and **Careerjet** (CH + NL) — authorized aggregator APIs. Both are wired and report
  `unavailable` with setup instructions until free credentials are set. **To enable them, add
  `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` and `CAREERJET_AFFID`** — sign-up is free at
  developer.adzuna.com and careerjet.com/partners/api. Their descriptions are teasers, so expect
  their jobs to land in review rather than pass.

Measured live result of one run: the workspace went from **77 to 250 jobs**, scanning 799
candidates (590 from Job-Room alone) versus roughly 90 before. See `docs/ARCHITECTURE.md` §7b.

Do not re-investigate two confirmed dead ends: werk.nl/UWV has no vacancy API, and recruitment
agencies yielded 12 jobs across 10 major CH/NL firms because their ATS boards carry only internal
hiring. Detail and reasoning are in §7b.

## 0b. Earlier state (still current)

Last verified 2026-08-28 after live-verifying and correcting the automatic multi-source iteration.

Read this first, use `docs/TASKS.md` for current execution status, then read `README.md`, `docs/ARCHITECTURE.md`, and `AGENTS.md`.

Before changing discovery, job identity, pipeline state, or filters, also read
`docs/MULTI_SOURCE_PLAN.md`. It is now both the accepted design and the source-by-source
permission/availability record.

## 1. Repository state

- Baseline commit: `344a642` (`Initial commit: Northbound Swiss job radar MVP`).
- Verified two-CV checkpoint: `2a77a70` (`Verify two-CV flow and add regression coverage`).
- Real-CV and search-criteria checkpoint: `a8e7ba1` (`Add persisted job criteria and validate real CV flow`).
- Language-correction checkpoint: `67669d8` (`Add persistent language classification feedback`).
- Personal-data controls checkpoint: `7c1fa3b` (`Add personal data export and deletion controls`).
- Windows VPN checkpoint: `bfce858` (`Add VPN-enforced local launcher`).
- Netherlands/macOS checkpoint: `6fd7b18` (`Add Netherlands sources and macOS VPN launcher`).
- Multi-source plan checkpoint: `7cc480c` (`Plan automatic multi-source job search`).
- Multi-source implementation checkpoint: `6e52c09` (`Implement multi-source job search and pipeline controls`).
- Use `git status`, `git log -3 --oneline`, and `docs/TASKS.md` to identify later work.
- No `.env` files or obvious committed secrets were found. `.openai/hosting.json` contains binding names only.
- `*.tsbuildinfo`, dependency folders, builds, and local Miniflare data are ignored.

## 2. Current local data and verification

The old `.wrangler/` state was preserved under ignored `work/wrangler-before-two-cv-verification/`, then a fresh local database was created.

The current local database contains both user-provided CV profiles and 69 distinct Swiss/Netherlands ads. The multi-source upgrade was applied in place after copying all 18 `.wrangler` files (680,925 bytes) to ignored `work/wrangler-before-multisource/`. Verification completed without exposing CV text:

- Both PDFs parsed through the browser UI (4,049 and 4,885 extracted characters) and saved to separate slots.
- Improved role detection derived `Data Analyst` and `Data Governance Analyst`; saved overrides refine these to `Supply Chain Data Analyst` and `Master Data Governance Analyst`.
- Role overrides persisted after reload and shaped jobs.ch URLs, new-job fit scoring, rescoring, and UI labels.
- Capped searches expanded the workspace to 69 ads. The current raw language split is 12 `pass`, three `review`, and 54 `blocked`; 65 are active and four dismissed.
- The first VPN-protected multi-source run exposed an Undutchables relaxed-parser overreach and over-broad Netherlands listing selection. The four affected imports were removed, the parser was restricted to its JobPosting JSON-LD block, foreign locations and irrelevant role URLs were rejected, and a clean rerun added five Netherlands jobs: two `pass`, one `review`, and two correctly blocked for Dutch/German requirements.
- Live findings added regression rules for `German ... advantageous` (optional/pass) and `English and French advanced level` (mandatory/block).
- Every stored job has numeric per-CV scores and a valid winning slot.
- Five additional roles are saved: Supply Chain, Data Analyst, Data Governance, Master Data, and Business Analyst.
- Runtime migrations 1–3 applied successfully; all 48 IDs and canonical URLs are distinct.
- Live API smoke checks switched one existing card to Applied and Dismissed, then attempted
  both its trailing-slash URL variant and an equivalent jobup.ch mirror. Both returned the
  same stored ID as duplicate+dismissed, the count stayed 48, and the original state was restored.
- The dashboard is available at `http://localhost:3000/` while the current development process is running.

Quality checks:

- `npm test`: 46 passing tests.
- `npm run typecheck`: clean.
- `npm run lint`: clean.
- `npm run build`: clean after the current changes.
- `npm run db:generate`: generated `drizzle/0003_cloudy_toro.sql` and its snapshot for the multi-source schema.

## 3. Current capabilities

- Persisted role overrides, location/canton, workplace, seniority, contract type, required keywords, and exclusions.
- Role and location are sent to jobs.ch search; all criteria filter local result views, while saved/applied Pipeline jobs stay visible.
- Changing roles or replacing a CV recalculates language and fit data for all stored jobs.
- Role detection strongly prefers a specific title in the CV header over repeated older roles.
- Search settings exist in runtime schema, Drizzle schema, and migration `0001`.
- Regression coverage includes language rules, real-CV-derived title shapes, search criteria, job URL construction, scoring, parsing, and source interleaving.
- Every job card can be marked Accurate or corrected to pass/review/blocked with an optional reason.
- An explicit correction controls Matches/Review and the card badge while preserving the detector's original status and explanation.
- Feedback survives reload, criteria rescoring, CV/job analysis, and re-importing the same job; it can also be cleared.
- The additive `language_feedback` table and migration `0002` avoided resetting the then-24-job workspace.
- The dashboard can export safe workspace metadata/jobs as JSON or jobs as CSV, delete selected/all jobs, delete either CV, and perform a confirmation-gated full reset.
- Exported profile metadata never includes extracted CV text or R2 object keys. Job deletion also removes associated language feedback; CV deletion removes its R2 object and rescores jobs with the remaining CV.
- The earlier data-control checkpoint passed three destructive-action guards plus a temporary job create/delete round trip while preserving the then-current 24 jobs and saved criteria.
- Optional Windows VPN helpers install the official Windscribe or Proton client, detect a
  full-tunnel route, and provide `npm run dev:private`, which refuses to start without one.
  No VPN credentials or tunnel keys are stored. Windscribe 2.23.12 was installed and live
  verification passed through the Netherlands (`WindscribeWireguard`, exit country NL).
- Matching macOS commands install through Homebrew and enforce a full `utun` IPv4 route.
  Their shell syntax is verified on Windows; live behavior still needs the Apple device.
- One **Search all job sites** action runs every configured adapter with failure isolation,
  deduplicates the combined result set, applies the strict language gate, scores both CVs,
  and stores a per-source report.
- Enabled adapters: jobs.ch, jobup.ch, JobScout24, IamExpat, and Undutchables. LinkedIn is
  absent. Indeed CH/NL, Job-Room, Nationale Vacaturebank, and I amsterdam remain visible as
  blocked, unavailable, or disabled rather than being reported as searched.
- Five editable search roles persist and are included in adapter queries/reports.
- Jobs store canonical identity, source, country, original posted date, first/last seen,
  independent saved/application/visibility state, and conservative cross-source identity.
- The unified list filters by country, application state, source, and result view. Every
  card provides Applied, Not applied, Save, Dismiss, and Restore controls and displays a
  posting date or an explicit unavailable label.
- Latest-run and cumulative source dashboards show discovery and pipeline performance.
  The old Amsterdam manual-link directory has been removed.

## 4. Remaining work and risks

- The external multi-source smoke run passed on 2026-08-28 through Windscribe's Netherlands
  exit. Keep using `npm run dev:private`; it refuses to start without a full VPN route.

- The language corpus has focused tests, a 24-ad live review, and persisted correction controls, but the user has not yet labeled a representative set. Do that before relying on unattended alerts.
- The role detector remains a small heuristic and needs more real CV layouts.
- Detail fetch/parse failures are counted as skipped and source failures are isolated, but
  the exact parser failure is intentionally not persisted per job. Add fixture coverage
  whenever a public source changes its markup.
- Runtime migrations are now applied and versioned. Drizzle SQL is generated for schema
  review but is not the local runtime executor; keep all three schema representations in sync.
- No authentication, multi-user isolation, OCR, automated backups, retention schedule, or encryption policy exists. User-triggered deletion/reset and JSON/CSV export are now available.

## 5. Environment notes

- Only one `vinext dev` server can run per machine.
- The development server selects the first available local port, normally 3000 on a fresh machine.
- Running repeated production builds while the development server was hot-reloading produced a transient Vinext/Vite `window is not defined` development overlay. API saves still returned 200 and the clean production build passed; restart the dev server if the overlay persists instead of treating it as a data failure.
- Local state is in `.wrangler/`; the byte-count-verified pre-multi-source backup is in
  ignored `work/wrangler-before-multisource/`.
- Fixture CVs in `tests/fixtures/` contain synthetic names and data only. Temporary real-CV test copies live under ignored `tmp/` and must never be committed.

## 6. Compliance status

`POST /api/scrape` knowingly operates unsanctioned JobCloud public-page adapters for
jobs.ch, jobup.ch, and JobScout24 at the user's explicit, informed direction. Indeed stays
blocked. The current source-by-source decision is in `docs/ARCHITECTURE.md` §2 and
`docs/MULTI_SOURCE_PLAN.md`.

The unchanged boundary is no detection evasion: no randomized or human-like timing,
fingerprint spoofing, stealth browser plugins, CAPTCHA handling, or proxy rotation. Fetches
remain manually triggered, unauthenticated, delayed, capped, and truthfully identified.
