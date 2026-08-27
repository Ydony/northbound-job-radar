# Northbound — English Job Radar

Northbound is a local MVP for finding Swiss and Netherlands jobs where English is sufficient. It combines CV profiles with strict language screening and a simple application pipeline while keeping login and applications on the original job site.

## Download with Codex

Give Codex this repository URL:

```text
https://github.com/Ydony/northbound-job-radar
```

Ask it to clone the repository and read `AGENTS.md`, `docs/GETTING_STARTED.md`, and
`docs/VPN.md` before installing anything. The getting-started guide contains dedicated
Apple Silicon/Intel macOS instructions, Windows instructions, VPN setup, and normal usage.

## What the MVP does

1. Upload up to two PDF, DOCX, or TXT CVs (e.g. a generalist and a specialist version). Northbound detects a likely target role from each CV's own content; you can override either role when the heuristic is too broad.
2. Set optional location/canton, workplace, seniority, contract, required-keyword, and exclusion filters. The criteria persist across reloads; role and location shape jobs.ch discovery and all criteria filter the local views.
3. Click "Find new jobs" for the existing jobs.ch flow, or open one of five Netherlands sources: I amsterdam, IamExpat, Undutchables, Indeed Netherlands, and Nationale Vacaturebank. LinkedIn is deliberately excluded.
4. For Netherlands sources, choose a role yourself and paste its complete advertisement into Northbound. These new sources are not scraped or logged into automatically.
5. Northbound classifies the language requirement as:
   - `pass`: English ad, no mandatory local language detected;
   - `review`: evidence is incomplete or ambiguous;
   - `blocked`: a mandatory local language or a non-English ad is detected.
6. Mark a language result accurate or correct it to pass, review, or blocked with an optional reason. Your explicit correction controls the result views while the detector's original decision remains visible.
7. Each job is scored against every saved CV; the card shows the best score and the per-CV breakdown, so you can see which CV version to apply with. You can save or hide the job, track applications, and open the original source page to apply.
8. Export the workspace as JSON or jobs as CSV, delete selected/all jobs, remove either CV, or reset all locally stored data from the dashboard.

The MVP fetches public jobs.ch search and listing pages directly (see "Product and
compliance decision" below) but does not automate a jobs.ch account, log in, or submit
applications — those stay on jobs.ch, done by you.

The Netherlands source directory is handoff-only. Northbound does not fetch, scrape,
log in to, or submit applications on those sites. Manual imports accept a public HTTPS
job-ad URL, including an employer page reached from a listed source.

## Run locally

Requirements: Node.js 22.13 or newer.

```text
npm install
npm run dev
```

For the optional Windows privacy launcher, run `npm run vpn:setup` once, complete the
provider's visible sign-in and Netherlands/kill-switch setup, then use
`npm run dev:private`. That launcher refuses to start without a detected full VPN route.
See `docs/VPN.md`; no VPN credentials are stored by Northbound.

On macOS, the equivalent commands are `npm run vpn:setup:mac` once and
`npm run dev:private:mac` for VPN-enforced startup.

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
- `tests/` — deterministic language, role, scoring, export, and source-helper regression tests
- `db/schema.ts` — D1 schema used for generated migrations
- `db/runtime.ts` — local/runtime schema initialization and bindings
- `.openai/hosting.json` — Sites persistence bindings
- `AGENTS.md` — rules for another coding LLM
- `docs/HANDOFF.md` — current state, what is unfinished, and the next action
- `docs/TASKS.md` — MVP and post-MVP execution tracker with progress and acceptance criteria
- `docs/ARCHITECTURE.md` — flows, decisions, data model, and risks
- `docs/ROADMAP.md` — what is needed after the MVP
- `docs/VPN.md` — optional official VPN installation and VPN-enforced local launcher
- `docs/GETTING_STARTED.md` — friend-ready macOS/Windows installation and usage guide
- `docs/MULTI_SOURCE_PLAN.md` — accepted next iteration for automatic multi-site search,
  durable deduplication, filters, posted dates, role keywords, and source analytics

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
