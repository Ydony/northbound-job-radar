# Moving off Cloudflare to a VPS — what ports, what does not, and what to rent

Companion to `docs/HOSTING_COST_ANALYSIS.md`. Written 2026-09-27 against
`claude/pensive-feynman-skj5vd`, from the code rather than from memory.

## 0. One correction to the premise, then the plan

The brief for this document was "more than 100 users, therefore Workers does not
scale". The cost model does not support that, and the number matters before
committing to a migration:

| Users | Requests/mo | D1 rows read/mo | Cloudflare bill |
|---:|---:|---:|---|
| 1 | ~1,300 | ~42M | **$5** |
| 100 | ~130,000 | ~4.2B | **$5** |
| 1,000 | ~1.3M | ~42B | **~$25** |

Workers scales *further* than one VPS, not less far, and it does it without
anyone being paged. A single box has a ceiling that autoscaling edge compute
does not.

More important: the thing that would eventually make Cloudflare expensive is
`/api/state` making 13–16 full passes over the holding set on every load. That
is read amplification in this app, not a platform tax. **A VPS does not fix it —
it moves it from Cloudflare's meter onto your own CPU, where it becomes your
latency problem instead of your bill.** At 1,000 users and a 20,000-ad
catalogue that is roughly 65,000 row-scans per second sustained, which a single
box can do but will feel.

So: fix the aggregates regardless of where this runs.

**There are still good reasons to move, they are just different ones:**

1. **Fixed, predictable cost.** €7/month is €7/month whatever happens.
2. **No per-invocation ceilings.** The 50-subrequest and 10 ms CPU walls that
   currently break the free plan simply do not exist on a VPS. The app's shape —
   one click fanning out to ~700 outbound requests over tens of seconds — fights
   the Workers execution model even on the paid plan.
3. **Long-running background collection becomes natural** instead of something
   that has to be sliced to fit an invocation.

Those are sound reasons. "It does not scale" is not one of them.

## 1. Converters: what exists, what does not

**There is no off-the-shelf Workers-to-Node converter.** Migration off Workers is
documented everywhere as a manual port. But this codebase needs far less than a
port, for three reasons found by inspection:

### vinext already builds for self-hosting — one line

vinext is Cloudflare's own Vite plugin reimplementing the Next.js API surface,
and it is explicitly "deploy anywhere": Node.js is a supported target. Setting
`output: 'standalone'` in `next.config.ts` makes `vinext build` emit a
self-hosting bundle at `dist/standalone/`.

`next.config.ts` currently sets only `headers()`. **The framework layer ports
with a one-line config change.** No rewrite, no framework swap.

### D1 *is* SQLite — there is nothing to convert

The database does not need porting, only exporting: `wrangler d1 export` emits a
plain `.sql` dump that the `sqlite3` CLI imports directly. Schema, data and the
`schema_migrations` bookkeeping all survive, so `ensureSchema()` keeps working
against the imported file exactly as it does today.

### The Cloudflare coupling is one file and six methods

Measured across `app/`, `lib/`, `db/` and `worker/`:

| | Count |
|---|---:|
| Files importing `cloudflare:workers` | **1** (`db/runtime.ts`) |
| `db.prepare(...)` call sites | ~197 |
| `db.batch(...)` call sites | 17 |
| `D1Database` type references | 84 |
| `exec()`, `dump()`, Sessions API | **0** |

The D1 surface this app actually uses is `prepare`, `bind`, `first`, `all`,
`run`, `batch`, and `.meta.changes`. That is it.

**So do not rewrite 197 call sites — implement the `D1Database` interface over
SQLite.** A ~150-line adapter backed by `better-sqlite3` satisfies every one of
them, and every existing query, test and migration keeps working untouched.
Miniflare (Cloudflare's own local emulator, open source) already implements D1
over better-sqlite3 and is the reference to copy from.

This is the single decision that turns "days of rewriting" into "an afternoon
plus testing".

## 2. What genuinely does not port

| Cloudflare feature | Replacement | Effort |
|---|---|---|
| `AUTH_RATE_LIMIT` native binding | Delete it. `durableRateLimit` in `lib/rate-limit.ts` already holds the exact 15-minute windows and is documented as the accounting layer; the native binding is only a burst brake. Add nginx `limit_req` in front if you want the brake back. | Low |
| Cron Triggers (`0 */6 * * *`) | systemd timer or crontab calling a small CLI entry point | Low |
| `worker/entry.ts` `scheduled` export | A `scripts/run-refresh.mjs` that calls `handlePublicRefreshCron` directly — the handler itself is already runtime-agnostic | Low |
| Secrets via `wrangler secret put` | systemd `EnvironmentFile=` with a root-owned `0600` env file | Low |
| `env` from `cloudflare:workers` | `process.env` inside `db/runtime.ts`'s `bindings()` | Low |
| TLS, CDN, DDoS, static assets | nginx + certbot — **or keep Cloudflare's free plan proxying DNS to the VPS** and keep all four for nothing | Low |
| Automatic patching, failover, backups | Yours now: unattended-upgrades, Litestream, a monitor | **Ongoing** |

That last row is the real cost of this migration, and it does not appear on any
invoice.

## 3. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 22 LTS** | Already required — `engines.node >= 22.13.0`. No version jump. |
| Framework | **Keep vinext**, `output: 'standalone'` | Supported self-host target. Swapping to stock Next.js would be a real rewrite for no gain. |
| Database | **SQLite (better-sqlite3), WAL mode** | See below — this is the load-bearing choice. |
| DB access | **A `D1Database` adapter**, not a query rewrite | Keeps ~197 call sites and the whole test suite unchanged. |
| Process mgmt | systemd, **two units**: web and collector | A heavy scrape can never take down serving. |
| Reverse proxy | nginx + certbot | Standard, and gives back `limit_req`. |
| Edge | **Cloudflare free plan in front of the VPS** | Keeps CDN, DDoS protection and TLS at no cost; only compute moves. |
| Backups | **Litestream** → object storage | Continuous SQLite replication. The local emulator was never a backup and neither is a VPS disk. |

### Use SQLite, not Postgres

This is the recommendation most likely to be argued with, so the reasoning
explicitly:

D1 is SQLite. Staying on SQLite makes this migration an **adapter**. Moving to
Postgres makes it a **SQL dialect rewrite across ~197 queries**, plus new
failure modes, plus a second daemon to run and back up — for a workload that is
one writer and a few hundred readers, which SQLite in WAL mode handles without
noticing.

Postgres becomes right when you need more than one application node. You do not,
and a single VPS cannot use one anyway. Revisit it then; adopting it now buys
nothing and costs the whole migration budget.

## 4. VPS specs

Sized from what the code actually does: a collection run holds 282 board
payloads at `BOARD_CONCURRENCY` 6 plus hundreds of parsed adverts, and
`/api/state` runs 13–16 scans over the holding set per load.

| | Start (≤100 users) | Growth (~1,000 users) |
|---|---|---|
| vCPU | **4** (shared is fine) | **8**, dedicated |
| RAM | **8 GB** | **16–32 GB** |
| Disk | **80 GB NVMe** | **160 GB NVMe** |
| Example | Hetzner CX32 ~**€6.80/mo**, OVH VPS ~$6.50/mo | Hetzner CCX/CPX class, ~**€25–50/mo** |

Reasoning, so these can be argued with:

- **8 GB, not 4.** Node heap during a collection run is the peak — roughly
  0.3–0.6 GB — and you want the entire SQLite database resident in page cache on
  top of it, because those 14 scans per page load are exactly what page cache is
  for. 4 GB works until the catalogue grows, then thrashes.
- **NVMe, not SATA.** The aggregate scans are I/O bound. This matters more than
  clock speed.
- **4 vCPU** so the collector and the web server are not fighting. With the
  two-unit split above you can `CPUWeight` the collector down.
- **Shared vCPU is fine to start.** The load is bursty — a scrape every few
  hours — which is precisely what burst credits are for. Move to dedicated only
  if the aggregate scans, not the collection, become the bottleneck.
- Hetzner is roughly half OVH's price for equivalent specs; OVH includes
  unlimited traffic and daily backups. Verify current prices — both raised them
  during 2026.

## 5. Old setup vs new setup

| | Now (Cloudflare) | After (VPS) |
|---|---|---|
| Compute | Workers, autoscaled, global | One Node 22 process, one region |
| Entry | `worker/entry.ts` `fetch` | vinext standalone server behind nginx |
| Database | D1 binding `DB` | SQLite file + `D1Database` adapter |
| DB access code | ~197 `prepare()` sites | **unchanged** |
| Schema/migrations | `ensureSchema()` on D1 | **unchanged**, same SQLite |
| Scheduled refresh | Cron Trigger `0 */6 * * *` → `scheduled` export | systemd timer → CLI calling the same handler |
| Rate limiting | native binding + D1 limiter | D1-adapter limiter (+ nginx `limit_req`) |
| Secrets | `wrangler secret put` | systemd `EnvironmentFile` |
| TLS / CDN / DDoS | Cloudflare, included | Cloudflare free plan proxying to the VPS |
| Static assets | Workers Static Assets | nginx |
| Deploy | `npm run deploy:prod` | build → rsync → `systemctl restart` |
| Backups | none (D1 is managed) | **Litestream — new responsibility** |
| Subrequests per request | 50 free / 10,000 paid | **unlimited** |
| CPU per request | 10 ms free / 5 min paid | **unlimited** |
| Cost | $5/mo (or $0, broken) | ~€7/mo + your time |
| Patching, uptime, backups | Cloudflare's | **yours** |

## 6. Order of work

1. `output: 'standalone'` in `next.config.ts`; confirm `dist/standalone/` builds.
2. Write the `D1Database` adapter over better-sqlite3; point `bindings()` in
   `db/runtime.ts` at it behind an env switch. **The 538-test suite is the proof
   this is right** — it must stay green against the adapter.
3. `wrangler d1 export` production; import into SQLite; run `ensureSchema()` and
   confirm `schema_migrations` reports the same version.
4. Replace the `scheduled` export with a CLI entry; systemd timer at the same
   6-hour cadence.
5. Drop `AUTH_RATE_LIMIT`; confirm `durableRateLimit` still holds the documented
   windows (there are tests).
6. nginx + certbot + Cloudflare DNS proxy; systemd units for web and collector.
7. Litestream, and **restore from a backup once before cutover** — an untested
   backup is not a backup.
8. Cut DNS over. Keep the Worker deployed and idle for a week as a rollback.

## 7. Honest summary

The migration is smaller than it first looks — an adapter and a config flag, not
a rewrite — because vinext self-hosts and D1 is SQLite. Call it a few days
including testing.

But it is not free, and it is not the fix for the scaling worry that prompted
it. If the goal is predictable cost and freedom from per-invocation ceilings,
this plan delivers both. If the goal is "handle many more users", then fixing
`/api/state`'s 13–16 passes over the holding set will do more than any change of
host, on either platform, and it is the cheaper piece of work.
