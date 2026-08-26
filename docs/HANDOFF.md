# Handover

Last updated: 2026-08-26.

Current state, what is unfinished, and the next action. Read this first, then
`README.md`, `docs/ARCHITECTURE.md`, and `AGENTS.md`.

## 1. Read this before anything else: nothing is committed

`git log` reports **no commits on `master`** — the entire project is untracked working-tree
state. There is no baseline to diff against and no way to recover an earlier version of any
file. Two sessions of work (the jobs.ch scraper and the two-CV change) exist only as
uncommitted files.

**Highest-value next action: make an initial commit.** Check `.openai/hosting.json` and any
`.env*` for secrets before staging, and add `tsconfig.tsbuildinfo` (a build artifact,
currently untracked) to `.gitignore`.

## 2. What works

- Language gate, per-CV fit scoring, and the pipeline UI (`lib/analysis.ts`,
  `app/job-radar.tsx`).
- `POST /api/profile` — verified: both CV slots save, and role derivation returns
  `"Software Engineer"` / `"Data Analyst"` for the two synthetic test CVs.
- The jobs.ch scraper (`lib/jobsch.ts`, `POST /api/scrape`) was verified end to end
  **under the previous single-CV schema**: it scanned 21 listings, added 8, correctly
  blocked 7 for mandatory German/French, and deduplicated on a second run.
- `npm run lint`, `npm run build`, and `npx tsc --noEmit` are all clean. (`tsc` reports two
  pre-existing `pdfjs-dist` typing errors that predate this work.)

## 3. What is unfinished or broken

### `POST /api/scrape` returns 500 — not yet re-verified

The two-CV schema change (`fit_score` → `fit_score_a`/`fit_score_b`/`best_cv_slot`,
`profiles` → `cvs`) is complete in code but **was never successfully exercised**.

Root cause is understood and is *not* a code bug: `ensureSchema()` only runs
`CREATE TABLE IF NOT EXISTS`, so the local database created under the old schema still has
the old columns. Reads returned `undefined` (surfacing as a `NaN` React warning) and writes
failed with a 500. See `docs/ARCHITECTURE.md` §7a.

**Next action:** stop any running dev server, move `.wrangler/` aside, `npm run dev`,
re-upload two CVs, then `POST /api/scrape` and confirm the response carries sensible
`fitScoreA`/`fitScoreB`/`bestCvSlot`, and that the UI renders the per-CV breakdown. Until
that passes, treat two-CV support as unverified — this was never confirmed working.

### `drizzle/` is stale

Still describes the pre-two-CV schema. `npm run db:generate` needs an interactive terminal
to resolve the `profiles` → `cvs` rename, so it could not be regenerated non-interactively.
No runtime impact (see §7a), but `db/schema.ts` and `drizzle/` currently disagree.

### No tests exist

There is no test framework installed. `AGENTS.md` asks for tests whenever the language
rules change, and `docs/ROADMAP.md` makes a regression corpus part of the Phase 0 exit
criterion. Two things now most need coverage: the language gate's
"optional" vs "mandatory" wording, and `lib/role-detection.ts` — a small hand-written
heuristic that already needed one fix (it was pulling "Candidate" off a CV's name line into
the derived role).

## 4. Environment gotchas that cost time

- **Only one `vinext dev` server can run per machine.** Startup fails with the PID and
  directory of the existing one; stop that process first.
- **A second copy of this project exists at
  `C:\Users\anddo\Documents\ChatGPT\Auto Job hunt`.** It is a separate, unsynced directory
  (not a symlink) without any of this work, and it holds the same machine-wide dev-server
  lock. Confirm which directory you are in before starting servers or killing processes.
  Worth deciding whether that copy should be retired — the two will keep diverging.
- The dev server usually lands on **port 3002** (3000 and 3001 are taken on this machine).
- In Git Bash, `taskkill` needs escaped slashes: `taskkill //PID <pid> //F`.

## 5. Compliance status — unchanged, still deliberate

`POST /api/scrape` knowingly operates against jobs.ch's Terms of Service and its
`robots.txt` (which disallows the job-detail pages specifically). This was the user's
explicit, informed decision on 2026-08-26, reversing this repo's original prohibition. The
full decision record is in `docs/ARCHITECTURE.md` §2.

The boundary that did **not** move: no detection evasion. No randomized/human-like timing,
fingerprint spoofing, headless-browser stealth plugins, or proxy rotation. Keep it that way
regardless of any future scope change here.
