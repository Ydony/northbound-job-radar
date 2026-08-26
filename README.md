# Northbound — Swiss Job Radar

Northbound is a local MVP for finding Swiss jobs where English is sufficient. It combines a CV profile with strict language screening and a simple application pipeline while keeping jobs.ch login and applications on jobs.ch.

## What the MVP does

1. Upload up to two PDF, DOCX, or TXT CVs (e.g. a generalist and a specialist version). Northbound detects a likely target role from each CV's own content; you can override either role when the heuristic is too broad.
2. Set optional location/canton, workplace, seniority, contract, required-keyword, and exclusion filters. The criteria persist across reloads; role and location shape jobs.ch discovery and all criteria filter the local views.
3. Click "Find new jobs" to fetch and screen fresh jobs.ch listings for the selected role(s) automatically, or open a targeted jobs.ch search yourself and paste one ad in by hand.
4. Northbound classifies the language requirement as:
   - `pass`: English ad, no mandatory local language detected;
   - `review`: evidence is incomplete or ambiguous;
   - `blocked`: a mandatory local language or a non-English ad is detected.
5. Mark a language result accurate or correct it to pass, review, or blocked with an optional reason. Your explicit correction controls the result views while the detector's original decision remains visible.
6. Each job is scored against every saved CV; the card shows the best score and the per-CV breakdown, so you can see which CV version to apply with. You can save or hide the job, track applications, and open the original jobs.ch page to apply.

The MVP fetches public jobs.ch search and listing pages directly (see "Product and
compliance decision" below) but does not automate a jobs.ch account, log in, or submit
applications — those stay on jobs.ch, done by you.

## Run locally

Requirements: Node.js 22.13 or newer.

```text
npm install
npm run dev
```

Open the local URL printed by the development server. D1 and R2 are emulated locally by Miniflare; their state remains in the ignored `.wrangler/` directory.

Only one `vinext dev` server can run per machine. If startup reports one is already
running, stop that process first — note the directory it reports, since a second copy of
this project elsewhere on disk will hold the same lock.

After any database column change, reset local state (move or remove `.wrangler/`) before
restarting — the schema is only ever created, never altered. See `docs/ARCHITECTURE.md`
§7a.

Quality checks:

```text
npm run lint
npm test
npm run typecheck
npm run build
npm run db:generate
```

`npm run db:generate` requires an interactive terminal when it needs to resolve a table or
column rename.

## Important files

- `app/job-radar.tsx` — dashboard and client-side CV parsing
- `app/api/` — profile, criteria, state, job import/scrape, and status endpoints
- `lib/analysis.ts` — deterministic language gate and per-CV fit scoring
- `lib/role-detection.ts` — derives a likely target role from CV text
- `lib/jobsch.ts` — jobs.ch search/detail fetching and parsing (see compliance decision below)
- `tests/` — deterministic language, role, scoring, and source-helper regression tests
- `db/schema.ts` — D1 schema used for generated migrations
- `db/runtime.ts` — local/runtime schema initialization and bindings
- `.openai/hosting.json` — Sites persistence bindings
- `AGENTS.md` — rules for another coding LLM
- `docs/HANDOFF.md` — current state, what is unfinished, and the next action
- `docs/TASKS.md` — MVP and post-MVP execution tracker with progress and acceptance criteria
- `docs/ARCHITECTURE.md` — flows, decisions, data model, and risks
- `docs/ROADMAP.md` — what is needed after the MVP

## Product and compliance decision

JobCloud's published jobs.ch terms prohibit automated extraction, and `robots.txt`
separately disallows crawling job-detail pages specifically; no public job-seeker search
API was found either. Northbound automates fetching anyway, at the user's explicit,
informed instruction (recorded 2026-08-26) — this is a deliberate, known ToS/robots.txt
violation for personal use, not a compliant integration. It is deliberately limited:
manually triggered only (no schedule/cron), capped to a handful of new listings per
click, a fixed delay between requests, and a plain, non-spoofed User-Agent with no
anti-detection behavior of any kind. A sanctioned, higher-volume, or scheduled
integration still requires written JobCloud permission or an authorized API/feed. See
`docs/ARCHITECTURE.md` for the full decision record and links.
