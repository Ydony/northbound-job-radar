# Handover

Last updated: 2026-08-26 after real-CV, search-criteria, and 24-ad verification.

Read this first, use `docs/TASKS.md` for current execution status, then read `README.md`, `docs/ARCHITECTURE.md`, and `AGENTS.md`.

## 1. Repository state

- Baseline commit: `344a642` (`Initial commit: Northbound Swiss job radar MVP`).
- Verified two-CV checkpoint: `2a77a70` (`Verify two-CV flow and add regression coverage`).
- Real-CV and search-criteria checkpoint: `a8e7ba1` (`Add persisted job criteria and validate real CV flow`).
- Language-correction checkpoint: `67669d8` (`Add persistent language classification feedback`).
- Use `git status`, `git log -3 --oneline`, and `docs/TASKS.md` to identify later work.
- No `.env` files or obvious committed secrets were found. `.openai/hosting.json` contains binding names only.
- `*.tsbuildinfo`, dependency folders, builds, and local Miniflare data are ignored.

## 2. Verified working with the user's real CVs

The old `.wrangler/` state was preserved under ignored `work/wrangler-before-two-cv-verification/`, then a fresh local database was created.

The current local database contains the two user-provided text-based PDFs and 24 real jobs.ch ads. End-to-end checks completed successfully:

- Both PDFs parsed through the browser UI (4,049 and 4,885 extracted characters) and saved to separate slots.
- Improved role detection derived `Data Analyst` and `Data Governance Analyst`; saved overrides refine these to `Supply Chain Data Analyst` and `Master Data Governance Analyst`.
- Role overrides persisted after reload and shaped jobs.ch URLs, new-job fit scoring, rescoring, and UI labels.
- Two manually triggered, capped searches expanded the workspace from eight to 24 ads.
- The reviewed language split is five `pass`, one deliberately ambiguous `review`, and 18 `blocked`.
- Live findings added regression rules for `German ... advantageous` (optional/pass) and `English and French advanced level` (mandatory/block).
- Every stored job has numeric per-CV scores and a valid winning slot.
- The dashboard is available at `http://localhost:3002/` while the current development process is running.

Quality checks:

- `npm test`: 26 passing tests.
- `npm run typecheck`: clean.
- `npm run lint`: clean.
- `npm run build`: clean after the current changes.
- `npm run db:generate`: generated `drizzle/0001_lush_silvermane.sql` for search settings.

## 3. Important capabilities through `67669d8`

- Persisted role overrides, location/canton, workplace, seniority, contract type, required keywords, and exclusions.
- Role and location are sent to jobs.ch search; all criteria filter local result views, while saved/applied Pipeline jobs stay visible.
- Changing roles or replacing a CV recalculates language and fit data for all stored jobs.
- Role detection strongly prefers a specific title in the CV header over repeated older roles.
- Search settings exist in runtime schema, Drizzle schema, and migration `0001`.
- Regression coverage includes language rules, real-CV-derived title shapes, search criteria, job URL construction, scoring, parsing, and source interleaving.
- Every job card can be marked Accurate or corrected to pass/review/blocked with an optional reason.
- An explicit correction controls Matches/Review and the card badge while preserving the detector's original status and explanation.
- Feedback survives reload, criteria rescoring, CV/job analysis, and re-importing the same job; it can also be cleared.
- The additive `language_feedback` table and migration `0002` avoid resetting the existing 24-job workspace.

## 4. Remaining work and risks

- The language corpus has focused tests, a 24-ad live review, and persisted correction controls, but the user has not yet labeled a representative set. Do that before relying on unattended alerts.
- The role detector remains a small heuristic and needs more real CV layouts.
- The scraper silently skips individual job-detail fetch/parse failures; source-health reporting is still missing.
- There is no applied migration runner or backfill path. Runtime still uses `CREATE TABLE IF NOT EXISTS`; future schema changes require a real migration strategy before data matters.
- No authentication, multi-user isolation, CV delete/export, OCR, backups, or retention controls exist.
- The old duplicate project folder at `C:\Users\anddo\Documents\ChatGPT\Auto Job hunt` has no source file absent from the new project, but Windows would not recycle it because this Codex task still holds a lock. Nothing was deleted. Close this task or reopen from `C:\Projects\Auto Job hunt`, then retire the old folder.

## 5. Environment notes

- Only one `vinext dev` server can run per machine.
- Ports 3000 and 3001 are occupied on this machine, so the app normally uses 3002.
- Running repeated production builds while the development server was hot-reloading produced a transient Vinext/Vite `window is not defined` development overlay. API saves still returned 200 and the clean production build passed; restart the dev server if the overlay persists instead of treating it as a data failure.
- Fresh local state is in `.wrangler/`; the pre-verification state backup is in ignored `work/`.
- Fixture CVs in `tests/fixtures/` contain synthetic names and data only. Temporary real-CV test copies live under ignored `tmp/` and must never be committed.

## 6. Compliance status

`POST /api/scrape` knowingly operates against jobs.ch's Terms of Service and `robots.txt` at the user's explicit, informed direction. The full decision is in `docs/ARCHITECTURE.md` §2.

The unchanged boundary is no detection evasion: no randomized or human-like timing, fingerprint spoofing, stealth browser plugins, or proxy rotation. The fetch remains manually triggered, unauthenticated, delayed, and capped.
