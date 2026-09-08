# Public and administrator job-source integration plan

Written: 2026-09-07. Status: recommended design and task specifications; not implemented.

This records the owner's latest direction: offer a free public job-search service for the
Netherlands and Switzerland, while retaining a separate administrator search covering sources
with uncertain or restrictive terms. English-language advertisements where English alone is
sufficient remain the product's purpose. LinkedIn remains excluded.

The current supported runtime is still local dev and test. This document does not mean hosting,
source permissions, new adapters, schedules or access-control changes have been completed.
Do not stop either running server for documentation work.

Execution status belongs on the [GitHub project board](https://github.com/users/Ydony/projects/1).
The task IDs below identify specifications and dependencies, not a second open/closed tracker.
Reuse linked existing issues; create missing issues when implementation is taken up.

## 1. Accepted direction and assumptions

- Public users receive results only from sources whose intended public use is permitted, including
  any required publisher registration, attribution and retention conditions.
- Sources with uncertain or prohibitive terms are administrator-only under the owner's accepted
  risk. Record the actual policy as `unresolved` or `against-terms`; do not relabel it as permission.
- The owner instructed us to **assume permission for UWV/werk.nl and Job-Room/SECO**. Use that
  assumption in this design, separately from verified written permission. Permission does not
  supply an endpoint, credentials, unlimited requests, or a redistribution licence for other feeds.
- No zero-IP-blocking guarantee is possible. Stop requests when a source refuses access; do not
  use retries, proxy rotation or a browser to get around a block.
- Public catalogue refresh is recommended as a bounded scheduled service. Restricted/admin
  discovery remains manually triggered. No schedule is installed by this plan.
- Keep CV upload/scoring shelved for this release, as specified in `MVP.md`. Existing private CV
  data remains protected. Do not introduce auto-application, source-site login, or new branding.
- Hosting is future work: use the owner's domain, with no ChatGPT branding or login. Preserve
  local dev/test independence and do not publish local accounts, CVs or administrator results.

## 2. Recommended source allocation

This is the target allocation, not the current registry. Public eligibility, policy evidence,
technical availability and scheduling permission are separate properties.

| Source | Target audience | Integration decision |
|---|---|---|
| Greenhouse, Lever, Ashby, Recruitee, Personio employer boards | Public, subject to applicable feed permissions | Retain the existing adapters and verify the 61-board list; expand only with working feeds and recorded reuse conditions. An unauthenticated endpoint alone is not permission. |
| Adzuna CH/NL | Public under publisher terms | Keep keyed API; implement required attribution and shared quota accounting. Treat teaser descriptions as incomplete evidence. |
| Job-Room/SECO CH | Public under owner-assumed permission | Reuse the existing search/detail adapter; validate read access, paging, fields and sustainable volume. Published employer API is a different interface. |
| UWV/werk.nl NL | Public under owner-assumed permission, technically unavailable pending a feed | Obtain actual retrieval documentation/credentials or an export. Do not invent an API or count this as enabled. |
| FreeHire CH/NL | Public candidate | Prefer the documented full-description API. Confirm public display/cache conditions and record upstream sources; enable an eligible source allowlist, not the entire unreviewed catalogue. |
| Jooble CH/NL | Public candidate | Obtain publisher key and test full-text quality, paging, coverage and terms before adding. |
| Careerjet CH/NL | Admin for now; possible public later | Correct registered website and declared-IP configuration, and confirm publisher scope before promotion. Keep short descriptions in unknown/review. |
| EURES CH/NL | **Superseded — public, see [SOURCE_POLICY.md](SOURCE_POLICY.md) §2** | This row said vacancy terms restrict extraction to recognized partners. Checked 2026-09-07 against the EURES legal notice, the partner-membership page and the portal footer: no such restriction exists, and "EURES partner" is a membership status for employment-services organisations, not a data-access tier. The real constraint is that advertisement text is a third-party work, so it may be read and screened but not republished — which the public tier handles by showing facts and a link rather than the employer's text. ELA attribution is required and is still outstanding. |
| jobs.ch, jobup.ch, JobScout24 | Admin-only | Retain bounded manual adapters and record explicit automation restrictions. Do not increase page-fetch caps simply to meet a volume target. |
| IamExpat, Undutchables | Admin-only | Keep unresolved/restricted classifications and truthful availability; stop on blocking. |
| Indeed CH/NL, Nationale Vacaturebank | Disabled/unavailable | A source that already refuses requests does not become usable by assigning it to admin. Revisit only when an ordinary supported route becomes available. |
| LinkedIn | Excluded | Research did not reverse the owner's exclusion. No adapter in this iteration. |
| I amsterdam | Not a feed | Keep out of automatic discovery. |

Administrator-only source names, records, counts and links must not appear in public-user responses.
This includes old stored jobs and runs, not just results fetched after the change.

## 3. Architecture and data separation

Retain React/Vinext, Workers-compatible HTTP adapters, D1 and R2. A framework replacement is not
required merely to add feeds. Validate the existing framework's public security needs separately.

Recommended public flow:

1. A bounded collector reads enabled public feeds once per refresh window.
2. It normalizes adverts, records provenance, deduplicates and screens new/changed text.
3. A shared public catalogue serves each user's five role keywords and result filters.
4. Private per-user records store saved/applied/dismissed status, corrections and preferences.

The Search button queries the catalogue and shows its last refresh time. It must not fan out to
all upstream sources for every visitor. An expired cache may queue one coalesced refresh where
permitted; return available results and disclose freshness rather than launching duplicate runs.

Administrator flow: a separately authorized manual run reads admin sources into a private
administrator store. Recommended initial deployment is a local admin collector with its existing
VPN launcher, while public collection uses a separate process/service and egress. Never run admin
traffic through the public collector. Separate outbound paths reduce shared-IP exposure but do not
eliminate blocking risk. Defer remote admin collection until its operating environment is specified.

Proposed persistence boundaries (names are design suggestions):

- Public catalogue: vacancy identity, country/place, nullable posting date, description, source
  copy/provenance, content hash, first/last seen, closure status and detector version/evidence.
- Private user state: `(user_id, vacancy_id)` saved/applied/dismissed state, notes if already
  supported, and language corrections. Corrections affect that user only.
- Admin-only jobs and run records: a separate database/store where practical, otherwise explicit
  server-enforced audience and owner constraints. They never enter a public catalogue write path.
- Source policy/configuration: audience, policy status, permission basis, allowed operations,
  attribution/retention rules, availability, budgets, cooldown and last successful refresh.
- Global public ingestion runs and private user search events: separate records and metrics.

Deduplication must not promote admin-only content into the public catalogue. If a public feed
independently supplies the same vacancy, build its public card entirely from that public copy.
Do not enrich its description, language verdict, source list or dates from the restricted copy.
Likewise, restricted provenance must not leak through exports, facets, analytics, caches or errors.

Migration must preserve current saved/applied/dismissed states, aliases and language corrections.
Personal reset/delete removes that user's records, not the shared catalogue or another account's
state. Preserve dismissal tombstones across later imports and source URL changes. Public-source
withdrawal must suppress its records on reads immediately, even before background cleanup.

## 4. Collection limits, quality and reporting

Use fixed per-source concurrency, timeouts, request budgets and daily/monthly quota accounting.
Honor `Retry-After` and provider rules. A 401/403 or challenge pauses the source; a 429 persists its
cooldown and prevents fresh runs from bypassing it. Retry transient network/5xx failures only a
small bounded number of times. Persist run locks/cursors so restarts do not multiply requests.
Use approved APIs normally; a VPN is not permission or a reason to increase volume.

Target a first evaluation of **200-400 distinct adverts per candidate source and country**, only
where supply and permitted quotas support it. This is a measurement target, not a guaranteed count
or a target for restricted page fetching. Current code attempts at most 200 new jobs per bulk
source per run and four per page-fetch source; separate discovery, attempted details and imports
when interpreting those caps.

Do not infer completeness solely from length. Keep the existing minimum-text safeguard, but also
record whether a provider supplied a complete description or a teaser. A long teaser can still
omit a mandatory language. Structured language requirements and title requirements must agree with
the English-ad rule; a German-written advert must not pass solely because metadata names English.
Ambiguity goes to review; incomplete evidence goes to unknown. Never turn absent evidence into pass.

Each source report should distinguish:

- Upstream reported matches (possibly unknown or estimated), records actually retrieved and
  distinct adverts screened.
- Previously known, new, changed, duplicate, imported, deferred and failed records.
- English sufficient, review, unknown and blocked, with percentages using an explicit denominator.
- Last successful refresh, partial coverage/cursor, quota/cooldown and a safe failure reason.

Measure useful coverage as **new unique English-sufficient adverts beyond the existing catalogue**,
not total records fetched. User searches show source freshness and matching catalogue counts; label
them differently from upstream refresh statistics. Job posting dates and first-seen dates remain
separate. Do not expire unseen jobs after a partial or failed refresh.

## 5. Coverage evidence and candidate selection

| Candidate | Evidence as of 2026-09-07 | What still needs measuring |
|---|---|---|
| FreeHire | Read-only API calls reported 10,880 NL and 4,384 CH adverts with `posting_language=en`; page size up to 100, filtered search depth up to 10,000. | Eligible-upstream subset, full-text quality, English-only precision, overlap and net additional matches. These counts cover all roles and are not guaranteed imports. |
| Existing ATS boards | Five supported platforms and 61 configured employers. | Live/dead boards, NL/CH inventory, useful yield after deduplication and cost per refresh. |
| Jooble | Official API advertises displaying results on third-party websites; key required. | Account quotas, country coverage and whether returned descriptions are only snippets. |
| Job-Room | Existing working website search/detail adapter; prior project records describe tens of thousands of Swiss vacancies. | Current total, permitted retrieval route, request cost and sustainable full-text batch size. |
| UWV | No generally available vacancy-download API verified. Historical official response says none was available. | Actual authorized read interface/export, documentation, credentials, fields and current counts. Permission is assumed, delivery is not. |
| OpenPostings | Repository advertises 110,000+ companies globally, not that many NL/CH adverts; no explicit repository licence found in the review. | Obtain code/dataset reuse permission before copying either; no dependable NL/CH yield estimate. Do not integrate the whole local Node/SQLite app. |
| Arbeitnow | Previous project evaluation: 950 adverts, almost no relevant NL/CH coverage. | Defer unless geography expands. |
| JobSpy/JobOps/Apify | Collection software/services, not a grant of rights to source data. | Defer; specific adapters, licences, costs and source rights must be evaluated individually. No volume promise. |

FreeHire is the first new adapter recommendation. National-board work should start early because
external documentation may take time, but must not block FreeHire or existing public-feed work.
Jooble is next only if its sample contributes screenable adverts. OpenPostings is a reference for
ATS discovery, not an approved code or dataset dependency.

## 6. Ordered task specifications

All tasks below are proposed implementation work. Completion and assignments belong on GitHub.

| ID | Task | Depends on | Acceptance / deliverable | Existing issue |
|---|---|---|---|---|
| INT-01 | Consolidate source audience and permission metadata | None | One registry separates public/admin eligibility, permission evidence, technical availability and scheduling. UWV/SECO marked owner-assumed, EURES restricted. No new source silently defaults public. Reconcile stale source docs with actual code. | New specification |
| INT-02 | Enforce public/admin isolation everywhere | INT-01 | Ordinary user cannot discover/read/export admin records, source names, counts, histories or cached data, even by guessed IDs. Test stored historical rows, role changes and cross-source duplicates. Existing admin controls preserved. | New specification |
| INT-03 | Establish collection budgets and stop-on-block behavior | INT-01 | Durable per-source quotas, locks, cooldown, timeout, cancellation and safe partial-run records. 403/challenge stops; 429 honored across restart; bounded 5xx retries; no IP-block immunity claim. | New specification |
| INT-04 | Separate catalogue from user state; migrate safely | INT-02 | Add ordered migrations and indexes. Existing jobs/actions/corrections/tombstones survive. Reset/delete one user cannot alter global jobs or others. Verify fresh and copied populated databases; prepare tested rollback/recovery. | Extend [#5](https://github.com/Ydony/northbound-job-radar/issues/5) for identity; new migration specification |
| INT-05 | Query public catalogue with pagination and source reporting | INT-04 | Five role keywords and country/place/source/application filters operate server-side. Stable pagination, counts, freshness and clearly separate search/ingest reports. No 2,000-row disappearance or whole-catalogue description download. | Extend [#3](https://github.com/Ydony/northbound-job-radar/issues/3) |
| INT-06 | Move existing eligible sources to bounded public refresh | INT-03, INT-05 | ATS and Adzuna collected once per permitted refresh window. Fixed budget shared across users; attribution and retention respected. Identical concurrent searches do not duplicate upstream calls. Use resumable worker-sized batches. | New specification; coordinate scheduling with [#6](https://github.com/Ydony/northbound-job-radar/issues/6) |
| INT-07 | Evaluate and integrate FreeHire | INT-03; production wiring after INT-06 | Confirm usage conditions; retrieve a bounded CH/NL sample from full-description endpoint; report eligible sources, net unique yield and language quality. Map IDs, dates, provenance and closure. No API writes or user CV sharing. | New specification |
| INT-08 | Validate and promote Job-Room public integration | INT-01, INT-03; wiring after INT-06 | Under owner-assumed permission, validate the existing read/detail route or supplied replacement, full text, structured languages, country/date and quota behavior. Do not substitute the employer posting API. Record permission assumption visibly in engineering docs. | New specification |
| INT-09 | Obtain UWV retrieval interface and build adapter | INT-01; wiring after INT-06 | Owner/provider supplies usable feed/export, schema, credentials if needed and allowed operations. Then validate a sample, map fields and integrate with contracts. Until supplied, report technically unavailable with exact missing dependency. | New specification; external dependency |
| INT-10 | Test Jooble and decide integration on useful yield | INT-03; wiring after INT-06 | Obtain key, test descriptions first, then expand to 200-400 if suitable. Report quotas, completeness and new English-only matches. Keep out of primary matching if only teasers and no permitted full-text route. | Reuse [#18](https://github.com/Ydony/northbound-job-radar/issues/18), [#19](https://github.com/Ydony/northbound-job-radar/issues/19), [#20](https://github.com/Ydony/northbound-job-radar/issues/20) |
| INT-11 | Expand employer boards; evaluate optional promotions | INT-07 through INT-10 outcomes | Prioritize uncovered NL/CH employers. Validate URLs independently. Careerjet becomes public only with appropriate publisher/IP setup. OpenPostings code/data waits for licence clarification; no broad imports of unverified slugs. | New specification |
| INT-12 | Keep admin discovery operational and isolated | INT-02, INT-03 | Admin can manually run eligible existing restricted adapters with fixed caps and existing VPN guard. Paused/unavailable sources stay truthful. Admin collection uses separate runtime/egress from public collection; no public credentials granted to it. | New specification |
| INT-13 | Evaluate language quality and attribution end to end | Each adapter before promotion | Label a representative corpus: mandatory vs optional languages, English titles with non-English bodies, structured fields, missing/truncated descriptions and duplicates. Zero false passes on agreed blocking fixtures; report measured precision and unknown rate on held-out ads. | Extend [#4](https://github.com/Ydony/northbound-job-radar/issues/4); reconcile card issues [#14](https://github.com/Ydony/northbound-job-radar/issues/14)-[#17](https://github.com/Ydony/northbound-job-radar/issues/17) |
| INT-14 | Prepare public accounts, operations and release | INT-06, INT-12, INT-13; successful candidate adapters | Fresh secrets/admin credentials, email verification and recovery or an agreed identity provider, abuse protection, audit events, retention/privacy copy, backups with restore test, CSP decision and deployment security checks. Public staging has independent storage. | Reuse [#1](https://github.com/Ydony/northbound-job-radar/issues/1), [#2](https://github.com/Ydony/northbound-job-radar/issues/2); new account/operations specs |

Execution batches: INT-01 to INT-03 first; INT-04 to INT-06 next; FreeHire first among new sources.
Start UWV interface enquiries early and record unavailable dependencies without halting independent
work. Run INT-13 for each integration, not just at the end. INT-12 must finish before any public
launch. INT-14 gates deployment, and does not depend on every optional feed succeeding.

## 7. Verification and handover

For implementation, run the repository's tests, lint, typecheck and build, then exercise affected
API/UI flows as an admin and two ordinary accounts with distinct new data. Prove read/write/export
isolation, persistence across restarts, dismissal after refresh, rollback/restore, source withdrawal,
partial refresh and rate-limit handling. Use fixtures for refusal cases rather than provoking blocks.

Measure collection and serving costs at the sample size before selecting refresh frequency. Set
request/storage/CPU budgets, retention and a global stop switch. Free to users does not guarantee
zero hosting cost or unlimited upstream service. Prefer metadata summaries in result pages and
load a permitted full description only when needed.

Do not copy local test personal data into public staging. Keep dev/test stable and isolated during
implementation. Existing backup scripts require stopping the selected local server: plan copied or
offline migration testing and schedule any required interruption with the owner; this documentation
turn does not authorize stopping servers.

Before handover, update code-facing policy records and user-facing `/sources` and `/privacy` to
match deployed behavior. Record actual counts, tested version/date, remaining assumptions and
GitHub issue links. Never mark an integration complete merely because its endpoint returns 200.

## 8. Research references

Reviewed during the 2026-09-07 conversation. Recheck applicable conditions when implementing.

- [FreeHire API](https://freehire.me/docs/api), [full-description search](https://freehire.me/docs/api/jobs/agent-jobs-search-get), [terms](https://freehire.me/terms).
- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html), [Lever Postings API](https://github.com/lever/postings-api).
- [Adzuna publisher terms and quotas](https://developer.adzuna.com/docs/terms_of_service), [Careerjet publisher API](https://www.careerjet.com/partners/api/).
- [Jooble REST API for website publishers](https://jooble.org/api/about).
- [EURES vacancy-specific terms](https://europa.eu/eures/portal/jv-se/home?lang=en), [EURES legal notice](https://eures.europa.eu/eures-legal-notice_en), [partner requirements](https://eures.europa.eu/eures-services/how-become-eures-partner-member_en).
- [UWV vacancy API data request, historical](https://data.overheid.nl/community/datarequest/3935), [Dutch EURES partnership contact](https://www.uwv.nl/nl/over-uwv/samenwerkingen/eures-netwerk): `nco-eures@uwv.nl`.
- [Job-Room employer publication API](https://test-api.job-room.ch/api-docs/jobAdvertisements/v1/index.html): `jobroom-api@seco.admin.ch`. This is not documentation for downloading the national catalogue.
- [OpenPostings repository](https://github.com/Masterjx9/OpenPostings), [GitHub's explanation of absent licences](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

## 9. Documentation conflicts carried forward

Older documents contain historical descriptions, not current proof: EURES described as unrestricted
CC BY data, Job-Room described as unavailable despite its adapter, login limiting described as only
process-local despite a durable login limiter, CV upload shown as active despite being shelved,
Drizzle references after removal, and completed work described as unstarted. INT-01 reconciles
source documentation; relevant implementation tasks reconcile their own older sections. Do not
repeat these claims in new user-facing copy or redo completed work solely because a stale list says so.
