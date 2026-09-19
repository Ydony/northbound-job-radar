# Indeed integration: shared work agreement

Created 2026-09-18. Execution status is on [Project 4](https://github.com/users/Ydony/projects/4).
Parent: [#63](https://github.com/Ydony/northbound-job-radar/issues/63).
Milestone: [Local administrator Indeed integration](https://github.com/Ydony/northbound-job-radar/milestone/9).

The standalone PC connector now retrieves description-bearing jobs from both NL and CH;
two one-result Dutch pages were live-verified. The dashboard's `indeed-ch` and `indeed-nl`
adapters remain disabled placeholders: transport success is not completed application integration.
No personal OAuth/session is needed for the tested app-key/header profile. Key lifetime,
large-volume reliability and description completeness against the original advertisement remain
unverified. There is no evidence of unlimited requests or public reuse entitlement.

## Current implementation and live evidence — 2026-09-19

After Codex specifically asked whether to allow JobSpy's mobile-identification headers, the
owner instructed Codex to proceed. This is a narrow local/admin experiment exception, not a
policy change for other sources. Certificate verification remained enabled; no phone, personal
cookie, OAuth token, proxy setup, challenge-solving, IP rotation or redirect was used.

- The one-result header-profile probe returned HTTP 200, no GraphQL errors, an NL job,
  a next-page cursor and 7,534 characters of description HTML.
- The actual `lib/indeed/client.ts` then made three bounded requests: two Dutch pages
  (two distinct jobs; descriptions 7,534 and 3,954 chars), then one Swiss page
  (one CH job; 12,457 chars). All had title, employer and numeric posting date. The
  returned country matched each query. Searches stopped at the explicit test budget with
  `outcome=partial`, `reason=budget_exhausted`, `hasMore=true`; this is not a provider error.
- Earlier refusal-only checkpoints below are historical. The changed header profile was
  accepted in this sample, but that does not prove which individual header was decisive.

### Implemented files and downstream contract

- `lib/indeed/contracts.ts`: version 1 transport types; NL/CH input, explicit budgets,
  records and structured outcomes. This is now the interface for downstream workers.
- `lib/indeed/auth.ts`: trusted local/admin/experiment gates and validated explicit config.
  No real key, app profile, cookie or phone artifact is bundled in the public repository.
- `lib/indeed/client.ts`: fixed HTTPS destination, no redirects, omitted browser cookies,
  20-second request timeout, 2 MB response limit, fixed 500 ms inter-page delay,
  escaped query inputs/cursors, schema checks, cross-country rejection, duplicate counting,
  bounded paging and preservation of earlier results when a later page fails.
- Access refusal is latched per client instance. HTTP/GraphQL rate-limit outcomes return
  cooldown information and do not retry automatically. No personal OAuth refresh is
  implemented or needed by this tested profile. A rejected key requires an explicit
  configuration/review action; do not rotate identities automatically.
- Defaults: one request, 25 jobs. Hard configurable ceilings: four requests, 100 jobs/page,
  400 jobs. These are safety limits, **not** measured yield or a claim that 400 jobs work.
- `tests/indeed-client.test.ts`: synthetic transport tests, including refusal/cooldown,
  redirect protection, secret redaction, pagination, duplicates, timeout and cancellation.

Call `createIndeedClient({ access, credentials })`, then `search(input)`. Credentials are an
app key plus the approved User-Agent/app-info profile, provided only by trusted backend
configuration. No arbitrary endpoint can be supplied. Do not serialize credentials into
page props, account state, job results, exports or errors. The caller must revalidate the
current authenticated administrator and local environment on **every** user-triggered search;
the client's defensive flags are not a replacement for `requireSession` or revocation checks.

Records preserve `descriptionHtml` with `descriptionEvidence=api-description-field`, but
`completeness=unknown`. HTML length does not by itself prove the source has returned an
entire advertisement. #66 must establish that interpretation and preserve requirements before
promoting anything into the English-confirmed pool. Dates remain nullable; country comes from
the response. No apply URL is accepted or constructed in this layer; #66 owns safe normalization.

### Still not delivered

No dashboard route, database write, source registry, environment wiring, real-account use,
export or source-policy page was changed. #66 normalization, #67 server-side integration and
account isolation, #68 reporting and #69 end-to-end QA still apply. Runtime access control
and saved/dismissed-state preservation have not been exercised for Indeed in dev/test because
the connector is not wired into those routes yet. No owner server restart/promotion occurred.

The private verification scripts and sanitized evidence remain outside Git. Tests, lint,
typecheck and build must be rerun on the final integration. Public terms/permission and
long-term key/profile validity remain separate from this small technical success.

## Scope and responsibility

The owner explicitly assigned **Codex** to build the authentication and connection. The owner
reports Indeed authorization for the assessment. Record this as owner-reported scope; do not
describe it as independently verified partner access, unrestricted quotas or public reuse rights.

The target is a manually triggered experiment for local administrators. Public users, public
hosting, scheduling, applications, password automation and changes to other source policies are
outside this work. Existing private dev/test storage remains separate. Do not restart the owner's
stable test server or reset its data while preparing or implementing a worker task.

Codex alone handles phone/API research, actual credentials, connection testing, and the auth/client
modules. APKs, captures, device identifiers, tokens and private vulnerability reports stay in the
existing local research area outside Git. Other LLMs use sanitized contracts and synthetic data.
Do not send these private artifacts to a public/contributor model route or attach them to issues.

## Work packages and file ownership

| Task | Responsible worker | Owns | Dependencies |
|---|---|---|---|
| [#64 / IND-01](https://github.com/Ydony/northbound-job-radar/issues/64): request/auth contract | **Codex, claimed** | This document, proposed `lib/indeed/contracts.ts`, synthetic transport fixtures, private request evidence | None |
| [#65 / IND-02](https://github.com/Ydony/northbound-job-radar/issues/65): authentication and connection | **Codex, reserved in the same run** | Proposed `lib/indeed/auth.ts`, `client.ts`, focused auth/client tests | #64 |
| [#66 / IND-03](https://github.com/Ydony/northbound-job-radar/issues/66): job normalization | Available to another LLM | Proposed `lib/indeed/normalize.ts`, parser tests and synthetic parser fixtures | #64 |
| [#67 / IND-04](https://github.com/Ydony/northbound-job-radar/issues/67): search and account integration | Available to one integration LLM | Shared registry, search route, identity, environment wiring, source policy and server read/export gates | #65 **and** #66 |
| [#68 / IND-05](https://github.com/Ydony/northbound-job-radar/issues/68): admin reporting | Available to another LLM | Focused admin component, presentation edits, UI tests | #64 for development; #67 for final integration |
| [#69 / IND-06](https://github.com/Ydony/northbound-job-radar/issues/69): independent QA and operator handoff | Independent reviewer | Verification scripts/tests, proposed `docs/INDEED_TESTING.md`, acceptance evidence | #67 **and** #68 |

The auth/client/contract paths above are implemented; the other paths remain proposed. Check the board and current Git state
before claiming work. There are other open dashboard/UX and employer-source tasks; ownership here
does not supersede their claims. Negotiate shared paths before editing. The integration worker is
the only Indeed worker to change `lib/job-adapters.ts`, `app/api/scrape/route.ts`, shared credential
types and runtime environment loading. Auth implementation passes configuration through its own
interface and does not make competing changes to those shared files.

Execution order:

```text
#64 Codex: actual request proof and frozen sanitized contract
  +-- #65 Codex: auth and connection ----+
  +-- #66 other LLM: normalization -----+--> #67 integration --+
  +-- #68 other LLM: admin UI --------------------------------+--> #69 acceptance
```

Task creation and the first standalone connector are implemented. Application integration is not. No other worker has been dispatched to implement
these tasks. Claim one in the board/PM system before editing, with a named isolated worktree and
pinned base. Never use the similarly named legacy Documents folder.

Codex's active assignment is:

- PM feature: `indeed-auth-connection`; tasks #64 and #65.
- Run: `ajh-indeed-auth-connection-20260918-171415-590073`.
- Worktree: `C:/Projects/AI team and PM Tools/worker-worktrees/ajh-indeed-auth-connection-20260918-171415-590073`.
- The first deliverable is the evidence-backed contract; client completion follows it.

## Phone collection checkpoint - 2026-09-18

The authorized USB connection was rechecked. All three locally saved APK components (base,
ARM64 and display resources) were compared with the installed files using SHA-256; every copy
matched. Native libraries and the packaged JavaScript bundle are available for offline inspection.
No further phone connection is needed for that static-analysis pass. The owner was told they may
disconnect and restore USB debugging/Auto Blocker settings.

The app was not running during this check. No live search, traffic capture, account-token extraction
or authentication validation occurred. A later dynamic test may require reconnecting the phone;
whether the final connector needs a device is still unknown. This checkpoint does not complete #64.

## 2026-09-19 authentication investigation checkpoint

The goal is an independent PC search/full-description client, not a phone-screen
scraper. Further static inspection located separate app identification and
session-derived bearer-token handling, including a renewal path. A bundled detail
query selects description text. None of this proves an accepted desktop request,
a portable session, the exact live search contract or full-text completeness.

One earlier bounded desktop request, without account cookies or a bearer token,
returned HTTP 403. No further upstream probes followed. The response does not
establish whether the refusal came from authentication, entitlement or a gateway.
The phone was subsequently connected and the owner reported searching/opening a
job, but the release app exposed no usable auth exchange in its available logs and
no WebView debugging socket. No account tokens or cookies were extracted.

Private findings and endpoint details remain in the local research area outside
Git. The next dynamic evidence needs a provider-supported test build/trace or
provisioned desktop credentials and operation access. Ordinary partner sign-in
must not be represented as permission to retrieve the whole job catalogue.
Tasks #64/#65 remain incomplete; do not unblock dependent integration work or
enable the adapters. No owner servers, saved data or runtime configuration changed.

## 2026-09-19 JobSpy comparison and bounded PC probe

The owner asked to review JobSpy and then try a small desktop search. Review was
pinned to `speedyapply/JobSpy` revision `fda080a373e8226f3fd60635323f5da9af9892b1`.
Its Indeed path sends GraphQL in JSON, reads `description.html` in search results,
and paginates using `nextCursor`. It does not perform personal OAuth. Its static
app key differs from the Android snapshot key. Therefore the earlier suggestion
that a personal OAuth flow is necessarily required was too strong: the inspected
signed-in mobile path is not the only implementation approach.

At 2026-09-19T02:39:02.700Z, one modified JobSpy-style request asked for one Amsterdam
data-analyst job, including its description. Result: HTTP 403, non-JSON, 4,551
response bytes. No job data was obtained, no retries or redirects followed, and no
OAuth/cookies, phone access, proxy setup or owner-workspace data was used.

This was **not an equivalent test of unmodified JobSpy**. It used the pinned
source's app key and compatible query fields, but retained TLS verification and a
truthful project User-Agent; it omitted the headers claiming to be an iPhone Indeed
app. Those identities conflict with the existing no-disguise boundary. Do not
silently introduce them or describe this result as proof that JobSpy cannot work.
No challenge header or recognized challenge markup was detected; that does not
identify the cause of refusal or exclude other gateway restrictions.

The private probe persists only sanitized evidence outside Git and refuses an
accidental repeat. No source was enabled. #64/#65 and live description retrieval
remain incomplete. Further testing needs a specific scope decision or provider
assistance rather than blind request variations. The earlier phone-auth checkpoint
is historical and must not be used as proof that OAuth is mandatory.

## Contract checkpoint

**Contract revision 1: standalone transport interface established.** See the current checkpoint
and `lib/indeed/contracts.ts`. Downstream workers must not invent upstream fields, OAuth grants,
refresh flows, or a full-description guarantee. Search responses already carry HTML; a separate
detail request was not needed for the observed records. Keep actual credential evidence private;
publish only the interface needed by workers.

The versioned interface must describe:

- Search country, keywords/location, page or cursor, cancellation, request/detail budget.
- Stable job identity, source and application links, employer, location/country evidence,
  original posting date, description format and `full / teaser / unknown` completeness.
- Authentication/configuration readiness, observed expiry/renewal behavior, disconnect semantics
  and whether a connected phone is still needed. Names alone do not prove an authentication flow.
- Safe outcomes for missing configuration, expired/rejected authentication, refusal, cooldown,
  timeout, invalid response, partial coverage and successful empty results.
- A separate evidence marker distinguishing synthetic fixtures, observed live behavior and
  unverified behavior. Mock success is never proof of a working upstream connection.

Existing `searchDetailed` returns `ParsedJob[]`; `ParsedJob` does not currently carry completeness,
country or structured partial-response metadata. The integration worker must bridge those gaps
explicitly. It must not discard a teaser marker and feed long incomplete text into a false pass.
The current `restricted` access category also imposes a VPN gate; preserve it until Codex records
an evidence-based classification decision. Administrator-only and local-only are separate gates.

## Acceptance and handoff

Begin live validation with one search and one detail request in the approved scope. Further requests
need a bounded purpose. Use fixtures for failure, rate-limit and refusal testing. Honor observed
limits and Retry-After; stop on refusal and challenges. No traffic disguise, pinning bypass, proxy
rotation, load testing or attempts to access other users' private data are in this plan.

The connection must keep credentials on the backend and redact errors. Only approved fixed HTTPS
destinations may receive them; redirects must not leak authorization. The normalizer must preserve
requirement text, reject unsafe links, keep absent dates absent and provide country evidence.

Prove administrator access, ordinary-user denial, cross-account isolation, exports, safe history,
source aliases, mixed-source duplicates and role demotion with synthetic accounts. Preserve saved,
applied, dismissed, correction and tombstone state across repeat imports. Reuse the strict language
gate and existing country/source dashboards. Never claim a target of 200-400 jobs was met without
measuring it, or claim unlimited access from a small sample.

Final review requires the relevant automated checks and affected flows in isolated dev and the
built local test runtime. Record fixture-only and live evidence separately, including unsupported
countries or incomplete fields. Keep private security findings in the research area; the operator
handoff should describe setup, expiry, disconnect, troubleshooting and restoration of temporary
phone settings. Stable-test promotion occurs only after review and a coordinated restart.
