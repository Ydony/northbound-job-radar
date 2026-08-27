# Multi-source search implementation plan

Status: implemented locally; one VPN-protected external run remains before final live sign-off.

Last updated: 2026-08-27 after the user requested one-click automatic search across the
configured Swiss and Netherlands sources.

## 1. Requested outcome

One **Search all job sites** action should run every enabled source adapter, normalize the
results into one job list, apply the strict English-language gate, and make country and
application state easy to filter.

The completed experience must:

- search every enabled Swiss and Netherlands source from one user action;
- show which websites were actually searched, which failed or were blocked, and why;
- show total found, previously known, newly found, imported, and skipped counts per source
  after every run;
- show cumulative analyzed and applied counts per source so the user can see which sites
  produce the most useful opportunities;
- accept five additional editable role keywords, such as `Master Data` and `Supply Chain`,
  alongside the roles derived from the two CVs;
- show the source, country, and original posting date on every job card;
- filter jobs by Switzerland / Netherlands and Applied / Not applied;
- expose Applied and Not applied controls directly on every card;
- never show the same vacancy twice, including when a tracking URL changes;
- never re-introduce a dismissed vacancy in later searches unless the user explicitly
  restores it;
- replace the current Amsterdam source-link directory with automatic search coverage and
  source-health reporting;
- keep login and application submission on the original website under user control.

“All websites” means all adapters listed as enabled in Northbound. A source that cannot be
searched must appear in the run report as `blocked`, `unavailable`, or `failed`; it must not
be silently counted as searched.

## 2. Proposed source roster

LinkedIn remains excluded.

### Switzerland

| Source | Planned role | Current permission/technical note |
|---|---|---|
| jobs.ch | Enabled automatic adapter | Runs at the user's accepted risk. JobCloud terms prohibit crawlers, scrapers, bots, scripts, and automated access; no permission has been granted. |
| jobup.ch | Enabled automatic adapter | Shares the jobs.ch structured parser and is recorded separately. Covered by the same JobCloud prohibition; unsanctioned. |
| JobScout24 | Enabled automatic adapter | Uses its own search-link pattern and shared structured detail parser. Covered by the same JobCloud prohibition; unsanctioned. |
| Indeed Switzerland | Blocked | Indeed's 2026 Site Rules prohibit automated access without express written permission and the live search returned HTTP 403. No login, CAPTCHA handling, or evasion. |
| Job-Room | Permission/API investigation | The published Jobs API is an authenticated employer publication API, not a public job-seeker search API. Request or identify an authorized search feed before enabling. |

jobup.ch and JobScout24 overlap heavily with jobs.ch because they are JobCloud platforms;
cross-source duplicate detection is therefore mandatory before enabling them.

### Netherlands

| Source | Planned role | Current permission/technical note |
|---|---|---|
| IamExpat | Enabled automatic adapter | Uses current public `/career/jobs-netherlands/` listing/detail paths and their structured posting data. |
| Undutchables | Enabled, constrained adapter | Uses plain `/vacancies` and public detail pages only; it does not use disallowed query-string search paths. |
| Indeed Netherlands | Blocked | Indeed rules prohibit automated access without permission; live search returned HTTP 403 and robots.txt disallows job-detail routes. |
| Nationale Vacaturebank | Unavailable | Automated access returned HTTP 403 during the 2026-08-27 review; no authorized feed is configured. |
| I amsterdam | Disabled | The current page is a guide/directory, not a vacancy feed, and is not reported as searched. |

The 2026-08-27 request explicitly asks for the configured sources to behave like the
current jobs.ch integration. This records the product request, not platform permission.
Each adapter still needs an implementation-time terms and robots review. Any prohibited
adapter must be visibly labeled as unsanctioned or remain disabled; lack of permission must
never be hidden behind a generic success message.

## 3. Data model

Add ordered migrations before changing existing job data. Preserve the current CVs, jobs,
language feedback, and criteria.

### Jobs

Normalize these fields:

- `source_key` and `source_name`;
- `source_job_id` when the platform provides a stable identifier;
- `canonical_url` with tracking parameters and fragments removed;
- `country` (`switzerland`, `netherlands`, or `unknown`);
- `posted_at`, nullable when a source does not publish it;
- `first_seen_at` and `last_seen_at`;
- separate `saved_state`, `application_state`, and `visibility_state` instead of one
  overloaded pipeline status.

Application state is binary for this iteration: `not_applied` or `applied`. Visibility is
`active` or `dismissed`. Saved state is independent so a saved job can later be marked
applied without losing that information.

### Duplicate and dismissal identity

Use the strongest identity available, in order:

1. `(source_key, source_job_id)`;
2. canonical URL;
3. a conservative fingerprint of normalized company, title, and location.

Store dismissal tombstones separately from the active result list. A matching future
result updates `last_seen_at` and run counts but stays dismissed. Deleting an active card
must not accidentally delete its tombstone. Provide an explicit **Dismissed** view and a
**Restore** action.

### Search roles

Store up to five non-empty additional role keywords in display order. Deduplicate them
case-insensitively. Search terms are the unique set of:

- the effective role for CV 1;
- the effective role for CV 2; and
- the five additional role keywords.

The source report records exactly which terms each adapter searched.

### Search runs

Persist one parent row per button press and one child row per configured source. Record:

- start/end time and overall state;
- source state: `complete`, `partial`, `failed`, `blocked`, `disabled`, or `unavailable`;
- searched role terms and country;
- total URLs/records found;
- previously known;
- newly found;
- imported/analyzed;
- duplicates collapsed;
- skipped/failed details with safe, non-sensitive reasons.

Add indexes for latest-run queries, source history, job country/application filters, stable
source identity, and dismissed identity. Run `PRAGMA optimize` after schema setup.

## 4. Adapter contract and orchestration

Each source adapter must expose metadata plus a bounded search function returning normalized
candidate records. The orchestrator must:

1. create the search run before any network request;
2. execute enabled adapters with fixed per-source caps and delays;
3. isolate failures so one source cannot fail the full run;
4. canonicalize and deduplicate before fetching or analyzing duplicate detail pages;
5. preserve applied, saved, dismissed, and language-feedback state on refresh;
6. analyze only genuinely new or changed advertisements;
7. persist every source result, including zero results and failures;
8. return the completed run report and the new normalized jobs to the UI.

No adapter may automate login, submit applications, solve CAPTCHAs, spoof fingerprints,
rotate proxies/IPs, imitate human interaction, or otherwise evade detection.

## 5. User interface

### Search coverage dashboard

Replace the Amsterdam source-link cards with:

- one **Search all job sites** action;
- a latest-run grid with one row/card per source and explicit status;
- counts for Found, Previously known, Newly found, Added, Duplicates, and Skipped;
- cumulative source metrics for Analyzed, English sufficient, Saved, Applied, and Dismissed;
- a short recent-run history.

Do not use the phrase “searched” for disabled, blocked, or failed sources.

### Job filters

Keep the existing language views and add independent filters:

- Country: All, Switzerland, Netherlands;
- Application: All, Applied, Not applied;
- optional Source selector when more than one adapter is enabled;
- Dismissed view with Restore.

### Job cards

Every card shows:

- source and country;
- `Posted <date>` or `Posting date unavailable`;
- first-seen date when useful;
- Applied and Not applied controls, with the current selection visible;
- Save, Dismiss, and Apply on source actions;
- unchanged language decision evidence and CV-fit information.

## 6. Delivery tasks

| ID | Task | Dependency | Acceptance criterion |
|---|---|---|---|
| MS-01 | Add ordered migration runner and backup/restore test | Done | Existing 48-job workspace and two CV slots survived; byte-matched backup retained in ignored `work/`. |
| MS-02 | Split saved/application/visibility state | Done | Independent state API and card controls passed a restore-safe live smoke check. |
| MS-03 | Add canonical identity, fingerprints, and dismissal tombstones | Done | Tracking/trailing-slash variants collapse and dismissed repeat import is suppressed. |
| MS-04 | Add five additional role-keyword inputs | Done | Five roles persist and deduplicate. |
| MS-05 | Add normalized country, source, and posted-date fields | Done | Stored/exported/card fields implemented, including unavailable-date label. |
| MS-06 | Define adapter contract and multi-source run persistence | Done | All configured sources produce a truthful per-run status/metrics contract. |
| MS-07 | Refactor jobs.ch into the shared adapter | Implemented; live run pending | Local/unit verification complete; needs active VPN route. |
| MS-08 | Add other Swiss adapters | Implemented; live run pending | jobup.ch and JobScout24 enabled; blocked/unavailable sources report reasons. |
| MS-09 | Add Netherlands adapters | Implemented; live run pending | IamExpat and Undutchables enabled; Dutch remains a mandatory-language blocker. |
| MS-10 | Build one-click orchestration and partial-failure handling | Implemented; live run pending | One route isolates adapters and stores one combined report. |
| MS-11 | Add country/application/source filters and card controls | Done | Combined filters and card actions implemented. |
| MS-12 | Build latest-run and cumulative source dashboards | Done | Discovery and application-source metrics implemented. |
| MS-13 | Remove manual Amsterdam source directory | Done | Manual link cards removed and replaced with coverage status. |
| MS-14 | Add fixtures, adapter contract tests, dedupe tests, migration tests, and live smoke checks | Partial | 45 tests and local API/schema smoke checks pass; external adapter run awaits VPN. |

## 7. Recommended execution order

1. MS-01 through MS-06: protect data and create the common model.
2. MS-07: move the already-working jobs.ch adapter without changing its behavior.
3. MS-11 and MS-12: deliver filters, card actions, and truthful reporting with one source.
4. MS-08 and MS-09: add source adapters one at a time after each source review.
5. MS-10 and MS-13: enable the single button and replace the manual directory.
6. MS-14: complete cross-source and live verification before calling the iteration done.

## 8. Definition of done

- Existing personal data is migrated rather than reset.
- One click produces one deduplicated result list and a per-source report.
- Every enabled source is either searched or visibly reports why it was not.
- Applied/Not applied and country filters work together with language views.
- Five additional role keywords persist and are reported per run.
- Posted date appears on cards when provided by the source.
- Dismissed jobs never reappear automatically, including through equivalent URLs.
- The Amsterdam manual source directory is gone.
- No source login, application submission, or anti-detection behavior exists.
- Tests, typecheck, lint, production build, migration inspection, and affected API/UI smoke
  flows pass; unresolved source permission issues remain documented.
