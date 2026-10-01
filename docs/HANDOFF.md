# Handover

## 2026-10-01 T05: synthetic administrator identity-only transfer

The T05 branch adds `scripts/admin-identity-transfer.mjs`, a deliberately
non-CLI helper that copies only a verified administrator `users` row into an
empty, same-schema SQLite database. It bumps `session_epoch`, resets
`last_seen_at`, and refuses any other destination data except migration 19's
untouched `indeed_control` seed. `npm run verify:admin-transfer` rehearses the
flow on throwaway synthetic databases; `tests/admin-transfer.test.ts` covers
field-level exclusion and refusal. See `docs/ADMIN_IDENTITY_TRANSFER.md` for
the allowlist. No real account, credential, secret or host was touched.
The actual transfer, independent-secret check, sign-in and rollback remain
unverified owner checkpoints under F2/T07; this task does not close them.

## 2026-09-30 T01: self-hosted setup verified, deploy templates reconcile, stale local-runtime docs fixed

T01 (F1 child) re-ran the existing harnesses on the pinned master instead of
rebuilding them — everything they cover already existed. `npm run lint`,
`npm run typecheck`, `npm test` (555/555), `npm run build`
(`dist/standalone/server.js`), and `npm run verify:selfhosted` (PASS: empty
SQLite boots the administrator, criteria persist, provider-less search
completes honestly, schema version 31 with 31 migrations, `integrity_check`
ok, no server errors) all pass. The four named suites — `sqlite-adapter`,
`public-refresh`, `keyword-pagination`, `collection-totals` — pass (41/41).
No behavior changed, so no new tests were added.

`deploy/` needed no changes — each template already matches the code: the web
unit's `ExecStart` is the bundle `npm run build` emits; both units share one
`EnvironmentFile` and therefore one `SQLITE_PATH`; web is
`Restart=on-failure` with the higher `CPUWeight`, refresh is `Type=oneshot`
behind the 5-minute lease, the timer repeats the prod `0 */6 * * *` cadence,
and nginx sets `X-Forwarded-Proto`/`Host` on every block, which is what
`isSecureRequest` needs for `Secure` cookies. Changed files are docs-only:
`docs/ENVIRONMENTS.md`, `docs/GETTING_STARTED.md`, `README.md`,
`docs/FUNCTIONALITY_MAP.md` and `docs/DEPLOY.md` still described the old
Miniflare/`.wrangler` dev/test runtime; they now describe the Node + SQLite
stack under `.local/`.

Explicitly unverified here, still required before any hosting acceptance:
systemd restart behavior, the nginx proxy against a live server (including
whether `isSameOrigin` sees the public scheme behind it and whether the
default proxy timeouts survive a full-length admin search), Windows DEV/TEST,
and production. Follow-ups split out, not done: `scripts/backup-local.mjs`
and `scripts/verify-local-backup.mjs` still back up `.wrangler/<env>/state`,
which no longer exists on the new stack (backup/restore belongs to the #200
track, not T01).

## 2026-09-27 the VPS work, and dev/test moved onto the new stack

**This supersedes the hosting entry below it, which says "nothing is implemented and no scope
decision has been made". Both halves of that are now out of date**: the owner decided to proceed,
and VPS-01 through VPS-05 and VPS-07 are merged.

Master is `2e0397b`. Gate green: 555 tests, lint, typecheck, build.

### Dev and test are the new stack

Owner decision: `npm run dev` (:3000) and `npm run test:local` (:3001) serve the standalone Node
bundle on SQLite. Each keeps its own empty database and session secret under `.local/`. The old
`.wrangler` D1 state was deleted - 84MB, and **the owner's instruction is that local data does not
matter**: "data is only important in Prod, not dev or test", and starting empty is better because
search has to run to fill it.

The workerd pair is archived as `dev:cloudflare` / `test:cloudflare`. Not deleted: production runs
it until cutover (#201), and it is the only one with hot reload, because HMR runs the app inside
workerd where `node:sqlite` does not exist. On the new stack a change means rerunning the command.

**Each environment serves its own copy of the build, from `.local/<env>-server/`.** This is not
tidiness. Sharing `dist/standalone` looked fine and was not: chunk names are content-hashed, so
building for dev deleted the chunk test was lazily importing, and test began answering 500 on
`/api/state` (`Cannot find module ... app-route-handler-dispatch-<hash>.js`) while still serving
pages, because those were already loaded. Found only by starting both at once.

Configuration for both comes from the same `.dev.vars.<env>` files. The standalone bundle reads
plain `process.env` - `.dev.vars.*` is a wrangler feature - so `scripts/run-local.mjs` parses the
file itself. Without that the new stack would run unconfigured while the old one was configured,
and comparing them would compare two installations rather than two runtimes.

### The bug that justified the harness

`npm run verify:selfhosted` boots the real standalone bundle on a throwaway empty database and
drives it over HTTP. **It failed on its first run and the failure was real.** `returnsRows()` in
`db/sqlite-adapter.ts` looked only at the leading keyword, so `durableRateLimit`'s atomic
`INSERT ... ON CONFLICT ... RETURNING count, reset_at` was routed to `run()`, which yields no
rows. That limiter fails closed, so **every registration and sign-in on the self-hosted target
answered 503** "The sign-in service is temporarily unavailable." The app was unusable while all
547 unit tests passed, because they run against D1, where one statement both writes and reads.

A RETURNING write now reads its rows back and reports one change per returned row, matched as a
word so a value containing the letters cannot turn a write into a read. Pinned by a test.

The lesson worth keeping: `verify:sqlite-import` compares databases, and the database was never
the part at risk. Anything that only the runtime swap touches needs a harness that runs the
runtime.

### What merged

| Commit | |
|---|---|
| `61af2f3` | #141 the load flash. Gate is `state.account`, not `loading` - `finally` clears loading before the redirect navigates. First test of `app/job-radar.tsx`, plus a `check:visual` MutationObserver that catches a dashboard painted and then torn down |
| `b298c62` | #197 `scripts/run-refresh.mjs` + systemd timer; #198 nginx `limit_req` on the auth routes. **The `AUTH_RATE_LIMIT` binding is NOT retired** - removing it now would leave production on the database limiter alone. That belongs to #205 |
| `5ddd6e0` | #196/#200 `verify:sqlite-import`, `verify:sqlite-restore`, `tests/sqlite-adapter.test.ts`. Both rehearse the owner-run procedure on synthetic rows; a file copy stands in for `litestream restore` |
| `fe0a47d` | `verify:selfhosted` and the RETURNING fix above |
| `786401f` | #190 run progress and completion moved beside Search statistics |
| `c5a8694` | #168 the public collector provably cannot reach an admin-only source |
| `f93cf1a`, `2e0397b` | the stack switch, and `verify:dev` made to work on an empty database |

#196 was re-scoped by owner decision: no production export. It proves the stack from empty; the
real export moves to cutover (#201), where it happens once.

### Two traps found the hard way

**`git worktree remove` destroyed `node_modules/.bin` in the primary checkout** during the sweep
of 75 stale worktrees - the junction hazard `pm.py` warns about, which is why worker worktrees are
installed rather than linked. Symptom: `'vinext' is not recognized`. Repair is `npm install`.

**`verify:dev` failed on its own first step** against an empty database - "A later account must be
a non-admin user" - because on an empty database the first registration is the administrator. It
now claims that slot deliberately.

### Worker dispatch, and what Spark actually did

Three dispatches died silently on 27 September: 2 steps, 9 steps, exit 0, no output. OpenCode 1.18
asks permission to read outside `--dir`, the worker's stdin is closed so it is auto-rejected, and
the run ends there. `AGENTS.md` told every agent to read `C:/Projects/AI team and PM Tools/
AGENTS.md`; they obeyed and died. `pm.py` now copies the rules into each worktree as
`WORKER-RULES.md` and `WORKER-DEV.md` beside `ASSIGNMENT.md`, and the packet says to read nothing
outside the worktree. After that: 27, 48 and 30 steps, all producing work.

**Worker worktrees are now per project**, at `C:/Projects/Auto Job hunt-worktrees/` (owner
decision). The shared folder under `AI team and PM Tools` is deleted.

Spark wrote #197, #198, #196, #200 and #190. It has never once committed its own work - every run
so far has left it uncommitted in the worktree, and one run (#141) sat unnoticed for a day that
way. Check the worktree before resolving a run as empty.

### Still open

- **#204, the owner's:** rent the VPS and an object-storage bucket. #199, #201 and #205 cannot
  start without it, and neither can the real Litestream replication.
- **#1 / #203:** rotate `SESSION_SECRET` and every secret touched. Never rotate while the
  administrator is unverified - sign-in refuses unverified accounts, and only
  `bootstrap:prod-admin` restores the flag.
- **#173:** open public registration. Owner's go-live flag.
- **#192:** stays open on purpose. 282 ATS boards against a 50-subrequest ceiling is not fixable
  on Workers; the VPS is the fix.
- `/api/state` read amplification (13-16 passes per load) survives the move and is the real
  scaling driver.
- `pm.py digest` crashes on a card with a null `issue` field.

## 2026-09-27 hosting: what a search actually costs, and the VPS direction (#193)

**Nothing is implemented and no scope decision has been made.** This section exists
so the next agent does not re-derive the measurements or start VPS-01 thinking the
decision is settled.

Two analysis documents were added, `docs/HOSTING_COST_ANALYSIS.md` (9fad4de) and
`docs/VPS_MIGRATION_PLAN.md` (29f1d62), plus nine issues: **#193** tracking, with
**#194–#201** as VPS-01…VPS-08. Owner is Spark; it is carried in each issue body
because `spark` is not a GitHub account and the API rejects it as an assignee.
The board's `Owner` field was not set — no Projects v2 access from a cloud
session, and `pm.py` lives on the owner's Windows machine. It still needs setting
by hand.

### Why the free plan cannot run a search, in one paragraph

Not volume — per-invocation ceilings. One `/api/scrape` click issues roughly 700
outbound requests: 282 employer boards (`atsCompanies`, shared by `ats-ch` and
`ats-nl` through `detailedInFlight`), up to 200 Job-Room detail fetches, plus
EURES, FreeHire and the admin page-fetch sources. Workers Free allows **50
external subrequests and 10 ms CPU per invocation**; Paid allows 10,000 and five
minutes. A free-tier search therefore dies around the fiftieth board, and parsing
282 payloads was never going to fit in 10 ms. This is the same wall as **#192**,
which is open and hitting production now.

Moving collection onto the existing INT-06 cron does **not** rescue the free plan:
scheduled invocations carry the same two ceilings, so a full sweep would need ~47
ticks — over a month at `0 */6 * * *`.

### Numbers worth not re-deriving

- One user, two sessions a day: **~1,260 Worker requests a month**. Volume is a
  non-issue and always was.
- `GET /api/state` makes **13–16 full passes** over the holding set per load — ten
  aggregates in `queryCatalogueAggregates`, plus places, freshness, collection
  totals, the page and copies queries, and the three maintenance passes. At a
  5,000-job catalogue that is ~70,000 rows read per load.
- **D1 free limits are now enforced with errors**, not degradation, since
  1 September 2026. Exceeding the daily read limit breaks the app until midnight UTC.
- Cloudflare Paid costs **$5/month at 100 users** and about **$25 at 1,000**.

### The premise correction, recorded deliberately

The migration was requested on the grounds that Cloudflare "does not scale past
100 users". It does; the measurements above are in the plan. A single VPS scales
*less* far than autoscaled edge compute, not further. More importantly, the thing
that would eventually make Cloudflare expensive is `/api/state`'s read
amplification, which a VPS **relocates onto our own CPU rather than fixing** —
at 1,000 users and a 20,000-advert catalogue, roughly 65,000 row-scans a second.

The reasons to migrate that **do** hold: fixed predictable cost, and the absence
of the per-invocation ceilings that this app's fan-out fights even on the paid
plan. If the scope decision is "fix the aggregates first", #194–#201 stay in
Backlog and #192 is the work.

### Why the port is an adapter, not a rewrite

Three findings, all from the code:

- **vinext self-hosts.** `output: 'standalone'` in `next.config.ts` makes
  `vinext build` emit `dist/standalone/`. The framework layer moves in one line.
- **D1 *is* SQLite.** `wrangler d1 export` produces a dump the `sqlite3` CLI
  imports. Nothing to convert.
- **The Cloudflare coupling is one file.** Only `db/runtime.ts` imports
  `cloudflare:workers`, and the D1 surface actually used is six methods —
  `prepare`, `bind`, `first`, `all`, `run`, `batch`, `.meta.changes`. No `exec()`,
  no `dump()`, no Sessions API anywhere.

So **do not rewrite the ~197 `prepare()` call sites.** A ~150-line `D1Database`
adapter over better-sqlite3 keeps every one of them, and the 538-test suite, as
they are. That is #195, and it is the load-bearing task. Miniflare already
implements D1 over better-sqlite3 and is the reference.

**SQLite, not Postgres** — deliberate. SQLite keeps this an adapter; Postgres makes
it a dialect rewrite across those ~197 queries plus a second daemon to run and
back up, for a one-writer workload.

### Owner's stated direction: VPS first, then hardware at home

Develop on an OVH VPS-2 (4 vCore / 8 GB / 75 GB NVMe, €8.72/month incl. VAT —
matches the recommended tier), then move to a mini PC at home. The migration work
is identical for both targets: once off Workers, a VPS and a box in a hallway are
the same Node 22 + SQLite + systemd + nginx deployment.

One architectural consequence, and it should be settled before #199 is built:
**use `cloudflared` (Cloudflare Tunnel) rather than pointing DNS at the origin
IP.** It is free, needs no port forwarding or static IP, works behind CGNAT,
does not expose a home IP, and turns the eventual move home into starting the
connector on the new machine and stopping it on the old one. Going direct-to-IP
on the VPS means re-solving all of it later under time pressure.

Home hosting also makes **#200 more important, not less**: there is no OVH
snapshot behind it, and consumer NVMe fails without warning. Litestream to R2 or
B2 stays inside a free tier. Full-disk encryption applies — the box holds EU
users' personal data and the owner is its controller wherever it sits.

The money, honestly: hardware and UPS around €320 against ~€5.70 saved a month,
so **breakeven is four to five years**. Home hosting is worth doing for control
or for reusing the hardware; it is not a saving at this scale.

### Not done

- No scope decision. #193 carries the gate.
- Board `Owner` field not set on any of #193–#201.
- Nothing measured live: catalogue size, CPU per invocation, and whether vinext
  emits an `assets` binding are all modelled, not read. §7 of
  `HOSTING_COST_ANALYSIS.md` lists exactly which numbers those are. Real figures
  are in the Cloudflare dashboard.
- **#192 and #193 overlap and neither absorbs the other yet.** Decide whether the
  subrequest wall is fixed on Cloudflare or by the migration.

## 2026-09-27 first full production release, and the email path

**Production is live and current at `ikbeneenappel.nl`, version `9604afe9`**, deployed
from `c6967ea` with the gate green (538/538, lint, typecheck, build). Before this it had
been running code from 24 September, so this release carries the whole INT batch, the
INT-02 isolation merge, job deletion removal, both catalogue fixes and the email work.

Verified unauthenticated against the live site after deploying: `/api/admin/email` 401,
`/api/turnstile` 200, `/auth/reset` 200, `/auth/verify` 200, `DELETE /api/jobs` and
`/api/jobs/:id` both 405, `/api/profile` 404, `/api/state` 401.

**If a deploy appears to succeed but production keeps serving old code, look for a local
dev/test server holding `dist`.** `npm run deploy:prod` builds first, the build fails
EPERM on Windows while `workerd` holds the folder, and the deploy never happens. That is
what caused the first attempt on 27 September to silently do nothing.

### Email delivery now works end to end

Resend, sending as `Ik ben een appel <noreply@mail.ikbeneenappel.nl>` from the Ireland
region. `RESEND_API_KEY` and `RESEND_FROM` are production Worker secrets, owner-set.
`GET /api/admin/email` reports `configured: true`, `apiKeyPresent: true`, `missing: []`,
and a live send recorded `sent: 1, failed: 0`.

The sending domain is the **subdomain** `mail.ikbeneenappel.nl`, deliberately: the root
keeps its own reputation, and when OVH mailboxes are eventually pointed at the root the
two stay independent. Click and open tracking are **off** - they would contradict the
project's own no-tracking rule and would rewrite password-reset links through a third
party. Dev and test stay unconfigured on purpose: the harnesses register `@example.test`
addresses, which would become hard bounces against a new domain. Locally the token comes
back in the JSON response instead. See `docs/EMAIL_SETUP.md`.

`GET`/`POST /api/admin/email` (administrator only) is the diagnostic: GET reports
configuration without ever returning the key, POST sends one real message and returns
Resend's own refusal text. Every sending path now records `email-sent` / `email-failed`
as an `auth_events` kind - never the reason, because a refusal can quote the address and
that table is not scoped to one account.

### Two defects found and fixed, both from the catalogue work

**#188, an audience leak.** One advertisement carried by a public source and by an
administrator-only one shares a single `vacancies` row by identity fingerprint - correct
deduplication - and the serving path then read `canonical_url` from it. An ordinary
account holding the public copy was served `https://nl.indeed.com/viewjob?jk=...` while
every field keyed on `source_key` correctly said `example.com`. The gate held on the
record and leaked through its content. Fixed in `ee7bd05` by taking the column from the
account's own `jobs` row.

It reached master because `tests/catalogue-query.test.ts` builds its `jobs` table by hand
and that table had no `canonical_url` column, so the suite could not express the bug -
despite containing a test named for exactly this rule. The column is in the fixture now.

**#189, a decision lost on fold.** Following the owner's rule that an advert carried by
Indeed and another source shows as the other source to everyone (`7347e7c`), the card can
be a different row from the one the reader acted on. Marking the Indeed copy saved and
applied then left a card reading not-saved, not-applied. `688336e` carries the strongest
engagement across folded copies, applied over saved over neither, one-way so a duplicate
can never take a decision away. Applied in all three places that can make a row primary:
`upsertJob`, `reclusterJobs`, and the PATCH route.

Dismissal needs none of this - `dismissed_jobs` matches on identity fingerprint, which
both copies share. Language corrections are deliberately not merged: a correction is a
verdict about one copy's text.

### All five local harnesses run again

They had been dead since INT-14 and none is in the merge gate, which is why nobody
noticed - and why #188 shipped. INT-14b demanded a Turnstile token no headless caller
sends; local registration now has no bot check rather than verifying against an
always-pass test secret that accepts any token anyway. INT-14a then left new accounts
unverified, so every following call answered 401; all five now confirm the loopback
token.

Green on 27 September: `verify:dev` 10/10, `verify:admin` 9/9, `check:visual` with its
canary correctly red, and `verify-indeed-workflow` and `verify-cluster-workflow` on fresh
disposable databases.

Running the last two needs a disposable server: `wrangler dev --config
dist/server/wrangler.json --port 3110 --persist-to <throwaway> --env-file
<absolute path>`. **The env-file path must be absolute** - a relative one resolves against
the config's directory and silently loads nothing, which presents as "SESSION_SECRET is
not set". `verify-indeed-workflow` also refuses to run unless Indeed is disabled, and
needs a genuinely fresh database because its bootstrap email is fixed.

Note for anyone running them twice: the durable limiter buckets all loopback traffic
under `auth:ip:local`, five registrations per fifteen minutes machine-wide.

### Board

All fourteen merged pull requests (#174-#187) moved from **In Test** to **Done** after
confirming each was genuinely merged. The board is 173 Done, 13 Backlog, 1 In Progress,
nothing In Test. The eleven merged INT issues were closed with their individual caveats
recorded rather than a blanket "done" - #166 FreeHire redistribution confirmation is
still unasked, #167 Job-Room rests on code shapes because the live probe hit a WAF block,
#160 is not fully consolidated because `lib/source-policies.ts` still drives `/sources`
from its own flag.

### Outstanding, with the commands

1. **#1, rotate `SESSION_SECRET`.** The production administrator password was reset on
   27 September. The email is already `anddonatas@gmail.com` and verified, so no email
   change is needed and there is no lockout risk. What remains:
   `$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | npx wrangler secret put SESSION_SECRET --name ikbeneenappel-prod`
   It signs everyone out. **Never rotate it while the administrator is unverified**: sign-in
   refuses unverified accounts outright, `reset:prod-admin-password` does not restore the
   verified flag, and only `bootstrap:prod-admin` does.
2. **Local administrator credentials** are still the ones exposed in transcripts
   (`admin-test@ikengels.test`). Local-only, so not urgent, but #1 asks for them too.
3. **#141** cannot be closed from the code. Nothing tests `app/job-radar.tsx`; it needs a
   signed-in look at the first second after a load - no red "Enter at least one role", no
   empty role fields, no "No search run yet" on an account that has run searches.
4. **#168 (INT-12)** has no code and is unblocked now that #182 is merged.
5. **#173** is the owner's go-live flag.
6. Optional: `lib/email.ts` sets no `Reply-To`, so a reply to a verification message goes
   nowhere. One line, once an address is chosen.

## 2026-09-24 public-launch backlog implementation (INT-01–INT-14, #35)

Twelve PRs merged to master (#174–#181, #183–#186), one per issue, all green on the
merged tree: lint, typecheck, **527/527 tests**, build (verified on a clean worktree
at `fc12c8d`). Dev/test + synthetic fixtures only; prod Worker/D1, secrets and #173
untouched throughout. Seven parallel worktrees under `worker-worktrees/`; two merge
conflicts resolved by the owning workers (duplicate migration v29 → catalogue split is
v30; email vs Turnstile auth-route overlap).

Landed: #160 source-policy registry (`lib/source-policy.ts`, drift tests); #162 budgets
+ stop-on-block (200/source, 4/page-fetch, 800/run); #163 catalogue/user-state split
(migration v30, lossless on disposable copies); #166 FreeHire adapter (recorded
fixtures, 7-upstream allowlist); #167 Job-Room public validation (fixture-based —
live probe from the worker network hit a WAF block and stopped, so volume rests on
code shapes; re-check live from the deployment network); #169 attribution + quality
(0 false passes, 100% pass precision on fixtures); #170 email verify/reset (mocked
Resend, migration v29); #171 Turnstile + atomic fail-closed limiter; #172 deletion
completeness (schema-derived table list); #164 server-side catalogue
pagination/facets; #165 cron refresh scaffolding (v31 locks/cursors/durable 429
cooldown, coalesced queue, fail-closed empty terms).

PR #182 (INT-02 isolation) **merged 2026-09-24 as d418af1**, after a close review that
verified each of its four claims against master rather than accepting the PR's own
account: `jobs/[id]` guarded Indeed alone, `DELETE /api/jobs` likewise, an admin-only
URL imported invisibly, and `scanned`/`alreadyKnown` summed unfiltered `sourceReports`
eight lines after `visibleSources` filtered the same array. The owner's review gates
promotion to production, not the path into master and test. Two things worth keeping:
GitHub reported it MERGEABLE/CLEAN and it was not — `app/api/state/route.ts` conflicted
because master had grown the same audience rule inline during the catalogue work, so the
resolution takes the shared `visibleSearchRuns` and drops master's copy — and its recorded
evidence (421/421) was 23 commits stale. Re-verified on current master: 536/536.
**#168 is unblocked.** #173 (go-live flag) is owner-only.

Then (bec4589): job deletion removed entirely at the owner's call — a delete wrote no
tombstone, so the advertisement returned on the next search. `DELETE /api/jobs` and
`DELETE /api/jobs/:id` now answer 405 unauthenticated; dismissal is the only way to put a
job away, and `verify:dev` proves the tombstone survives re-import.

**The five local harnesses were broken by the INT-14 work and are now fixed.** None of
them is in the merge gate, so it happened silently. INT-14b demanded a Turnstile token no
headless caller sends — local registration now has no bot check at all, rather than
verifying against an always-pass test secret that accepts any token anyway. INT-14a then
left new accounts unverified, so every following call answered 401; only verify:dev
handled it. check-visual was the worst case: it seeded nothing and measured a page with
zero job cards, the exact failure its canary exists to catch. Also fixed: verify:dev's
cross-account assertion read /api/state's default 40-job page and reported a cross-account
deletion that had not happened — INT-05's paging, not a leak; reproduced by hand before
changing anything. Note for whoever runs these: the durable limiter buckets all local
traffic under `auth:ip:local`, 5 registrations per 15 minutes machine-wide, so the
harnesses cannot be run back to back.

Owner decisions still needed: `PUBLIC_REFRESH_TERMS` before any prod refresh, 6h cron cadence + ATS
282-board/tick cost, FreeHire redistribution confirmation, detail-404=transient
semantic, `auth_events` old-email rows (30-day purge, not deleted with account).
Refresh writes no catalogue rows yet — the `onBatch` seam is #164's side to complete.
This entry's companion change marks the export row Accepted-gap per the 2026-09-24
no-export decision (was stashed, never committed).

## 2026-09-24 search-engine exclusion

Owner requested no indexing while the site is private. Deployed and verified
`X-Robots-Tag: noindex, nofollow, nosnippet, noimageindex` on the Worker root,
login, privacy, sources, unauthenticated API (401), robots.txt and favicon.
HTML pages additionally render robots metadata. The robots file allows fetching
so compliant search engines can see noindex; this does not give access to account
data. Static asset cache headers remain intact. After the owner removed the
conflicting apex A record, deployment successfully attached `ikbeneenappel.nl`
to the production Worker. The prod-only route is recorded in `vite.config.ts`.
Authoritative .nl registry checks still return ns111.ovh.net/dns111.ovh.net;
NS records inside the OVH zone previously gave a misleading Cloudflare answer.
Public HTTPS verification is still pending delegation/certificate readiness.
Keep #148 open until the actual custom-domain login page and headers verify.

## 2026-09-24 production sign-in repair

The private production Worker at `https://ikbeneenappel-prod.anddonatas.workers.dev`
has one active admin, `ALLOW_SIGNUPS=false`, and an independent D1. The first
production sign-in failed because `lib/auth.ts` generated 210,000-iteration
PBKDF2 hashes, but the hosted Workers runtime rejects PBKDF2 above 100,000
iterations with `NotSupportedError`. The error was caught and shown as an
incorrect password. This was reproduced against the live API and confirmed in
temporary Worker diagnostics, which were then removed. Newly generated hashes,
including the missing-account timing-equivalence hash, now use 100,000. A new
temporary password was set and **the live `/api/auth` returned HTTP 200, admin
role, and a session cookie**. Repeated diagnostic requests briefly exhausted the
15-minute email rate-limit window; let that window expire rather than weakening
the limiter. Do not write the temporary password in source, logs, or docs. The
owner still needs to sign in and change it in Settings. `ikbeneenappel.nl`
remains unconnected: public DNS currently reports NXDOMAIN despite DNS records
being visible in the Cloudflare zone.

## 2026-09-24 first private Worker deployment (incomplete setup)

`npm run deploy:prod` succeeded from an isolated worktree at
`https://ikbeneenappel-prod.anddonatas.workers.dev` (version
`7b7d2f6a-f30d-4c24-b058-ec7a7de4cbff`). `/login` returned 200;
`/api/state` returned 503 because `SESSION_SECRET` is not set. That request
did apply all 28 migrations to the independent remote D1. The remote `users`
table had zero rows. `wrangler secret list --name ikbeneenappel-prod` returned
an empty list. No administrator was created, no sign-in was tested, and no
provider search was run. The owner must enter `SESSION_SECRET` and
`ALLOW_SIGNUPS=false` locally as specified in `docs/DEPLOY.md`; never handle
their values in an assistant. GitHub now has the exact CI secret *names*, but
no CI deploy was approved; the earlier pending deploy runs were cancelled.
Security headers were present on `/login`. An unauthenticated `/api/state`
503 had no `Cache-Control` header, consistent with the existing readiness
warning. The `.nl` registry still returned NXDOMAIN at the last check.

## 2026-09-24 Indeed completion and private production preparation

Indeed epic #112 and blockers #69/#118/#126 were merged and closed. PR #151
activated the bounded 200-row per role/country ceiling; 800 rows and 32 requests
are whole-click maxima, not coverage targets or provider-approved quotas. TEST
was restarted from the merged build on port 3001; `/login` returned 200 and
signed-out `/api/state` returned 401. No owner-account live search was run.

At the start of private Cloudflare milestone 12, production D1 was separate
and empty; the first deploy had not happened yet. See the newer entry above for
the current state. `scripts/build-prod.mjs` verifies the generated Worker/D1 before
any deploy; `scripts/bootstrap-prod-admin.mjs` is a one-time, local-only D1
bootstrap that leaves hosted HTTP signup blocked. The deployment workflow is
owner-approval-gated. Do not call the site live until issue #149 is verified.
On the first 2026-09-24 check, GitHub's API showed the `Production` environment
has a required-reviewer rule (environment names are case-insensitive), but
neither Cloudflare CI secret name was present. A later names-only check found
both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` configured; their values
and permissions were not read or tested. The authoritative
`.nl` lookup still returned NXDOMAIN for `ikbeneenappel.nl`, so #148 remains
externally blocked. The bootstrap dry-run used a disposable local D1 and a
synthetic password; no production account or rows were created.
For first migration, request the deployed `/api/state` route (401 while signed
out): it calls `ensureSchema()` before authentication. `/login` alone does not.

## 2026-09-23 Indeed gate before private Cloudflare

Owner sequence: finish Indeed epic #112 and only its blockers (#69, #118, #126),
review/merge, then prepare private Cloudflare #143–#149. Optional VPN #73 and
unrelated backlog are not gates. #69/#118 are merged and closed. #126 is the
last Indeed implementation: its branch activates the 200-per-role/country,
800-whole-click safety ceiling. Do not call it a target or provider-safe quota.

Codex's bounded date/filter probe and isolated website/operator acceptance are
recorded in [INDEED_HANDOVER.md](INDEED_HANDOVER.md). The collector now requests
date order plus a seven-day provider lookback, retains the local posting-date
gate, reuses recent capped samples, and versions its query checkpoint. #126
still needs final regression and review before merge. Do not claim exhaustive
coverage, exact provider indexing time, or an authorized quota. TEST on port
3001 was restarted from the merged lower-budget build after a verified backup;
it retained all 4,413 existing jobs. It does not yet run the #126 branch.

## 2026-09-23 refactor and CV removal (current working tree)

The owner requested a functionality/code inventory, cleanup, security-gap review, and removal
of CV upload/matching. The current map is `docs/FUNCTIONALITY_MAP.md`; public blockers are
`docs/PUBLIC_DEPLOYMENT_READINESS.md`. CV UI, upload route, role derivation, match scoring,
R2 binding and related dependencies were removed. Migration 28 drops `cvs` and the fit/role
override columns, while migrations 1–27 remain immutable for older database upgrades.
Search now requires explicit role keywords, not a CV. Privacy, setup and agent instructions
must agree with that change. The owner explicitly authorized deleting TEST's two CV rows and
their stored files without a CV backup. The two live rows/files were deleted; the old legacy
state and all nine in-project TEST recovery snapshots were then scrubbed of CV rows and R2
objects without removing saved jobs. Every inspected state now has zero CV rows/objects;
an old and the newest backup both passed restore-manifest verification. Other copies outside
this project (for example personal files or another checkout) were not inventoried.

Security hardening in this tree compares the full origin (including scheme/port) for mutations
and refuses first-administrator registration from a non-loopback URL. Public hosting remains
blocked: no safe hosted admin bootstrap, verified registration/recovery, bounded shared
collection or final source-policy review exists. Do not deploy.

Validation: lint, typecheck, design checks, the unit suite, and build passed. TEST was restarted
from the new build; login returned 200, signed-out `/api/state` returned 401, the removed
`/api/profile` route returned 404, migration 28 applied, and all 4,413 job rows remained.
After a second restart, the CV table stayed absent (the legacy base-schema replay was fixed).
An authenticated end-to-end browser search was not run; no provider calls were made.

## 2026-09-22 Results clarity: totals and extracted requirements (#123/#124/#125, unmerged)

Owner-clarified counting plus grounded requirements, on branch
`ai/resultsclarity-20260922-150414-159617`. Shared results functionality, not Indeed-only.

Totals (#124): the Searched/Added/Still-open trio is replaced by New this search
(first-time unique jobs this run added), Matched this search (those new jobs
English-confirmed and meeting saved criteria at search time — a snapshot) and Total
collected (unique retained jobs across runs, saved/applied/dismissed included, deleted
gone). `matched_count` persists per source (migration 25, NULL = unknown, never a false
zero); `queryCollectionTotals` serves the server-retained overall plus per-source uniques
from the same audience predicates as the page, so ordinary roles never learn admin counts
and the numbers never depend on loaded pages. Overall deduplicates; per-source rows show
the first-keeping source and the card says why the sums can differ. Files:
`db/migrations.ts`, `lib/types.ts`, `lib/server-data.ts`, `app/api/scrape/route.ts`,
`app/api/state/route.ts`, `lib/dashboard.ts` (`runNewMatchedTotals`), `app/job-radar.tsx`,
`app/globals.css` (overall row), `tests/dashboard.test.ts`, `tests/collection-totals.test.ts`.

Requirements (#125): precision-first widening of `lib/requirements.ts` — paragraph sentences
under recognised headings, unfamiliar headings with requirement wording, legitimate single
requirements with explicit cues, and clearly stated cue-plus-signal sentences without any
heading (empty heading, labelled as extracted from the available text). Bare-bullet fallback
stays removed: Job-Room metadata, benefits, company blurbs and cue-less responsibilities
stay out (negative fixtures kept). Modality and negations are quoted verbatim; long
conditions to 300 chars are kept; flattened single-line ads stay null for the structure
backfill. Cards show the first three with an expandable rest, an "extracted — not a
complete guarantee" note and an original-ad link; unextractable full ads say they could
not be extracted rather than claiming no requirements. No `Also posted on` restoration,
no duplicate counts, no CV breakdown, no third-party model calls.

Verification: 371/371 tests, lint, typecheck, build and `check:design` green. No signed-in
browser exercise — owner dev/test servers held :3000/:3001 and verification must never
touch owner state; see Known risks in `docs/ARCHITECTURE.md` for the pre-merge browser
list. No overlap with Indeed UI task #116 beyond the shared dashboard files, which this
branch owns while it is open.

## 2026-09-22 Restored explicit language filters (#119)

Owner-reported regression from #46 (20 September): the default `matches` view and
six explicit views became New/All-matches/Pipeline/triage/dismissed, where All
meant effective pass but read as "All matches", review and unknown merged into
"Needs a look", New (the default) mixed pass/review/unknown, and active blocked
ads lost their browsing path. Saved verdicts were never removed.

Restored as an orthogonal selector, keeping the reviewed UX-6 layout: lifecycle
tabs New / All / Pipeline plus quiet Dismissed answer "how recent / what did I
do"; a separate Language group (English confirmed / Needs review / Not enough
of the ad / Local language required / All language results) answers "what did
the screen say". Mapping: old `matches` = All + English confirmed (the fresh
default again); old `review`/`unknown` = All or New + the matching singleton;
old `all` (every verdict) = All or New + All language results; blocked browses
only under Local language required or All language results, never promoted.
New means first seen since the cutoff under the chosen verdict, not approval.
Pipeline/Dismissed keep their ride-along and ignore the language choice, with
an on-screen note saying so. Effective (user-corrected) verdicts drive every
predicate, pill, count and empty state; loaded-page counts never claim to be
workspace totals. No detector, rescoring, upstream-request or copy change
beyond the empty states: the screen is a best-effort gate and says so, never
"100% English". Files: `lib/dashboard.ts` (LanguageFilter, jobInView, pills,
empty states), `app/job-radar.tsx` (selector, counts, pills), `app/globals.css`
(language tabs reuse inset/cream/acid tokens), `tests/dashboard.test.ts`.
No overlap with Indeed UI task #116 (IndeedStatusPanel untouched).

## 2026-09-21 Indeed-only reusable module

The owner made Indeed collection the sole current priority. `scripts/indeed.mjs` provides
one-time local setup/login and repeatable search/status/logout; `scripts/indeed-operator.mjs`
is the importable Node interface. Both the CLI and dashboard use the existing account-scoped
search API, not a separate database. The Indeed button no longer requires a readiness click.
Credentials/session files remain ignored; setup preserves the selected environment's other
settings. Caps, durable cooldown/refusal and admin/loopback gates remain enforced.

Operator instructions and evidence: [INDEED_TESTING.md](INDEED_TESTING.md).
Latest built-runtime CLI proof: 25 rows retrieved, 12 known, 2 new jobs stored; no preflight,
phone or credential re-entry. Do not confuse this isolated test instance with promotion into
the owner's main dev/test servers. This branch still requires review and coordinated promotion.

## 2026-09-21: the reviewed design, and how to check against it

The interface was reviewed with the owner and redesigned frame by frame. **The agreed design
lives in [`docs/design/canvas/`](design/canvas/) — open `index.html` in a browser.** Thirteen
frames covering every window, including the phone views and both panels opened.

Work on it is tasks **UX-6a** to **UX-6g** on board #4. Each carries its full specification
inline, because the canvas they came from is a private artifact nobody else can open.

Before calling any of them done:

```bash
npm run check:design   # token values, the ladder, the 12px floor, three structural changes
npm run dev            # then, in another terminal:
npm run check:visual   # a real browser, signed in, measuring both widths
```

`check:visual` signs itself in with a throwaway account and seeds one advertisement per verdict,
so the job card is on screen when it measures. It adds no dependency - Node's WebSocket drives
the Chrome or Edge already on the machine.

It settles the mechanically checkable half — token values, the 12/14/17/24/32 ladder, the 12px
floor, and three structural changes — and names the reason behind each value. It cannot judge
layout, so also open `docs/design/canvas/index.html` beside `npm run dev` at 1400px and 375px,
signed in. **Nothing tests `app/job-radar.tsx`**, so a green gate is not evidence a screen is
right.

Colour was measured, not chosen: the old `--muted` `#657169` was **4.88** against cream while
carrying most of the supporting text, and `--signal-neutral` `#9aa09a` was **2.56**, which
fails. Do not nudge these values without re-measuring.


## 2026-09-20 close-out: CSP on a nonce, filtering in SQL, the dashboard partly tested

Master is green: lint, typecheck, **289/289**, build, and `npm run verify:dev` end to end.

- **#2 `'unsafe-inline'` is gone.** `middleware.ts` mints a per-request nonce; the header is set on
  the *request* as well as the response, because that is where vinext reads it to stamp the script
  tags. The policy builder is in `lib/security-policy.ts` so the tests read the same one the
  middleware uses, and a test asserts `next.config.ts` never sends a second policy - two policies
  means the browser enforces the intersection. Verified in a browser, not inferred: nonce rotates
  per request, all 79 script tags carry it, and the page hydrates.
- **#3 filtering and paging are in SQL** (migration 21, `search_text`, accent-folded because SQLite
  LIKE cannot fold). The audience rules moved but did not change, and are now shared by the page and
  both counts: administrator keys excluded in SQL, Indeed hidden from ordinary accounts by URL
  pattern as well as by key.
- **#17, #72, #79, #80, #83, #84, #85, #86** all merged. The Indeed epic **#63 is closed**.

**Two things that are true and easy to forget:**

- A **blob-URL Web Worker is blocked** by `worker-src 'self'` (#87). Pre-existing, not from the CSP
  change. There is now no worker in app code at all - the only one was pdf.js, which went with
  the CV feature - so this bites whoever adds the next one.
- Workers wedge silently when they stop to ask permission for a tool call. `pm.py` now closes their
  stdin and bounds each run at 45 minutes; before that, two runs sat for over ten minutes producing
  a zero-byte log while `progress` reported them as "just started".

**Nothing dispatchable is left in the queue.** What remains is yours: #1 credentials, #8 publishing
~60 local commits, #9 branding, #7 Apify, #18-#20 (a Jooble key), #35 and #43-#48 (direction),
#73 (VPN), #81 (an independent read of the lead's own merges, which no worker the lead dispatches
can give), and #6, which is Postponed pending a source-permissions decision rather than unbuilt.

## 2026-09-20 third session: keyword filtering moved into SQL, /api/state paginates

Branch `ai/server-side-filtering-20260920-071028-819440`, unmerged. `/api/state` used to
return the 2000 most recent rows and let the client filter, so the limit was spent on jobs
the saved keywords exclude while older matching jobs stayed invisible past it. The required
and excluded keywords now filter in SQL before the limit, against a new accent-folded
`jobs.search_text` column (migration 21), and the endpoint pages with a keyset cursor
(`limit` 1-2000, `nextCursor`, `matchingJobs`/`totalJobs` counts). The dashboard loads
further pages through a "Show more jobs" button. Saved, applied and dismissed rows still
ride along when the keywords exclude them, so Pipeline and Dismissed keep showing what the
person did. `NORMALIZATION_VERSION` is unchanged; pre-migration rows are backfilled on read
without rescreening or reclustering.

Found while exercising on a fresh database: **no fresh checkout could boot past migration
18** - the base schema already carried `search_netherlands`/`search_switzerland`, so the
migration's re-ADD failed with "duplicate column name" and every request 500'd. Existing
databases never noticed (their tables predate the columns). Fixed by removing the two
columns from the base in `db/runtime.ts`; `tests/migrations.test.ts` now asserts no base
column duplicates a later ALTER.

Verification: 265/265 tests (7 new in `tests/keyword-pagination.test.ts` proving the SQL
filter agrees with `matchesSearchCriteria`, including accents and LIKE metacharacters),
lint, typecheck, build, and a live exercise of register/criteria/import/filtered paging/
ride-along/400s against isolated dev (:3020) and built test (:3001) servers, each on a
fresh database. Not done: no signed-in browser check of the new button, and workspaces
past 2000 rows were exercised with small limits rather than real volume.

## 2026-09-20 second session: Indeed merged, the gate corrected, the worker hang found

Master is green: lint, typecheck, **257/257**, build, and `npm run verify:dev` end to end.

**Indeed (#66-#69) is merged** as `18ab801`, taken over after codex-lead ran out of credits
mid-reconciliation. Its work was captured in two commits first, because all 24 files were sitting
uncommitted. It ships `disabled`, `adminOnly`, loopback-only, and all nine Indeed host aliases are
confirmed in `adminOnlySourceKeys()` - the defect class that once exposed 218 Careerjet rows under
`jobviewtrack.com`. **Not claimed:** no live upstream search, no browser or API acceptance, and
stable promotion is a separate decision.

**The language gate was wrong in four places (#79)**, found by an independent review and each one
reproduced by hand before anything was changed. All four were the same mistake: a rule measured its
reach in *characters* when it meant "this sentence" or "this noun phrase". Two false passes
(`No travel. German is required.` passed; `read and write Dutch for regulatory reports` passed) and
two false blocks (`Fluent German is required, but Dutch is a plus` blocked Dutch; `Fluent Dutch is
a plus` blocked). `NORMALIZATION_VERSION` 8 -> 9, because verdicts move in both directions.

**Source conduct (#80).** The Common Crawl index is now queried one request at a time, paced before
each start rather than after, obeying `Retry-After`; the per-request timeout covers the body; and
the two country adapters share one board collection instead of each launching a 282-board batch.

**Why workers kept producing nothing.** `pm.py` ran them with inherited stdin, so a worker that
stopped to ask permission for a tool call waited for input that could never arrive, with its output
redirected to a file so nothing was ever flushed to say so. Two runs died that way. stdin is now
closed and runs are bounded at 45 minutes. The same session's `progress` command reported such a
run as "just started" forever, which is why it went unnoticed - that label now says when there is
no log at all.

**`npm run verify:dev` had been failing on a working app**, for two unrelated reasons, both
pre-existing: it parsed only `application/json` while `/api/scrape` streams NDJSON, and it still
asserted the CV gate that `CV_MATCHING_ENABLED = false` removed. `CLAUDE.md` names that harness as
the way to check a change locally and nothing tests `app/job-radar.tsx`, so a harness that cries
wolf is worse than none. #85 covers testing the harness itself.

**Still not done, deliberately:** #2 (nonce CSP) needs a signed-in browser check and is not worker
work; #81 asks for a second opinion on the lead's own merges and cannot be answered by a worker the
lead dispatches; #43-#48 and #35 are direction decisions; #8 (publishing ~60 local commits) remains
the owner's call, and the remote master is a stale squash base still at `NORMALIZATION_VERSION` 5,
so `git merge origin/master` conflicts and must not be run blind.

## 2026-09-19 - Standalone Indeed connector works; dashboard not connected

Read the current checkpoint in [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md), not the
earlier refusal-only notes below. The owner approved the specifically discussed mobile
identity header experiment. With certificate verification intact, one minimal probe returned
HTTP 200 and a description-bearing Dutch job. Then the real TypeScript connector fetched two
Dutch jobs across two pages and one Swiss job in three bounded requests. Description lengths
were 7,534, 3,954 and 12,457 HTML characters; dates, employer and country were present.
No phone, account login, personal token or cookies were needed by this tested path.

Implemented in the existing isolated auth worktree: `lib/indeed/contracts.ts`, `auth.ts`,
`client.ts` and synthetic tests. Credentials are explicit backend config, never tracked.
Caps, timeouts, refusal/cooldown behavior, query escaping, response validation and partial
result reporting are included. This is version 1 of the downstream transport interface.

Verification: 212 automated tests passed, including 18 focused Indeed tests; typecheck,
lint and production build passed. Live evidence is limited to the three connector requests
above (plus the initial probe), not volume testing or dashboard acceptance. #64/#65 are
ready for review; downstream tasks remain separate and no stable-test promotion occurred.

The stable app has **not** been changed: #66 normalization/completeness, #67 source integration
and tenancy, #68 reporting, #69 UI/QA remain. Do not mark the whole Indeed feature done or
claim 200-400 results were tested. Records deliberately retain unknown completeness until
that is validated. No owner database, account, dev/test configuration or server was touched.

## 2026-09-19 - JobSpy comparison and second desktop probe

Latest evidence is in [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md). JobSpy's
Indeed connector has no personal OAuth flow, so the earlier OAuth-only direction
was too narrow. One owner-requested, modified JobSpy-style query for one job and
its description returned non-JSON HTTP 403. No data was retrieved and no retry ran.

The test kept certificate verification and a truthful client identity. It did not
copy JobSpy's iPhone app identity headers, so it is not evidence that unmodified
JobSpy succeeds or fails here. Preserve that distinction. Auth/client tasks remain
incomplete, adapters disabled, and the owner servers/data untouched.

## 2026-09-19 - Indeed auth evidence, not a working connector

Continue from [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md), especially the new
authentication checkpoint. Static inspection found session-derived token handling,
a renewal path and a query selecting job-description text. Private implementation
details and research artifacts stay outside this public repository.

The only desktop probe so far returned 403; no successful search/detail or token
renewal was demonstrated. Phone diagnostics did not expose a usable live auth
exchange. No account cookies/tokens were extracted, no source was enabled and no
owner servers or data were changed. #64 and #65 are still incomplete. Next needs
provider-supported dynamic evidence or provisioned desktop access, not blind
request retries or treating the embedded app key as sufficient authentication.

## 2026-09-18 - Indeed task ownership (#63)

The owner requested a multi-LLM task breakdown and explicitly assigned Indeed authentication and
connection implementation to Codex. Read [INDEED_INTEGRATION.md](INDEED_INTEGRATION.md) for the
worker boundaries, dependencies and acceptance criteria. GitHub parent #63 and child issues #64-69
are the execution records on Project 4. Codex owns #64/#65 in run
`ajh-indeed-auth-connection-20260918-171415-590073`; other implementation tasks are unclaimed.

This checkpoint creates coordination documents only. Indeed is still disabled; no working search,
authentication lifecycle, unlimited quota or complete-description request has been demonstrated.
The owner reports authorization for local assessment. Private research and credentials stay outside
Git and public issues. Other LLMs consume a sanitized frozen contract and synthetic fixtures, not
phone or account artifacts. Contract revision 1 is the next Codex deliverable. Do not restart the
owner's server or enable the source merely because these tasks exist.
## 2026-09-20 five worker changes merged (#59, #60, #74, #75, #76)

Five isolated worker runs landed on master together. Gate green afterwards: lint, typecheck,
**220/220 tests**, build.

- **#74 loosened the language gate**, which is the change to watch. A language mention can now be
  *exempt* as well as required or optional, so an explicit denial ("No German is required"), a
  language offered as lessons, and a nationality or market use stop costing a review. Exemption is
  per-occurrence: one ordinary mention elsewhere still means review, and a requirement anywhere
  still blocks. `NORMALIZATION_VERSION` 6 -> 7 so stored rows are re-screened rather than keeping
  verdicts the old rules produced. "bilingual in X" now blocks, where it used to under-block to
  review.
- **#76** taught the excerpt where the requirements section starts in Dutch, German and French ads.
  Chosen for precision over recall; the rejected near-misses are recorded in `lib/excerpt.ts` so
  they are not re-added.
- **#75** made `fetchCompany` return an outcome rather than an empty array on every failure, and
  added exactly one retry of timeouts, network failures and 5xx. Never retries a 429 or any 4xx:
  a refusal is a stop signal. Measured at 281/282 boards and an identical 30,057 postings across
  six consecutive passes, zero 429s in ~1,700 fetches.
- **#59** added `scripts/discover-boards.mjs`, board discovery we own. **Its index half has never
  returned a candidate** - `index.commoncrawl.org` answered 502/504 all day - so a zero-candidate
  run currently means the index did not answer, not that there is nothing to find. The verification
  half is proven against live boards.
- **#60** recorded in `docs/SOURCE_POLICY.md` why employer boards carry the public tier, what an
  employer must pass to be added, and why Workday is excluded.

Epic **#54 is closed**: 60 -> 282 verified boards, Teamtailor and Workable adapters, our own
discovery, and the policy written down. No Workable *employer* is configured - every account probed
answered with an empty `jobs` array.

**No pull requests.** The remote master is far behind local master, so a PR against it reads as
thousands of unrelated additions; PR #77 was opened by the tooling and closed for that reason.
Publishing those commits is #8 and remains the owner's decision.

## 2026-09-09 restricted-source decision (#32)

Keep the small private source portfolio. jobs.ch, jobup.ch and JobScout24 remain local
administrator/VPN-only; IamExpat remains local-administrator-only without a VPN requirement;
Undutchables remains local-administrator/VPN-only because it previously blocked automation. No
source was removed, no stored rows were deleted, and no caps, schedules or access paths were added.

The reason is quality, not volume. The measured data contains 12 full-advertisement
English-confirmed jobs from this portfolio: jobs.ch 3, jobup.ch 6, IamExpat 1 and Undutchables 2,
alongside 114 confirmed jobs from the public tier. JobScout24 has no separate measured yield and is
retained on probation because it shares the existing JobCloud adapter and VPN boundary. Revisit only
after repeated successful zero-yield searches, recurring maintenance failures, changed rules or a
block.

JobCloud's current terms still prohibit automation and jobs.ch robots.txt still disallows the detail
paths read. The owner accepted that risk only for the private administrator tier. The fixed delay,
four-new-details-per-source cap, manual trigger, unauthenticated access, VPN gate and no-evasion rule
remain non-negotiable. Undutchables robots.txt is readable again and permits the exact plain listing
and detail paths used while disallowing query-string searches; its prior blocking is why the VPN
precaution stays. Running servers and local data were not touched.

## 2026-09-09 Careerjet decision (#31)

Careerjet is retained as a **local administrator-only discovery source**. It is not a public or
hosted feature. Leave `CAREERJET_API_KEY`, `CAREERJET_REFERER` and `CAREERJET_USER_IP` unset in every
hosted environment; local use is allowed only with a correctly registered publisher site/key and
real request details. The server-side audience gate and the `jobviewtrack.com` storage alias remain
mandatory.

The existing 237 leads were deliberately preserved. They produced zero English-confirmed jobs and
233 `unknown` verdicts because the API supplies 279-character teasers, but they may still be useful
for an administrator to inspect manually. A Careerjet result must never be presented as proof that
English is sufficient. The admin conversion report is the basis for any later retirement decision.

The current official publisher documentation was rechecked before recording this decision. It
requires a unique key per publisher website, the real end-user IP and user agent, and an originating
page Referer. The current placeholder registration remains unresolved and is not permission for a
public integration. No database rows, credentials, environments or running servers were changed.

## 2026-09-09 Adzuna public-tier decision (#30)

Adzuna is retained as an administrator-only coverage measure and removed from ordinary accounts.
The current publisher terms permit listing publication and personal research, but the standard API
only supplies the 500-character teasers that produced zero English-confirmed jobs. Full job details
are a separate Adzuna data service; the app does not follow redirect targets to copy third-party
text.

Both adapter keys and the stored result hosts (`adzuna.ch`, `adzuna.nl`) are in the server-derived
administrator-only set. This hides existing jobs, future searches and per-run rows from ordinary
accounts while preserving the administrator conversion report. No rows or detector verdicts are
changed. The administrator result view acknowledges “The Adzuna API” and links to the relevant
local domain. `/sources` now uses the same audience split, so it does not disclose Adzuna or the
other private discovery sources to an ordinary visitor.

Source decision and current terms links are in `docs/SOURCE_POLICY.md` §3. Verified against an
isolated copy of the populated test database: the administrator received 346 visible Adzuna cards
and Adzuna run rows, with all four hidden keys advertised to the client-side preview. A fresh
ordinary account received zero jobs after importing its own `adzuna.nl` row, received no private
source names, and its `/sources` page did not contain Adzuna; the administrator page did. All 155
tests, lint, typecheck and the production build pass. The temporary port 3013 Worker was stopped;
the owner's dev/test servers and databases were not touched.

## 2026-09-14 — stored duplicate links (#50)

Implemented in isolated branch `ai/recluster-stored-jobs-20260914-132120-382758`;
not yet integrated into the owner's primary checkout or its saved test workspace.
The GitHub board is https://github.com/users/Ydony/projects/4.

- Previously `/api/state` reclustered only if a job had an empty `cluster_key`. Existing
  links therefore retained the old date rules, hiding some distinct reposts indefinitely.
- Migration 17 adds an indexed per-row `cluster_version`. Version 16 is reserved for the
  separately pending Job-Room backfill in PR #52; do not reuse that number when integrating.
- `ensureCurrentJobClusters` rechecks the whole signed-in account if any member is stale.
  New imports default to stale; normalization invalidates links after changing matching fields.
  Keyless jobs are marked complete too, so they do not force repeated full recomputation.
- Each batch writes links and versions together. An interrupted later batch leaves stale
  members, so the next read retries the whole group. No user actions, verdict corrections,
  dismissal tombstones or other accounts are rewritten by clustering.
- Validation: 159 tests, lint, typecheck and build passed. Four new tests exercise real D1
  SQL for a populated pre-upgrade table, owner isolation, personal-state preservation,
  a 51-row interrupted batch, new imports and normalization invalidation.
- `scripts/verify-cluster-workflow.mjs` passed against isolated hot-reload dev and the built
  test Worker, each with newly registered ordinary accounts and synthetic data. It checks CV
  upload, criteria, duplicate folding, distinct reposts, actions, correction retention,
  cross-account mutation refusal and dismissal on repeated import. No external sources are called.
  Test verification used port 3011 and an **absolute** `--env-file` path; a relative one initially
  omitted the session secret and returned 503. The normal test launcher already uses an absolute path.
- Fresh owner-workspace backups were created and hash/restore-copy verified before work:
  `local-backups/test/2026-09-14T11-22-07-004Z` and
  `local-backups/dev/2026-09-14T11-22-07-951Z` in the primary checkout. No saved owner data was migrated.

Next: review/integrate this branch with the existing unpushed primary commits, then promote to
the owner's stable test environment. Public hosting, new sources and pagination are separate tasks.
The historical sections below still contain older counts and superseded feature descriptions.

## 2026-09-08 Job-Room legacy-description backfill (#29)

Implemented on the isolated `ai/source-portfolio-20260908-165232-234475` branch; it has not been
applied to the stable test workspace. The administrator page now has a manually triggered
**Backfill Job-Room descriptions** action for the signed-in administrator's own stored jobs.

- It selects only `job-room.ch` rows below the existing 900-character full-text threshold, fetches
  at most 120 details per run, and keeps the existing fixed 400 ms pace. Failed details remain
  eligible for a later retry.
- Migration 16 adds `job_room_detail_version`. A successful detail fetch is marked even when the
  source's complete advert is unusually short, so rerunning never loops over it forever.
- A longer detail replaces only the description and derived language/CV/workplace analysis.
  Saved, applied, dismissed, duplicate, and `language_feedback` state are not updated.
- The report shows attempted, fetched, updated, already-complete, failed and remaining counts plus
  every raw detector transition such as `unknown → blocked`. User corrections continue to control
  the effective verdict because they remain separate.
- The backfill's structured/prose precedence is covered with the same cases as normal Job-Room
  search: employer-declared local requirements and explicit blocking text both win.

Verification: all 128 tests on this branch, lint, typecheck and the production build pass. Migration 16 was applied
to a verified offline backup containing 1,004 jobs and two language-feedback rows; job/action and
feedback counts were unchanged. A fresh throwaway local Worker on port 3012 fetched one current
Job-Room detail, expanded 215 characters to 1,476, changed `unknown → blocked`, preserved card
state, refused an ordinary account with 403, and fetched zero rows on rerun. That temporary server
was stopped; the owner's dev/test servers and saved state were not touched.

After this branch is reviewed and merged, rebuild test, sign in as its administrator, and run the
button until Remaining reaches zero. The issue's measured 234 short rows should require two runs,
apart from any detail failures that need a retry.

## 2026-09-07 integration planning handover

The owner now intends a free public service plus separate administrator discovery. Read
[PUBLIC_ADMIN_INTEGRATION_PLAN.md](PUBLIC_ADMIN_INTEGRATION_PLAN.md) for the recommended source
allocation, architecture, ordered INT-01 to INT-14 task specifications and existing issue links.
It supersedes older future-scope/source-permission assumptions below, not the current runtime.

Documentation only was changed: no adapters, schedules, accounts, secrets, database state or
servers were changed. Dev/test remain local. Public sources need permitted reuse; uncertain or
restricted sources stay admin-only under the owner's accepted risk. UWV and Job-Room permission
is an explicit owner planning assumption, not independently verified evidence. UWV still needs
an actual retrieval interface. EURES is proposed admin-only; its currently public-enabled registry
has not yet been changed. No guarantee against IP blocking is made.

Next implementation step: INT-01 source-policy consolidation, followed by server-side audience
isolation and collection budgets. The GitHub board remains the execution tracker. The sections
below are the 2026-08-31 historical snapshot; do not treat their counts, incomplete-task labels,
or removed-schema references as current verification.

Last updated: 2026-08-31, after the project was converted to isolated local-only dev and test
environments.

**Read `docs/TASKS.md` first** — it is the ordered list of what still needs doing, with the
blocking items at the top. This file explains where the project is and the things that will
surprise you. `AGENTS.md` holds the rules that must not be broken.

## 1. What this is

A private job-search tool for Switzerland and the Netherlands, for someone whose usable working
language is English. It gathers public job advertisements, screens each one for whether English
alone is enough, and scores it against the user's CVs.

Product name is **Ik ben een appel**. Active interface and setup references use that name.

## 2. State right now

Working and verified locally:

- Multi-user accounts with per-account isolation. Every table has an owner column and all queries
  are scoped. A second account genuinely cannot see or touch the first's data — tested.
- Sign-in, sign-out, account settings, account deletion, and an administrator panel.
- Configured sources include Job-Room (67k Swiss vacancies, no key), Adzuna (CH + NL), Careerjet
  (CH + NL), 61 public company career boards, and five private page-fetching adapters. Four of the
  five require the VPN launcher; all five are restricted to administrators.
- `dev` at `http://localhost:3000` with disposable state under `.wrangler/dev/state`. **Its
  database is empty** — no jobs, no CVs. Task A3 needs an account registered and a CV uploaded
  there first, which is deliberate: testing against freshly created data is exactly what exposes
  the write paths that adopted data never touches.
- `test` at `http://localhost:3001` with a stable built Worker and separate state under
  `.wrangler/test/state`.
- The populated test workspace contains 916 jobs, 2 real CVs, and 12 recorded search runs.
- The local-environment change passed `lint`, all 90 tests, `typecheck`, and `build` on 2026-08-31.
  The built test Worker was then restarted and `/login`, `/privacy`, and `/sources` returned 200.
- Isolation between the two environments was independently re-verified on 2026-08-31 by signing in
  to each and cross-sending the cookies: a test session against dev returns 401 and a dev session
  against test returns 401, and the two workspaces differ (test 916 jobs and 2 CVs, dev empty). The
  separation is real, not just configured.

Not built yet: self-service password reset, email verification, pagination past 1,000 jobs, and
backups. All listed with context in `docs/TASKS.md`.

## 3. Things that will surprise you

**Both administrator passwords must be treated as compromised.** Test uses
`admin-test@ikengels.test`, dev uses `admin-dev@ikengels.test`. The generated passwords for both
were posted in plain text into a chat transcript, so they are exposed — not merely temporary. The
owner must change the email and password on **both** environments in `/settings`, not only test.
Changing a password also revokes that account's existing sessions. Never write these into a file,
a commit, or a chat message.

**Registration is closed by default.** `ALLOW_SIGNUPS=false`, so only the first account on an
empty database can be created. To add a second account in dev, set `ALLOW_SIGNUPS=true` in
`.dev.vars.dev` and restart dev. Test has its own `.dev.vars.test`; do not open it casually.

**There is no supported hosted environment.** A short-lived hosted test was removed from public
access on 2026-08-31. Do not deploy again without a new explicit owner decision; see
`docs/DEPLOY.md`.

**The first account created claims any ownerless data.** Rows left from the single-user era carry
`user_id = 'legacy'` and are adopted by the first account registered. On an empty database this
does nothing.

**Sources sit in three tiers, and the tier plus `adminOnly` decides who can run them.**
`authorized-api` and `grey-area` are eligible without the VPN, but an adapter such as IamExpat can
still be administrator-only. `restricted` means the site explicitly prohibits automated access or
actively blocks it: administrator only, and refused unless the process was started through
`npm run dev:private`, which verifies a full VPN route and sets `VPN_ENFORCED`. The button label is
not the enforcement; that env marker is.

**Page-fetching of restricted sites is administrator-only, and that is enforced server-side.** A non-admin calling
`/api/scrape` with `mode=all` is refused, and the names of those sources are filtered out of both
the live report and the stored history so ordinary accounts never learn they exist. The `/sources`
page hides that section from non-administrators too. Do not "simplify" this into a UI-only check.

**Uniqueness is per owner, not global.** `jobs.source_url` and `cvs.slot` are unique per
`user_id`. They were global, which would have let the first user to import a vacancy block everyone
else. Migration 7 rebuilds both tables because SQLite cannot drop the implicit index a `UNIQUE`
column creates. If you add a table holding user data, scope its uniqueness the same way.

**Sessions carry an epoch.** The cookie holds `userId:epoch:expiry`, signed. `requireSession`
compares the epoch against the account, so raising it revokes every existing cookie. Changing a
password, disabling an account, or resetting its password all do this. Changing the cookie format
signs everyone out, which is expected.

**Careerjet cannot work from Cloudflare.** Its key is bound to at most 8 declared IPs, and Workers
have no static outbound IP. See `docs/TASKS.md` A2 for the options.

**`ensureSchema()` runs migrations on the first request**, in order, recorded in
`schema_migrations`. It also backfills job identities and work types, and purges `auth_events`
older than 30 days. It is safe to call on every request and memoised per instance.

## 4. Rules that are not negotiable

From `AGENTS.md`, repeated because they are easy to erode:

- **No detection evasion, ever.** No randomised or human-imitating timing, no fingerprint spoofing,
  no stealth browser plugins, no proxy or IP rotation. This held even when the no-scraping rule was
  reversed, and it is not up for reconsideration.
- **Page-fetching stays manually triggered, capped, unauthenticated, and administrator-only.**
- **Prefer false negatives on "English is sufficient".** A wrong `pass` wastes a real application.
- **A user's CV never leaves the server.** Not to a job site, not to an aggregator, not to any
  model.
- `/sources` and `/privacy` describe what the code actually does. If you change data handling,
  change those pages in the same commit or they become a lie.

## 5. Where things live

| Area | Files |
|---|---|
| Auth, sessions, guard | `lib/auth.ts`, `lib/guard.ts`, `lib/users.ts` |
| Sources | `lib/job-adapters.ts` (registry), `lib/job-room.ts`, `lib/job-aggregators.ts`, `lib/ats-feeds.ts`, `lib/jobsch.ts` |
| Screening | `lib/analysis.ts` (language gate), `lib/workplace.ts` |
| Storage | `db/runtime.ts` (schema + migrations runner), `db/migrations.ts`, `lib/server-data.ts` |
| Pages | `app/job-radar.tsx` (dashboard), `app/login`, `app/settings`, `app/admin`, `app/sources`, `app/privacy` |
| Docs | `docs/TASKS.md`, `docs/ENVIRONMENTS.md`, `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` |

## 6. Working on it

```bash
npm run dev          # hot-reload dev at http://localhost:3000
npm run test:local   # stable local build at http://localhost:3001
npm test             # 90 tests
npm run lint
npm run typecheck
npm run build
npm run init-secrets # creates separate .dev.vars.dev and .dev.vars.test secrets
```

All four checks must pass before a commit. `.dev.vars.dev` and `.dev.vars.test` hold local secrets
and are gitignored; `.dev.vars.example` documents every variable.

The test launcher intentionally runs the emitted Cloudflare Worker with Wrangler rather than a
second hot-reload Vinext server. This makes the test instance both production-build-equivalent and
independent of dev while keeping all traffic and data on loopback/local disk.

Environment notes: only one hot-reload `vinext dev` can run per project. `test:local` runs the
built Worker through Wrangler, so dev and test can run together. On Windows, Git Bash needs
`taskkill //PID <pid> //F` with doubled slashes.

## 7. A caution from experience

The multi-user change touched 61 queries across 8 routes. A pre-deployment review then found that
CV upload had been completely broken by it — the insert never set `user_id` — and that four other
routes had cross-tenant defects, including a workspace reset that would have deleted **every**
account's jobs.

None of that showed up in ordinary use, because the existing data had been adopted rather than
freshly created. When you change anything touching tenancy, exercise the whole flow as a **second**
account with **new** data, not just the account that already has rows.

## 8. Next action

The environment conversion is complete. Continue at `docs/TASKS.md` A3: exercise the entire dev
workflow as a fresh second account, report findings before fixing them, and verify cross-account
access fails. A1 remains a personal owner action, and now covers both environments: replace the administrator
email and password in `http://localhost:3001/settings` **and** `http://localhost:3000/settings`,
because both passwords were exposed in a chat transcript.

## 9. 2026-09-22 Spark: results-clarity review fixes (#124/#125) — verified, awaiting lead review
Owner-authorized recovery in worktree `ajh-resultsclarity-20260922-205227-467012`
(branch `ai/resultsclarity-20260922-205227-467012`). Continued the uncommitted fixes, did not
rebuild. Codex's hydration fix in `app/job-radar.tsx` (stable `filtersOpen`/`isNarrow`
initializers, viewport applied after mount) is preserved untouched.

What the fixes do (all four PR #128 review items):
- **#124 authoritative totals:** search and delete no longer derive Total collected from
  `importedCount`/`added.length` or visible-row subtraction. Both reconcile via `GET /api/state`
  immediately; failure keeps previous totals, never a guess (`app/job-radar.tsx`).
- **#124 truthful view-as-user:** admin `?preview=user` on `GET /api/state` applies ordinary
  audience predicates server-side *before* aggregation/dedupe. The client reads preview totals
  and runs from that response; while loading the total is unknown (—), never a false zero.
- **#124 dedupe contract:** first-kept unique attribution — primaries under their own source,
  orphan copies under the copy's source — so per-source numbers add up to the overall.
  `TOTALS_DEDUPE_NOTE`, `lib/server-data.ts` comments and tests all say this; the old
  "can exceed the overall" wording is gone.
- **#125 heading modality:** `formatRequirementsRailLabel()` (`lib/requirements.ts`) renders
  `Asks for — {heading}`, so "Nice to have" stays optional. Regression test included.

Harness corrections (checked in code before trusting failures): `claimedLegacyWorkspace` is
`isFirst` (`lib/users.ts:79,98`) — true for the first account even with zero legacy rows, so it
is not evidence of adopted data. `GET /api/state` returns `profiles`, not `cvs`
(`app/api/state/route.ts:115`). A preview-vs-ordinary deep-equality check is also wrong by
construction: the preview shows the *caller's own* rows under ordinary predicates, so it cannot
equal another account's totals.

Evidence (dedicated synthetic DEV at localhost:3000, reusable accounts untouched, no resets,
no provider calls, no real CVs):
- `node work/spark-dev-access.mjs access` → DEV_ACCESS_PASS.
- `npx tsx --test` on the three touched files: 44/44 pass. Full `npm test`: 375/375 pass.
  `tsc --noEmit` and `eslint` on touched files: clean.
- Live API: admin totals `{total:1, example.com:1}`, sums add up, preview keeps the public row
  under ordinary predicates, preview exposes no `adminOnlySources` key, ordinary totals 0 (own rows).
- Real headless Chrome against running DEV, admin session: desktop and 390px fresh loads with
  zero console/page errors (no hydration mismatch); stats show "1 collected"; View-as-user toggle
  keeps truthful "1 collected"; job rail renders "Asks for — Requirements" with the fixture's
  2 extracted items.
- New tests: preview-vs-subtraction and delete-with-retained-copy (`tests/collection-totals.test.ts`),
  sums explainer (`tests/dashboard.test.ts`), rail-label modality (`tests/requirements.test.ts`).

Not verified / remaining: hidden-primary + public-copy preview parity is covered at the query
layer only — the exact live case cannot be built without a provider search, which is out of scope.
Manual URL import reconciles through the same search-result path (no separate import handler
exists in `app/job-radar.tsx`). `npm run build` not re-run this session. Do not merge, push, or
close #124/#125: lead review still required. Indeed tasks (#112–114, #116–117, #126) untouched.

## 10. 2026-09-22/23 Spark: Indeed IND-Next implementation (#113–#117) — done, gates pending

Branch `ai/indnext-spark-20260922-220000` (this worktree; results-clarity commit `a6461fd`
is its base — lead review of #124/#125 is unaffected). Five commits, one per task:
`6cb38e3` (#113 settings), `747b329` (#114 collection), `f2ed512` (#115 checkpoints),
`51c5453` (#116 website), `0a15175` (#117 evidence/docs). Prior partial worktree
`ajh-indnext1-20260922-153352-855709` used as reference only and preserved.

Live caps unchanged everywhere: 25 rows/role/country, 4 requests/100 rows per click,
7-day local window, 60s cooldown. `INDEED_FINAL_BUDGET` (200/800) exists as tested
design only; activation is #126 and correctly blocked (see below).

Evidence: 408/408 tests, `tsc`/`eslint` clean, `npm run build` + `check:design`
pass. Live DEV (read-only + panel save/restore round-trip): settings gating,
preview totals, panel render with zero console errors desktop/390px. No provider
calls, no resets, reusable accounts untouched. Full evidence ledger (mocked vs
live vs not-tested) in `docs/INDEED_HANDOVER.md`.

Deliberately not done: #126 activation (blocked by open #118 and #69 — activating
now would violate the task's own precondition); closing any issue (lead review
required); built-test/verify-harness flows (would disturb owner servers);
live Settings PUT beyond restore-to-defaults; loosening the admin/indeed
readiness gate (Codex access-control territory). Epic #112 stays open until #126.
# 2026-09-27 — Signed-out dashboard flash (#141 follow-up)

The owner reported the dashboard painting briefly before redirecting to login.
`app/job-radar.tsx` now returns only a neutral session placeholder until
`state.account` exists (after all hooks). A failed initial load instead offers retry
and sign-in, without dashboard controls. HTTP 401 clears any previously loaded
account before redirecting with `location.replace`; the boundary stays closed even
after the loading flag clears. API authentication and stored data are unchanged.

`tests/login-flash.test.ts` renders the initial component HTML and asserts no
workspace controls. `scripts/check-visual.mjs` now observes DOM additions across
the signed-out root-to-login redirect, then registers its synthetic account from
the settled login page, avoiding its old navigation race. Built local Worker on
3118: signed-out no-flash assertion and authenticated desktop/wide/phone checks
passed; the missing-card canary correctly failed its assertions. Lint, typecheck
and build passed. No owner DEV/TEST state was touched and no providers were called.
Production promotion is separate; do not assume this entry alone means deployed.

<# 2026-09-29 — T13 hosted assessment: Adzuna/Careerjet credentials, site/IP rules, Indeed local boundary (F4 gate input)

New: `lib/hosted-sources.ts` (one hosted decision per administrator-side adapter:
`supported`, `configuration-needed`, or `blocked` with the exact reason; variable names
only, never values), `tests/hosted-source-assessment.test.ts` (pins the matrix and the
Indeed local boundary with synthetic fixtures, plus a tripwire against secret values), and
`docs/HOSTED_SOURCE_ASSESSMENT.md` (owner-review artifact for the T12/T13→T14 scope gate).

Net position: nothing is `supported` on the host today. Adzuna CH/NL is `configuration-needed`
(key-only, no site/IP binding; missing keys report `unavailable`, never silent success).
Careerjet CH/NL is `blocked` (publisher-site binding plus per-request real-user IP, user
agent, and Referer with an unresolved registration; all three `CAREERJET_*` stay unset
hosted). jobs.ch/jobup.ch/JobScout24, IamExpat, Undutchables, Indeed CH/NL,
Nationale Vacaturebank, and I amsterdam are `blocked` with per-source reasons. Indeed stays a
loopback-plus-admin-plus-approved-identity local experiment; the test re-exercises
`indeedReadiness` denying every hosted-shaped caller synthetically.

Not executed: this worktree has no JS runtime (`node`/`npm` absent), so the new test file,
lint, typecheck, and build were NOT run here — done statically against the cited sources
only. Reviewer: run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` at the
reviewed commit before accepting. No upstream requests made, no credentials read, no owner
DEV/TEST state touched. Do not push, open a PR, or start T14: the scope gate needs the
owner's review of the §1 matrix first.

# 2026-09-30 — T28 private-data / trust-boundary / secret-lifecycle map (F11 baseline, Spark)

New: `docs/PRIVATE_DATA_MAP.md` (per-category storage/encryption/key-access/retention for
P1–P10, seven trust boundaries B1–B7, full secret lifecycle table, synthetic `example.invalid`
fixtures, and the admitted plaintext-at-rest gaps handed to T29/T30), `tests/private-data-map.test.ts`
(map-vs-schema/secret drift guards, fail-closed shape, hash-only tokens, redaction), and
`scripts/verify-private-data-map.mjs` (throwaway synthetic fixtures: baseline string scan of
file+WAL bytes, WAL sidecar presence, live 503 fail-closed, hash-only and owner-scoping checks,
secret-declaration and tracked-file value scan; redacted JSON evidence, temp dir removed).

Nothing pre-existing was rebuilt: tenancy, `/privacy`–`/sources` accuracy, backup copy/restore
shape, and hashing/session/token behavior were already covered (`tests/tenant-route-bindings`,
`privacy-policy`, `source-policies`, `auth`, `email`; `scripts/verify-local-backup`,
`verify-sqlite-import/restore`). The map references them as already-true rather than re-proving them.

NOT exercised here: this worker environment has no Node runtime (`node` absent; only python3),
so `npm test`, `lint`, `typecheck`, and the new verify script were NOT executed — only
Python-based consistency checks (every mapped table/secret exists in `db/`+`deploy`, SQL columns
match the schema, redaction patterns from the test hold against the map, guard.ts ordering holds).
Reviewer (Claude): run `npx tsx --test tests/private-data-map.test.ts` and
`node --import tsx scripts/verify-private-data-map.mjs` at the reviewed commit before accepting.
No real secrets, production data, or host access were involved; no push/PR/merge.

# 2026-10-01 — Password-hashing policy benchmark + versioned verification + legacy rehash (T34)

`lib/auth.ts` now carries a reviewed policy instead of a bare 100k constant: Node
(local/VPS) creates 600,000-iteration PBKDF2-SHA256 hashes (OWASP 2023 minimum;
`npm run benchmark:password-hash` measures ~136 ms hash / ~127 ms verify on this
machine — re-run on the VPS before treating it as reviewed there, tune with
`PASSWORD_HASH_ITERATIONS`), while the hosted Worker keeps the 100k cap it can
verify. The iteration count is the stored version: `parsePasswordHash()` reads it
back, `passwordHashNeedsRehash()` flags only weaker hashes (never downgrades), and
`authenticate()` in `lib/users.ts` upgrades a legacy 100k/210k hash on successful
login without touching the password. Verification rejects counts below 1,000,
above 2,000,000, and wrong-length salts/hashes. `scripts/bootstrap-prod-admin.mjs`
and `scripts/reset-prod-admin-password.mjs` pin `WORKERS_PBKDF2_CAP` explicitly —
both run on Node but their hashes are verified by the hosted Worker, and the Node
default there would repeat the 2026-09-24 sign-in outage; revisit after cutover
(#201). `docs/DEPLOY.md` records the new compromise.

Evidence (all synthetic, no real credentials): `tests/password-hash-policy.test.ts`
(version parsing, no-downgrade, legacy-login upgrade + password unchanged,
wrong-password/disabled/missing never rehash, Miniflare D1), updated
`tests/auth-worker.test.ts` (explicit 100k for the Workers runtime),
`npm run benchmark:password-hash` table above; full suite 561/561, `tsc` and
`eslint` clean.

# 2026-10-01 — F11/T30 key-injection seam, fail-closed, behind the SQLite adapter (Spark, unreviewed)

T30 asked to integrate the selected encrypted-database opening behind the current adapter.
What already existed: plain `node:sqlite` opens via `db/sqlite-adapter.ts` (WAL, no key
support), `SQLITE_PATH` wiring in `db/runtime.ts`, fail-closed 503s on missing
`SESSION_SECRET` — and no encryption, key-injection, or T29-selection output anywhere
(grep for encrypt/SQLCipher/key-injection: zero hits; no `db/encryption.*`,
`tests/sqlite-encryption.*`, or `verify-sqlite-encryption` before this change).

What this change does (synthetic fixtures only, no real secrets):
- New `db/encryption.ts`: key resolution (`SQLITE_KEY_FILE` preferred over `SQLITE_KEY`,
  file wins so a stale inline value cannot shadow it), exact-match
  `DB_ENCRYPTION_REQUIRED` flag, and `decideDatabaseOpen()` which throws before any file
  opens when required-but-keyless or keyed-but-driver-has-no-cipher. Refusals never echo
  key material; `databaseEncryptionStatus()` reports presence/source only.
- `db/sqlite-adapter.ts`: `openSqliteDatabase(path, { key })` accepts the injection point
  and refuses any keyed open fail-closed — `node:sqlite` ships no cipher, so accepting a key
  would read as encrypted while staying plaintext. Unkeyed dev/test behavior is unchanged.
- `db/runtime.ts`: `selfHostedDatabase()` resolves the key and enforces the policy inside
  `bindings()`, before schema/migrations run. `db/env.d.ts` types the four variables.
- `tests/sqlite-encryption.test.ts` (9 tests) + `scripts/verify-sqlite-encryption.mjs`
  (13 checks): fail-closed matrix, key-file precedence, redaction of every refusal, and the
  honest current-posture assertion that an unkeyed copy still reads clean.

Evidence at this commit: 565/565 tests pass, lint clean, typecheck clean,
`node --import tsx scripts/verify-sqlite-encryption.mjs` PASS (13/13).

Blocker this work does NOT clear: at-rest encryption itself. A copied database, its WAL/SHM
sidecars, and Litestream/file backups remain plaintext until the owner-selected cipher driver
from T29 lands (e.g. SQLCipher-capable driver) behind the same `openSqliteDatabase` seam —
owner review of that approach precedes T30/T32 per F11, and no such selection is recorded in
the repo. `DB_ENCRYPTION_REQUIRED=true` therefore keeps the app down by design until the
cipher exists; do not unset the flag to work around it. Backup-tooling compatibility with an
encrypted database is unproven — do not assume Litestream works unchanged. Needs reviewer
(Claude) pass before any scope continues.

# 2026-10-02 — F11/T30 rebase onto origin/master (Spark, merge-ready)

Rebased the T30 key-injection seam onto `origin/master` (22 commits since the
`a4a0997` base). The only overlapping file was `docs/HANDOFF.md` (both sides
appended new tail sections); kept both sides with no other change: origin's
T13/T28/T34 sections first, then the T30 section above. `db/encryption.ts`,
`db/runtime.ts`, `db/sqlite-adapter.ts`, `db/env.d.ts`,
`tests/sqlite-encryption.test.ts`, and `scripts/verify-sqlite-encryption.mjs`
replayed cleanly with no content conflict. Re-ran the T30 evidence at the
rebased commit (see rebase verification below).
