# Hosted assessment: jobs.ch, jobup.ch, JobScout24, IamExpat, Undutchables (T12 / F4 scope gate)

Assessment only. This document decides nothing and permits nothing: it records, against the
current code and policy, what each of the five administrator page-fetch sources would need to
run on a host, and where the existing gates already hold. The owner reviews the matrix in §2
before any implementation (T14 scope gate). No hosted run, credential, production access or
private data is part of this task.

- Date: 2026-09-30. Worktree branch: `opl/task-T116-20260930-005757`.
- Reviewed tree: `a4a0997` (plus this assessment's own commit; see §8).
- Method: static inspection of the adapter, policy, route and test files listed in §1, with
  synthetic fixtures only. No live upstream request was made, and no hosted run was started.
- Runtime limitation, stated plainly: this worker has no Node/npm toolchain (`npm` not found,
  no `node`/`bun`/`deno` binary), so the test suite could not be executed here. §8 gives the
  exact commands for the reviewer to run; the new test in `tests/hosted-source-assessment.test.ts`
  is written to the repo's existing synthetic style (mocked `fetch`, no network) so it runs
  inside the normal gate.

## 1. What already exists (and what was checked)

Adapters (known from the 2026-09-29 review, re-verified):

- `lib/jobsch.ts` — shared page-fetch helpers: `delay`, `interleaveUnique`, `stripHtml`,
  `extractJobPosting`, `fetchSearchResultIds`, `fetchJobDetail`; legacy caps `RESULTS_PAGE = 1`,
  `MAX_NEW_JOBS_PER_RUN = 8`; `REQUEST_DELAY_MS = 1500` (exported; the live scrape path uses the
  adapter-level delay below).
- `lib/job-adapters.ts` — the registry. All five sources live here: `jobs.ch`, `jobup.ch`,
  `jobscout24.ch` (JobCloud search adapters + `fetchStructuredDetail`), `iamexpat.nl` and
  `undutchables.nl` (listing-index `search` + `fetchStructuredDetail`). `REQUEST_DELAY_MS = 1200`,
  applied between search terms and between detail fetches in `app/api/scrape/route.ts`.
- `lib/job-aggregators.ts` — Adzuna/Careerjet only; not in T12 scope except as the contrast case
  (keyed APIs with `hasCredentials`, deliberately unset on hosted).

Policy (authoritative, unchanged by this assessment):

- `docs/SOURCE_POLICY.md` §3 + retention decision #32 — per-source audience and standing.
- `lib/source-policy.ts` (`SOURCE_POLICY_REGISTRY`, `sourcePolicyFor`) — the enforced audience
  split; `lib/job-adapters.ts` `adminOnlySourceKeys()` derives the hidden set from it.
- `lib/source-policies.ts` (`sourcePoliciesForRole`) — the `/sources` transparency page split.
- `AGENTS.md` "Source integration boundary" — caps, fixed delays, truthful reporting, no-evasion
  rule; JobCloud automation knowingly against terms at the owner's explicit local-only instruction.

Gates (all verified by reading, not by running):

- Trigger: `app/api/scrape/route.ts` — `requireSession`, `mode: 'all'` refused for non-admin
  (403), refused without `authSecrets().vpnEnforced` (409 with the `dev:private` message);
  `sourceGroup: 'indeed'` refused for non-admin; default `authorized` mode excludes
  `access === 'restricted'`.
- Stored results/history/counts/URLs: `app/api/state/route.ts` — SQL audience predicates
  (`adminOnlySourceKeys()` + `adminOnlySourcePolicyKeys()` union), `visibleSearchRuns` for stored
  runs, `audienceExclusionClause` shared helper in `lib/server-data.ts`; `visibleSourceReports`
  shapes the live scrape response identically; `upsertJob` keeps the account's own
  `canonical_url` on its row (#188 fix).
- Discovery: `app/sources/page.tsx` via `sourcePoliciesForRole(isAdmin)` — ordinary accounts
  receive no `Restricted sites` group at all.
- Budgets/refusal: `lib/collection-budgets.ts` — `MAX_NEW_PER_PAGE_SOURCE = 4`,
  `MAX_NEW_PER_BULK_SOURCE = 200`, `MAX_NEW_PER_RUN = 800`; `isAccessRefusal` (401/403/429/451 +
  refusal wording) latches per-run `markBlocked` with no retry, rotation or fallback;
  `isRuntimeBudgetExhausted` kept separate so platform ceilings never masquerade as refusals (#192).
- VPN mechanism: `db/runtime.ts` `authSecrets().vpnEnforced` (`VPN_ENFORCED === 'true'`);
  `scripts/start-private.ps1` / `scripts/start-private-macos.sh` set it only after verifying a
  full tunnel route; `docs/VPN.md`, `docs/ENVIRONMENTS.md` (VPN-enforced variants).
- Hosted context: `docs/DEPLOY.md` (private single-admin Worker, Careerjet/Indeed creds never to
  prod), `docs/HOSTING_COST_ANALYSIS.md` (per-invocation ceilings: 50 subrequests / 10 ms CPU on
  Workers Free; a full click needs ~700 requests, admin page-fetch subset ~40),
  `docs/VPS_MIGRATION_PLAN.md` (no ceilings on a VPS; VPN launcher has no server equivalent yet).

Existing tests covering these gates (all read; none executed here for the reason above):

- `tests/job-adapters.test.ts` — VPN tier pin (`jobs.ch`, `jobup.ch`, `jobscout24.ch`,
  `undutchables.nl` are `restricted`; IamExpat is `grey-area` + `adminOnly`), availability
  messages, default mode excludes restricted, relaxed extraction confined to its JSON-LD block.
- `tests/source-access.test.ts` — every restricted source is administrator-only; ordinary-open
  set pinned to `ats-ch/nl`, `eures-ch/nl`, `freehire-ch/nl`, `job-room.ch`.
- `tests/source-policy.test.ts` — one registry entry per adapter, audience/enabled agreement
  between registry, adapters and the enforced gate.
- `tests/source-policies.test.ts` — ordinary `/sources` contains no `Restricted sites` group.
- `tests/collection-budgets.test.ts` — budget values, refusal vs transient classification,
  ask-once-then-leave-alone behaviour, route-composition pin.
- `tests/admin-discovery-isolation.test.ts` — the five T12 keys by name stay administrator-only
  and the public refresh refuses each; bulk-path and page-fetch second gates.
- `tests/public-admin-isolation.test.ts` — ordinary responses never mention admin sources
  (functional D1 + structural route wiring pins, incl. `visibleSourceReports` in scrape and
  `visibleSearchRuns` in state).
- `tests/jobsch.test.ts`, `tests/page-fetch-rejections.test.ts`, `tests/public-refresh.test.ts`,
  `tests/catalogue-query.test.ts`, `tests/lead-decisions.test.ts`.
- Local harnesses (not run): `scripts/verify-dev-workflow.mjs`, `scripts/verify-admin-actions.mjs`,
  `scripts/verify-selfhosted.mjs`, `scripts/verify-sqlite-import.mjs`,
  `scripts/verify-sqlite-restore.mjs`, `scripts/verify-indeed-workflow.mjs`,
  `scripts/verify-cluster-workflow.mjs`.

Existing check run for this task: targeted `npm test` for the source/isolation files was
attempted and could not start (`npm: command not found` in this worker). No existing check was
re-run; nothing below claims an executed result.

## 2. Hosted decision matrix (the scope-gate input)

Decisions use F4's three values. "Hosted" means either current production (Cloudflare Worker,
single admin) or the planned VPS (Node + SQLite); the per-row notes call out where they differ.
Default posture is closed: a source is `blocked` on hosted until its stated configuration exists
and the owner has reviewed it — never silently supported.

| Source | Hosted decision | Exact reason / configuration needed |
|---|---|---|
| `jobs.ch` | **Blocked** — configuration needed before any hosted run | `against-terms`: JobCloud terms prohibit automation **and** `robots.txt` disallows the detail pages read (`SOURCE_POLICY.md` §3; registry basis). Retained at the owner's explicit instruction for **local** administrator + VPN only. Hosted has no equivalent of the `dev:private` full-tunnel check, and a server IP (Worker or VPS) would present shared/production egress to a site that already disallows the pages. Needs: explicit owner hosted-exception, a defined hosted egress (what replaces the VPN launcher on a server), and unchanged caps/delays/refusal handling. Without all three it stays blocked. |
| `jobup.ch` | **Blocked** — configuration needed before any hosted run | Same JobCloud terms prohibition (its `robots.txt` does not additionally disallow the detail pages, but the terms bar stands). Same local-admin + VPN-only retention (#32; six English-confirmed jobs justify the local workflow, not expansion). Same three needs as jobs.ch. |
| `jobscout24.ch` | **Blocked** — configuration needed; weakest case for any exception | Same JobCloud terms bar, kept **on probation** sharing the JobCloud adapter and VPN boundary, with **zero measured yield** (#32). A hosted exception for the other two does not automatically extend here; recommend the owner explicitly exclude it from hosted scope even if jobs.ch/jobup.ch are excepted. |
| `iamexpat.nl` | **Configuration needed** — supportable; not yet supported | The only candidate for hosted support: `grey-area`, paths read are outside the `robots.txt` disallow list, published `Crawl-delay: 1` honoured by the 1200 ms adapter delay; no VPN required by policy (`job-adapters.test.ts` pins this). Still **administrator-only** with **unresolved** permission (no explicit grant; general site terms unreviewed — `source-policies.ts`). Needs before hosted use: owner review of the unresolved standing, confirmation that the same caps (4/run/source, 800/run), 1200 ms delays and stop-on-block apply unchanged on the host (they do — runtime-agnostic code), and confirmation it stays manual, unauthenticated, admin-only, with truthful per-run status. No egress change needed. |
| `undutchables.nl` | **Blocked** — configuration needed before any hosted run | Robots permits the plain `/vacancies` + detail paths used, but the site **previously returned HTTP 403 to automation**, so policy keeps a **precautionary VPN gate** (`SOURCE_POLICY.md` §3; registry basis). Running hosted without a VPN equivalent would violate the source's own precautionary boundary. Needs: same three as the JobCloud rows (owner hosted-exception, hosted egress definition, unchanged caps/delays/refusal), plus stop-on-next-block treated as a stop signal, never a reason to adapt. |

Net for the scope gate: **none of the five is supported on hosted today**. One (`iamexpat.nl`) is
supportable with a light configuration review; four require a VPN-equivalent plus an explicit
owner exception; one of the four (`jobscout24.ch`) should be excluded even then. Full parity of
the administrator workflow on the host is therefore **not achievable within existing boundaries** —
the gate question in §7 must be answered before T14. Do not substitute the IamExpat-only subset
silently or claim parity.

## 3. Gate-by-gate assessment against F4's acceptance criteria

1. **Hosted decision per administrator adapter.** Done in §2 for the five T12 sources. Out of
   T12 scope but noted for the reviewer: Adzuna/Careerjet already carry explicit hosted rules
   (Adzuna needs keys; Careerjet credentials stay unset on hosted — `job-adapters.ts`
   availability messages, `.dev.vars.example`, `DEPLOY.md`); Indeed is §5.
2. **Server-side administrator authorization over trigger, results, URLs, counts, history and
   discovery.** Holds in code for all five: trigger gated in `scrape/route.ts` (session + admin
   + VPN mode); live results filtered by `visibleSourceReports`; stored jobs, counts, run history
   and URLs filtered server-side in `state/route.ts` (SQL predicates + `visibleSearchRuns`,
   `#preview=user` admin-only); discovery filtered by `sourcePoliciesForRole`; the `#188`
   canonical-URL leak class is fixed by reading the account's own row. Pinned by
   `public-admin-isolation`, `admin-discovery-isolation`, `source-access`, `source-policy` and
   `catalogue-query` tests. No new authorization work was found missing; hosted work must not
   weaken any of these (in particular, per-run statuses for blocked sources must stay
   administrator-visible only).
3. **Explicit hosted configuration, fixed caps/delays, refusal/cooldown; VPN absence cannot
   silently succeed.** The caps/delays/refusal machinery is runtime-agnostic and therefore
   travels to the host unchanged: 1200 ms inter-request delay, 4 detail attempts per
   page-fetching source per run, 800 whole-run ceiling, `isAccessRefusal` stop-on-block with no
   retry/rotation/fallback. VPN absence cannot silently produce success today: `mode: 'all'`
   without `VPN_ENFORCED` is refused with 409 before any source is contacted, and restricted
   adapters never run in the default `authorized` mode. Two hosted gaps found: (a) **no durable
   cooldown** for these five — refusal latches per-run in memory only, so the next manual click
   re-asks (acceptable for a manually triggered flow, but the owner should confirm); (b) **no
   hosted VPN equivalent exists** — the launcher scripts verify a local tunnel and have no
   server counterpart, so §2's four blocked rows cannot run on hosted at all until an egress is
   defined. IamExpat needs no egress change.
4. **Indeed's local experimental exception is not generalized.** Holds: Indeed adapters are
   `access: 'local-experiment'`, `availability: 'disabled'`, `adminOnly`, `experimentalIndeed`
   (`job-adapters.ts`); collection additionally requires `INDEED_ENABLED`, `INDEED_LOCAL_ONLY` +
   loopback (`isLoopbackRequest`), and the approved app-identity flag (`db/runtime.ts`
   `indeedConfiguration`); `DEPLOY.md` forbids copying Indeed credentials to prod; the mobile
   header profile is owner-approved local-experiment scope only (`INDEED_TESTING.md`). Nothing in
   the five T12 adapters shares this path (`experimentalIndeed` absent; unauthenticated plain
   `fetch`). Hosted work must require a separate source-specific decision before any hosted
   Indeed implementation — this assessment grants none.
5. **Phone-triggered collection continues on the host; results inspectable later.** Mechanism
   holds in code: `POST /api/scrape` is an authenticated same-origin route (phone browser
   identical to desktop; `job-radar.tsx` exposes `Search all — VPN on` to admins), progress
   streams as NDJSON, and everything found is persisted (`jobs`, `search_runs`,
   `search_run_sources`) for later `GET /api/state` reads — no local collector process is
   involved. Caveat for hosted: on the current Worker the full click also fights the
   per-invocation ceilings (§4); on the VPS the mechanism is sound provided the source is one
   §2 clears. IamExpat is the only row clearable without new egress.
6. **No evasion, proxy rotation, challenge bypass, login automation or higher volume.**
   Introduces none and needs none: `fetchHtml` uses a standard browser User-Agent (not spoofed),
   fixed delays, hard caps; refusal paths contain no fallback (`budgets.markBlocked` + break,
   comments explicitly forbidding rotation/browser paths); no adapter authenticates; this
   assessment changes no cap, delay, volume or identity behaviour. Any T14 implementation must
   keep it that way; a block is a stop signal.

## 4. Hosted-environment notes (Worker vs VPS)

- **Cloudflare Worker (current production).** Two independent bars: (a) policy — §2's four
  blocked rows; (b) mechanism — `VPN_ENFORCED` cannot be satisfied (no tunnel launcher on
  Workers), and the full-click fan-out (~700 requests incl. 282 ATS boards) exceeds the Workers
  Free per-invocation ceilings (50 subrequests, 10 ms CPU) per `HOSTING_COST_ANALYSIS.md`. The
  five sources' own subset (~40 requests) would fit the subrequest ceiling, but the click fans
  out to every enabled admin adapter at once, so partial reasoning does not rescue it; Paid
  removes the ceilings but not the policy bars. `isRuntimeBudgetExhausted` keeps a ceiling
  exhaustion truthfully reported as incomplete rather than as a source refusal.
- **VPS (planned, Node + SQLite).** No subrequest/CPU ceilings; the caps/delays/refusal code
  runs identically behind the `D1Database` SQLite adapter (#195). The bar that remains is
  policy + egress: the VPN launcher is a local-machine construct (Windows/macOS scripts), so a
  hosted egress (whatever replaces it — still an owner decision, not this assessment) must be
  defined before any of the four blocked rows runs there. Secrets move to a root-owned
  `EnvironmentFile`, never the repo.
- Either way, Careerjet-style credentialed sources stay unset on hosted, and Indeed stays
  disabled/loopback — those existing rules are the template for "configuration needed" done
  properly.

## 5. Indeed boundary (for the record)

The local Indeed experiment (`INDEED_TESTING.md`, `lib/indeed/*`, `scripts/indeed*.mjs`,
`app/api/admin/indeed/*`) is loopback-administrator-only, disabled by default, with its own
caps (200 rows/role/country, 800/click), 60 s cooldown, durable pause on refusal, and no
automatic retry/rotation. None of its machinery (identity profile, query checkpoint, coverage
store) is shared with the five T12 adapters, and none of §2's decisions relies on or extends
it. Assessed separately; no hosted Indeed work is implied.

## 6. Caps / delays / refusal reference (current code — do not raise)

| Control | Value | Location |
|---|---|---|
| Inter-request delay, page-fetch adapters | 1200 ms (terms + detail loop) | `lib/job-adapters.ts`, `app/api/scrape/route.ts` |
| `lib/jobsch.ts` exported delay | 1500 ms (legacy helper export) | `lib/jobsch.ts` |
| Detail attempts per page-fetch source per run | 4 | `lib/collection-budgets.ts` `MAX_NEW_PER_PAGE_SOURCE` |
| Whole-run attempt ceiling | 800 | `lib/collection-budgets.ts` `MAX_NEW_PER_RUN` |
| Search pages | first results page only (`RESULTS_PAGE = 1`) | `lib/jobsch.ts` |
| Refusal signal | 401/403/429/451 + refusal wording → per-run block, no retry | `isAccessRefusal`, `CollectionRunBudgets` |
| Runtime-exhaustion signal (kept separate) | subrequest/CPU wording → incomplete, never blocked | `isRuntimeBudgetExhausted` |
| Trigger rate limit | 6 searches / 10 min per account | `app/api/scrape/route.ts` |
| IamExpat crawl-delay compliance | 1200 ms ≥ published `Crawl-delay: 1` | adapter delay vs `iamexpat.nl/robots.txt` (per `source-policies.ts`) |

## 7. Scope-gate questions for the owner (do not proceed to T14 without answers)

1. Is any hosted exception acceptable for the three JobCloud rows, given the terms + (for
   jobs.ch) robots bars are knowingly against use? If yes, which rows — all three, or only
   jobs.ch/jobup.ch with measured yield (excluding probationary JobScout24)?
2. What is the hosted egress for VPN-gated rows — i.e. what replaces `dev:private`'s verified
   full-tunnel check on a server, or is the answer "these rows never run hosted"?
3. Is IamExpat's `unresolved` standing acceptable for hosted administrator use (light review),
   or must explicit permission / full site-terms review come first?
4. For Undutchables, does the prior-403 precautionary VPN gate stay absolute on hosted (any
   hosted run needs the §2 egress), and is the next block a retirement trigger?
5. Is per-run-only refusal memory (no durable cooldown) acceptable for hosted manual
   collection of these rows, or must a hosted implementation add durable cooldown before T14?
6. Confirm no hosted Indeed work is implied by any answer above (source-specific decision stays
   separate).

## 8. Reproducible verification

New in this assessment (synthetic, no network, no secrets):

- `tests/hosted-source-assessment.test.ts` — pins §2's matrix and §3's gates: access tiers,
  admin-only standing, availability messages, credentialless page-fetch shape, caps/delays,
  refusal-vs-transient classification, public-refresh refusal of all five, Indeed isolation,
  and the structural wiring (scrape VPN/admin gating, state/discovery filtering).

Reviewer commands (require the normal toolchain, absent in this worker):

```text
npm test -- tests/hosted-source-assessment.test.ts
npm test -- tests/job-adapters.test.ts tests/source-access.test.ts tests/source-policy.test.ts \
  tests/source-policies.test.ts tests/collection-budgets.test.ts \
  tests/admin-discovery-isolation.test.ts tests/public-admin-isolation.test.ts
npm run lint
npm run typecheck
npm run build
```

Passing the full `npm test` (555 tests at the last green gate) plus lint/typecheck/build remains
the merge gate; this assessment adds one file to it and changes no behaviour.

## 9. What was not done

- No adapter, route, policy, cap, delay, message or schema change; no live request; no hosted
  run; no credential handling.
- No owner question answered on the owner's behalf; no source silently substituted or dropped.
- Test execution itself is outstanding for the toolchain reason in §1 — recorded here rather
  than implied.
