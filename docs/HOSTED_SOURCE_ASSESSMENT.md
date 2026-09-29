# Hosted source assessment (T13, for the F4 owner review gate)

Assessed 2026-09-29 from the code, tests, and policy documents in this checkout. No live
upstream requests were made, no credentials were read, and this document contains **variable
names only, never values**. The scope gate between T12/T13 and T14 stays closed until the
owner reviews the matrix below: if every requested source cannot work remotely within the
existing boundaries, the owner picks which explicit exceptions release scope. Nothing here
enables a source on the host.

Code counterpart: `lib/hosted-sources.ts` holds the same matrix where tests can pin it;
`tests/hosted-source-assessment.test.ts` enforces it with synthetic fixtures. If this document
and the code disagree, the code plus its test is what runs — update both in the same change.

## 1. Hosted decision per administrator-side source

| Source | Hosted decision | Credentials (names only) | Site / IP requirements | Exact reason |
|---|---|---|---|---|
| Adzuna CH/NL | Configuration needed | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | None: no registered site, Referer, declared IP, or per-request user-IP requirement | Keyed API usable from any egress IP within the provider limits (25 requests/minute, 250/day). Without both values the source reports `unavailable`, never silent success. Teasers cannot confirm English, so it stays administrator measurement even when configured. |
| Careerjet CH/NL | Blocked | `CAREERJET_API_KEY`, `CAREERJET_REFERER`, `CAREERJET_USER_IP` | One registered publisher site per key; Referer must be a triggering page on that site; every query must carry the real end-user IP and user agent; account-level declared-IP constraint; current registration unresolved | A server egress IP — especially for phone-triggered runs — cannot stand in for the per-request real-user IP. Leave all three `CAREERJET_*` values unset in every hosted environment. Local administrator discovery only. |
| jobs.ch, jobup.ch, JobScout24 | Blocked | None exist | VPN-only local boundary, which a host cannot satisfy | JobCloud terms prohibit automation (jobs.ch robots.txt additionally disallows the detail pages read). Retained for local administrators behind a verified VPN at the owner's explicit instruction. Written permission or an authorized feed first. |
| IamExpat | Blocked | None | No key or IP binding; the constraint is the missing explicit permission | Paths read sit outside the robots.txt disallow list and the crawl delay is honoured, but there is no explicit permission and the general site terms are unreviewed. Local administrator only is not hosted clearance. |
| Undutchables | Blocked | None | Precautionary VPN gate after prior HTTP 403 to automation | Must stop on any block rather than work around it; hosted datacenter egress is the traffic most likely to be blocked again. |
| Indeed CH/NL | Blocked | `INDEED_ENABLED`, `INDEED_LOCAL_ONLY`, `INDEED_APP_IDENTITY_APPROVED`, `INDEED_API_KEY`, `INDEED_USER_AGENT`, `INDEED_APP_INFO` | Local loopback execution only, administrator account, explicitly approved identity — none satisfiable from hosted production, by design | See §2. A source-specific owner decision is required before any hosted implementation. |
| Nationale Vacaturebank | Blocked | None | No authorized feed; HTTP 403 to automation | Nothing to configure on the host until an authorized route exists. |
| I amsterdam | Blocked | None | Not a feed | Never a collection source on any environment. |

Net position for the gate: **no administrator source is `supported` on the host today.** Adzuna
alone is one explicit key configuration away; everything else needs either written permission, a
terms review, an authorized feed, or a source-specific Indeed decision. Do not substitute a
smaller source set or claim parity without the owner saying so.

## 2. Indeed's separate local boundary (not to be generalized)

Indeed is a loopback administrator experiment, and the code keeps it there through four
independent conditions that all must hold (`db/runtime.ts` `indeedConfiguration`,
`lib/indeed/auth.ts` `indeedReadiness`):

1. `INDEED_ENABLED=true` — disabled by default;
2. `INDEED_LOCAL_ONLY=true` **and** the request origin is loopback (`localhost`, `127.0.0.1`,
   `[::1]`) — a hosted request fails this even with every other flag set;
3. a current administrator session — `POST /api/scrape` with `sourceGroup: 'indeed'` answers
   403 to anyone else, and ordinary accounts never receive Indeed rows, names, counts, or run
   history (`lib/job-adapters.ts` `isHiddenSourceForRole`, `lib/server-data.ts`
   `visibleSourceReports`);
4. the explicitly approved identity (`INDEED_APP_IDENTITY_APPROVED=true`) plus a well-formed
   credential shape — the owner-reported authorisation this identity rests on covers their own
   local assessment and is unverified here; it establishes no redistribution licence.

Anything else resolves to `disabled`, `denied`, or `not_configured`, and collection returns
`disabled`/`unavailable`/`blocked` without sending an upstream request. The refusal latch
(pause on 401/403/redirect/malformed), the shared-lease single-runner, the 60-second cooldown
(escalating on provider Retry-After), fixed 200-rows-per-query / 800-rows-per-click ceilings,
and the no-retry / no-rotation rules travel with the local experiment and are not hosted
clearance either.

## 3. Why VPN absence cannot silently produce misleading success

- `POST /api/scrape` refuses mode `all` without `VPN_ENFORCED=true` (HTTP 409), so the
  restricted adapters never run unannounced from the host.
- Adzuna/Careerjet without credentials report `unavailable` with setup instructions; a missing
  key never fails a run and never reads as searched.
- Refusals (HTTP 401/403/429/451 or matching wording) mark the source blocked for the rest of
  that run: no retry, no proxy rotation, no browser fallback (`lib/collection-budgets.ts`).
  Invocation-budget exhaustion (#192) is deliberately *not* a refusal and never latches a
  working source as blocked.
- Caps and delays are fixed: 4 new detail pages per page-fetching source per run, 200 per bulk
  source, 800 per run, 1.2 s between page requests, per-account search rate limits
  (6 per 10 minutes), Indeed 200/800 with lease and cooldown. None is raised for hosted use.
- `GET /api/health` spends one real Adzuna/Careerjet request per check and is therefore
  administrator-only and rate-limited (5 per 10 minutes). It returns statuses and the
  public/declared IP comparison — never credential values.

## 4. Server-side authorization covering the F4 surface (evidence, not claims)

Trigger, results, URLs, counts, history, and discovery are gated in the API, not the
interface: `requireSession` with `adminOnly` on `/api/health` and the `sourceGroup: 'indeed'`
refusal plus `all`-mode refusal in `/api/scrape`; `adminOnlySourceKeys` plus URL re-resolution
in the jobs read path so legacy mis-keyed rows (notably `jobviewtrack.com`) stay hidden;
`visibleSourceReports` filtering the live report and stored history identically;
`sourcePoliciesForRole` withholding restricted and admin-only sources from `/sources` for
ordinary accounts; `GET`/`PUT /api/admin/indeed/settings` answering 403 to ordinary accounts.
Pinned by `tests/source-access.test.ts`, `tests/admin-discovery-isolation.test.ts`,
`tests/public-admin-isolation.test.ts`, and `scripts/verify-admin-actions.mjs` on synthetic
accounts.

## 5. Owner review checklist (the gate)

- [ ] Confirm or correct each row of §1 before any T14 implementation work.
- [ ] If Adzuna is wanted on the host, say so explicitly so keys are set as hosted
  configuration under the caps in §3 — no other row changes with that decision.
- [ ] Record any Careerjet re-registration, JobCloud permission, IamExpat terms review, or
  Indeed hosted decision as its own bounded task; none is approved by this assessment.
- [ ] Phone-triggered collection of administrator sources stays out of hosted scope until the
  matrix above is approved: Careerjet's per-request real-IP rule and Indeed's loopback rule
  both fail from a phone-triggered hosted run today.

No evasion, proxy rotation, challenge bypass, login automation, or higher collection volume is
introduced or proposed by this assessment.
