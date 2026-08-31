# Ik Engels — English Job Radar

Ik Engels is a local job-search tool for finding Swiss and Netherlands roles where English is
sufficient. It combines CV profiles with strict language screening and a simple application
pipeline while keeping login and applications on the original job site. Accounts, CVs, jobs, and
search history stay on the computer running it.

## Download with Codex

Give Codex this repository URL:

```text
https://github.com/Ydony/northbound-job-radar
```

Ask it to clone the repository and read `AGENTS.md`, `docs/GETTING_STARTED.md`, and
`docs/VPN.md` before installing anything. The getting-started guide contains dedicated
Apple Silicon/Intel macOS instructions, Windows instructions, VPN setup, and normal usage.

## What the MVP does

1. Upload up to two PDF, DOCX, or TXT CVs (e.g. a generalist and a specialist version). Ik Engels detects a likely target role from each CV's own content; you can override either role when the heuristic is too broad.
2. Add up to five persisted search roles (for example Supply Chain, Data Analyst, Data Governance, Master Data, and Business Analyst), plus optional location/canton, workplace, seniority, contract, required-keyword, and exclusion filters.
3. Click **Search all job sites**. One manually triggered run checks every configured source and records a truthful result for each. The currently enabled public-page adapters are jobs.ch, jobup.ch, JobScout24, IamExpat, and Undutchables. LinkedIn is deliberately excluded.
4. High-volume discovery uses Job-Room, Adzuna, Careerjet when configured, and verified public
   employer ATS boards. Sources that cannot be searched are still shown truthfully: Indeed is
   blocked, Nationale Vacaturebank is unavailable, and I amsterdam is a guide rather than a feed.
5. Ik Engels classifies the language requirement as:
   - `pass`: English ad, no mandatory local language detected;
   - `review`: evidence is incomplete or ambiguous;
   - `blocked`: a mandatory local language or a non-English ad is detected.
6. Mark a language result accurate or correct it to pass, review, or blocked with an optional reason. Your explicit correction controls the result views while the detector's original decision remains visible.
7. Each job is scored against every saved CV; the card shows the source, country, original posting date when available, best score, and per-CV breakdown. Mark it Applied or Not applied, save it, dismiss/restore it, and open the original source page to apply. Dismissal tombstones prevent later searches from re-adding the same advert.
8. Filter the unified list by Switzerland/Netherlands, Applied/Not applied, source, and result view. The latest-run dashboard shows found, known, new, added, duplicate, and skipped counts per website; cumulative metrics show where analyzed jobs and applications came from.
9. Export the workspace as JSON or jobs as CSV, delete selected/all jobs, remove either CV, or reset all locally stored data from the dashboard.

Ik Engels never automates an account, login, or application submission. Those actions
stay on the original job website and are done by you. **Analyze a job** remains available
for a public HTTPS advert that an automatic adapter cannot access.

## Run locally

Requirements: Node.js 22.13 or newer.

```text
npm install
npm run init-secrets
npm run dev
```

Open `http://localhost:3000` for the hot-reload **dev** environment. To run the stable built
**test** environment at the same time, use a second terminal:

```text
npm run test:local
```

Open `http://localhost:3001` for test. Dev and test have different D1 databases, R2 buckets, and
session secrets. Their local data lives under `.wrangler/dev/state` and `.wrangler/test/state`.
See `docs/ENVIRONMENTS.md` before resetting, copying, or migrating either environment.

For the optional Windows privacy launcher, run `npm run vpn:setup` once, complete the
provider's visible sign-in and Netherlands/kill-switch setup, then use
`npm run dev:private`. That launcher refuses to start without a detected full VPN route.
See `docs/VPN.md`; no VPN credentials are stored by Ik Engels.

On macOS, the equivalent commands are `npm run vpn:setup:mac` once and
`npm run dev:private:mac` for VPN-enforced startup.

Only one hot-reload `vinext dev` process can run from this project. The stable test server uses the
built Worker through Wrangler, so dev and test can run together on ports 3000 and 3001.

Runtime schema upgrades are ordered and recorded in `schema_migrations`. Back up the
ignored `.wrangler/` directory before changing a migration that touches stored data; never
reset it merely to make a new column work. See `docs/ARCHITECTURE.md` §7a.

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
- `lib/job-adapters.ts` — shared Swiss/Netherlands adapter roster and source parsers
- `lib/job-identity.ts` — canonical URLs, source metadata, and conservative deduplication
- `lib/jobsch.ts` — shared structured-job parsing helpers retained from the first jobs.ch adapter
- `tests/` — language, role, scoring, export, adapter, identity, and migration regression tests
- `db/schema.ts` — D1 schema used for generated migrations
- `db/runtime.ts` — local/runtime schema initialization and bindings
- `.openai/hosting.json` — logical local D1/R2 binding names (no hosted project id)
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

JobCloud's published terms cover jobs.ch, jobup.ch, and JobScout24 and prohibit automated
extraction; Indeed likewise prohibits automated access without written permission.
Ik Engels does not pretend these are sanctioned integrations. At the user's explicit,
informed direction (2026-08-26 and expanded 2026-08-27), the three JobCloud adapters run
anyway for personal use, while Indeed stays blocked. IamExpat and Undutchables use only
current public listing/detail paths; Undutchables query-string search is deliberately not
used. Every run is user-triggered, capped, delayed, unauthenticated, and uses a plain
identifiable User-Agent. There is no CAPTCHA handling, stealth browser, proxy rotation,
login, or automatic application submission. Written permission or an authorized API/feed
is still required for a sanctioned, higher-volume, or scheduled integration. See
`docs/ARCHITECTURE.md` for the source-by-source record.
