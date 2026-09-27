# Hosting cost analysis — why the free tier fails, and what to move to

Measured from the code on 2026-09-27, against `claude/pensive-feynman-skj5vd`.
Production is live at `ikbeneenappel.nl` on Cloudflare Workers + D1.

## 1. The headline

**The free plan does not fail because of monthly volume. It fails on two
per-invocation ceilings that no amount of usage reduction will fix.**

One user's whole month of activity is roughly **1,200 Worker requests** — about
0.012% of what the $5/month plan includes. Volume is a non-issue. A single search
click, however, needs ~700 outbound requests and seconds of CPU, and the free plan
caps those at 50 and 10 ms respectively.

The fix is the **$5/month Workers Paid plan**, with a projected overage of **$0.00**
at this scale and for a long way beyond it.

## 2. Why the free tier cannot run a search

`POST /api/scrape` fans out to every enabled adapter in one Worker invocation.
Counted from the source:

| Source | Outbound requests per click | Where |
|---|---:|---|
| `ats-ch` + `ats-nl` (shared batch) | **282** boards | `lib/ats-feeds.ts:648`, `atsCompanies` = 282 entries |
| Job-Room search | up to 30 | 5 terms × `MAX_PAGES_PER_TERM` = 6 |
| Job-Room detail fetches | up to **200** | `MAX_JOB_ROOM_DETAIL_FETCHES` |
| EURES CH + NL | up to 60 | 5 terms × `MAX_EURES_PAGES_PER_TERM` = 6 × 2 |
| FreeHire CH + NL | up to 40 | 5 terms × `MAX_FREEHIRE_PAGES_PER_TERM` = 4 × 2 |
| Admin page-fetch sources (jobs.ch, jobup.ch, JobScout24, IamExpat, Undutchables) | ~40 | search pages + `MAX_NEW_PER_PAGE_SOURCE` = 4 each |
| Adzuna / Careerjet | 0 | credentials deliberately unset in hosted environments |
| ATS retries on transient failure | +10–40 | `fetchCompanyWithRetry`, one retry, never on a refusal |

**Total: ~650–700 outbound requests per click, worst case over 900.**

Against the platform limits:

| Limit | Workers Free | Workers Paid | This app needs |
|---|---|---|---|
| External subrequests per invocation | **50** | 10,000 (raisable to 10M) | ~700 |
| CPU time per invocation | **10 ms** | up to 5 min | seconds |
| Requests per day | 100,000 | unlimited | ~36 |

Two independent hard stops. A search on the free plan dies around the 50th
employer board, and even if it did not, parsing 282 board payloads and running
`analyzeLanguage` over hundreds of advertisements is far past 10 ms of CPU.
(Time spent waiting on `fetch` does not count as CPU, but the parsing does.)

`GET /api/state` is likely over 10 ms too once the catalogue is large — ten
aggregate queries plus serialising a 40-row page.

**Moving collection to the existing cron path does not rescue the free plan.**
Scheduled invocations carry the same 50-subrequest and 10 ms ceilings, so a full
board sweep would need ~47 ticks — at the configured `0 */6 * * *` that is over
a month per sweep.

## 3. One user, one month

Modelled as: job hunting daily, **two sessions a day**, admin account. A session
is open the dashboard, run one search, browse and act on results.

| Per session | Invocations |
|---|---:|
| Page document (SSR/RSC) | 1 |
| `/api/state` initial load | 1 |
| `/api/scrape` | 1 |
| `/api/state` reconcile after the search | 1 |
| `/api/state` on filter changes (each change refetches page one) | ~8 |
| `PATCH /api/jobs/:id` saved/applied/dismissed | ~5 |
| `/api/health`, `/api/criteria`, occasional | ~2 |
| **Session total** | **~19** |

- 2 sessions/day → **38 requests/day**
- × 30 days → **~1,140 requests/month**
- Cron `0 */6 * * *` → 4/day → 120/month (only once `PUBLIC_REFRESH_ENABLED=true`)

**~1,260 Worker requests per user per month.**

Static assets are excluded: on Workers Static Assets they are free and unmetered
on both plans. See §7 — this was not verified.

### D1 rows

Reads scale with the account's holdings, not with clicks. `/api/state` runs about
13–16 passes over the audience-filtered holding set: 10 aggregates in
`queryCatalogueAggregates`, plus places, freshness, collection totals, the page
query, the copies query, and the three maintenance passes
(`normalizeStoredJobs`, `ensureSearchText`, `ensureCurrentJobClusters`).

| Catalogue size | Rows read per `/api/state` | Per day (2 sessions × ~10 loads) |
|---:|---:|---:|
| 2,000 | ~28,000 | ~560,000 |
| 5,000 | ~70,000 | ~1,400,000 |
| 20,000 | ~280,000 | ~5,600,000 |

The free limit is **5,000,000 rows read per day**. At a 5,000-job catalogue one
user sits at roughly 28% of it; at 20,000 jobs a single user exceeds it.

This matters more than it used to: **since 1 September 2026 Cloudflare enforces
the D1 free daily limits by returning errors** rather than letting queries
through. Exceeding the read limit now breaks the app until midnight UTC.

Writes per search click: up to `MAX_NEW_PER_RUN` = 800 new jobs, each writing a
`jobs` row plus the catalogue mirror (`vacancies`, `vacancy_sources`,
`user_vacancy_state`) ≈ 4 rows, so **up to ~3,200 rows written per click**, plus
run rows. Two clicks a day ≈ 6,400/day against a free limit of 100,000/day.

Storage: full advertisement text, ~5 KB each. 20,000 ads ≈ 100 MB against 5 GB free.
The catalogue is shared across accounts (`vacancies` has no `user_id`), so storage
grows with distinct adverts, not with users.

**D1's free tier is survivable for one user. Workers' free tier is not.**

## 4. Pricing

| | Workers Free | Workers Paid |
|---|---|---|
| Base | $0 | **$5/month** |
| Requests | 100,000/day | 10M/month included, then $0.30/million |
| CPU | 10 ms/invocation | 30M CPU-ms/month included, then $0.02/million |
| Subrequests | 50 external | 10,000/invocation, raisable to 10M |
| D1 rows read | 5M/day (enforced, errors) | 25 **billion**/month, then $0.001/million |
| D1 rows written | 100,000/day | 50M/month, then $1.00/million |
| D1 storage | 5 GB | 5 GB, then $0.75/GB-month |

### Projected bill on Workers Paid

| Workload | Requests/mo | CPU-ms/mo | Rows read/mo | Monthly cost |
|---|---:|---:|---:|---|
| 1 user (this model) | ~1,300 | ~300,000 | ~42M | **$5.00** |
| 10 users | ~13,000 | ~3M | ~420M | **$5.00** |
| 100 users | ~130,000 | ~30M | ~4.2B | **$5.00**, CPU at the edge of included |

Every figure is inside the included allowance. CPU is the only one that gets
close, at around 100 active users; past that it is $0.02 per million CPU-ms, so
roughly $0.60 for another 30M. Storage would be the next thing to watch, not
requests.

**Options, ranked:**

1. **Workers Paid, $5/month — recommended.** Removes both blockers, changes no
   code, keeps D1, cron, the rate-limit binding, secrets and the custom domain
   exactly as they are. Overage $0.00 at any plausible scale for this project.
2. **Stay free and gut the product.** The only way to fit 50 subrequests is to
   drop the ATS tier (282 of the ~700 requests) and the Job-Room detail pass
   (another 200) — the detail pass is what makes Job-Room screenable at all, per
   `ARCHITECTURE.md` §7b. That is not a saving, it is a different, worse product,
   and 10 ms of CPU would still be too little.
3. **Move off Cloudflare** — see §5. Similar monthly cost, days of engineering,
   and it drops capabilities the app currently gets for free.

## 5. Could it be an ordinary website on normal web hosting?

Not as it stands, and the distinction that matters is **shared hosting vs. a VPS**.

This is not a static site. It is React Server Components (vinext) with
server-rendered pages and server-side API routes; `npm run build` emits a Worker
bundle, not HTML files. It needs:

- a JavaScript server runtime (Node 22+)
- a SQLite-compatible database
- outbound HTTP that can run ~700 requests over tens of seconds
- secrets (`SESSION_SECRET`, `RESEND_API_KEY`)
- a scheduler for the 6-hourly refresh
- a custom domain with TLS — already held

**Shared web hosting (cPanel, OVH shared, typical PHP plans): no.** These are
PHP + MySQL. There is no Node runtime, and `max_execution_time` is commonly
30–120 seconds with long outbound fetches restricted or blocked. A plan with
Node.js support could host it only after the database layer is rewritten.

**A VPS (OVH VPS, Hetzner, etc.): yes, technically.** Node 22, a SQLite file,
systemd, nginx, certbot, one crontab line. Critically, **neither of the two
limits that break the free Worker plan exists on a VPS** — no subrequest cap, no
per-invocation CPU cap. Around €4–8/month, so comparable to $5.

The cost is not the hosting, it is the port:

- `db/runtime.ts` and every `prepare()` call site would move from the D1 binding
  API to a SQLite driver — 23 call sites in `lib/server-data.ts`, 13 in
  `lib/catalogue.ts`, 11 in `lib/catalogue-query.ts`, plus the routes. `db.batch()`
  has no direct driver equivalent and would become explicit transactions.
- The `AUTH_RATE_LIMIT` native binding (`vite.config`) has no VPS equivalent; the
  D1 limiter in `lib/rate-limit.ts` would have to carry the whole job.
- Cron Triggers → crontab, and `worker/entry.ts`'s `scheduled` export goes away.
- You take on OS patching, TLS renewal, backups and uptime — all currently free.

Realistically several days of work plus ongoing maintenance, to save nothing.

## 6. Recommendation

**Take Workers Paid at $5/month.** It is the only option that fixes the actual
blockers without touching the code, and the projected overage is zero.

Separately, and regardless of plan, **the 282-board fan-out in a single request
is architecturally fragile.** Even on the paid plan one click holds an invocation
open for tens of seconds across ~700 outbound requests, and any one of them
timing out degrades the result. The sound shape is the one INT-06 already built:
let the scheduled refresh collect into the shared catalogue a slice at a time,
and let the user's click read the catalogue rather than trigger the fan-out.
That is a real piece of work, it needs a scope decision per `AGENTS.md`, and it
is **not** a prerequisite for going live — but it is what makes the app fast and
cheap rather than merely affordable.

## 7. What is modelled rather than measured

Stated plainly so the numbers are not trusted further than they deserve:

- **Catalogue size `N` is assumed, not read.** The row-read table is a model at
  2,000 / 5,000 / 20,000 jobs. The exact figure is in the Cloudflare dashboard's
  D1 metrics (`wrangler d1 insights` from the CLI) and would replace the whole table.
- **Static assets are assumed free.** `node_modules` is not installed in the
  session this was written in, so whether vinext emits an `assets` binding was not
  confirmed. If assets route through the Worker, add roughly 10 requests per page
  load — about 600/month for one user, still negligible.
- **CPU per invocation is reasoned, not profiled.** "Seconds, not milliseconds"
  follows from parsing 282 payloads plus language analysis. It is far enough past
  10 ms that the conclusion holds, but the monthly CPU projection in §4 is the
  softest number here. Real figures are in the Workers dashboard after a few days.
- **Subrequest counts are upper bounds from the caps.** A real run stops early on
  `MAX_NEW_PER_RUN` = 800 and on per-source refusals, so the typical click sits
  below 700. It is nowhere near 50 either way.
