# Northbound task tracker

Last updated: 2026-08-27.

This is the execution tracker for finishing the personal MVP and planning the work after it. Update the status, evidence, and next action whenever a task changes.

## Current snapshot

- Core search: **multi-source implementation complete; live external run pending an active full VPN route**.
- Quality baseline: **45 tests passing; type-check, lint, database generation, and production build clean**.
- Git: multi-source plan `7cc480c`; verified implementation `6e52c09`.
- Local preview: `http://localhost:3000/` using the ordinary local server for database/API checks only. `npm run dev:private` correctly refused to start while the VPN route was inactive.
- Current local data: both real CV profiles, five saved role keywords, and 48 distinct screened jobs (7 pass, 1 review, 40 blocked; 4 dismissed). The upgrade preserved all rows and did not print CV text.
- Optional VPN bootstrap: official-client installation and VPN-enforced local startup are implemented for Windows and macOS. Windows passed live through a Netherlands exit; macOS awaits testing on the Apple device. Provider credentials remain user-visible and outside Northbound.

## MVP completion tracker

| ID | Task | Status | Progress/evidence | Next action | Done when |
|---|---|---|---|---|---|
| MVP-01 | Commit verified fixes | Done | Verification commit `2a77a70` records the tested two-CV flow, classifier fix, migration, and 14-test suite. | None. | Completed 2026-08-26. |
| MVP-02 | Test with real CVs | Done | Both PDFs parsed and saved. Detection now returns `Data Analyst` / `Data Governance Analyst`; specific overrides are saved. Two capped runs produced and reviewed 24 ads. | None. Keep the real PDFs and their temporary copies out of Git. | Completed 2026-08-26. |
| MVP-03 | Editable search criteria | Done | Role overrides, location/canton, workplace, seniority, contract, required keywords, and exclusions persist. Role/location shape discovery; all fields filter local views; Reset clears optional criteria. | Refine semantics only when real usage exposes a gap. | Completed 2026-08-26 in `a8e7ba1`. |
| MVP-04 | Validate and correct language results | Partial — controls done | Every card supports persisted Accurate/Flag wrong feedback, corrected pass/review/blocked status, optional reason, clearing, and effective view reassignment. The 45-test suite covers the current deterministic rules. | Label a representative set of real Swiss and Dutch-market ads, then promote confirmed edge cases into the regression corpus. | A representative labeled corpus passes; corrections persist; corrected cases become regression tests; ambiguous cases still fail closed. |
| MVP-05 | Data controls | Done | The dashboard now deletes either CV, selected jobs, or all jobs; exports JSON/CSV; and performs a confirmed full reset. API guards and a temporary-job create/delete round trip passed while preserving both real CVs, all 24 real jobs, and saved criteria. | None. Destructive success paths were deliberately not run against the real workspace. | Completed 2026-08-27 in `7c1fa3b`. |
| MVP-06 | Search diagnostics | Done | Every configured adapter records complete/partial/failed/blocked/disabled/unavailable plus found, known, new, added, duplicate, and skipped counts. Latest and cumulative dashboards render the reports. | Live-check messages and counts during the first VPN-protected run. | Partial/broken sources are distinct from “no new jobs,” without exposing CV content. |
| MVP-07 | Migrations and backups | Done | `schema_migrations` and ordered runtime migrations 1–3 upgraded the existing database in place. The 18-file `.wrangler` state was copied byte-for-byte to ignored `work/wrangler-before-multisource/`; 2 CV slots and 48 jobs survived. Drizzle `0003` and migration tests are present. | Keep future migrations additive and test restore instructions before major releases. | Existing data survives an upgrade and has a deliberate local backup. |

## Recommended execution order

1. Activate a full VPN route and run one end-to-end **Search all job sites** check.
2. Expand the labeled language corpus using the completed correction loop.
3. Seek authorized feeds/permission or replace unsanctioned adapters with public ATS/company sources.

## Accepted next iteration — automatic multi-source search

The user accepted the direction on 2026-08-27 and asked implementation to proceed after
the task documentation was created. The detailed data model, adapter contract, source
roster, risks, and acceptance criteria are in `docs/MULTI_SOURCE_PLAN.md`.

| ID | Task | Status | Next action |
|---|---|---|---|
| MS-01 | Ordered migrations and verified backup/restore | Done | Runtime migrations 1–3 applied; backup and preserved counts verified. |
| MS-02 | Independent saved, Applied/Not applied, and dismissed state | Done | Independent fields, filters, and card controls persist through the API. |
| MS-03 | Canonical URL, source identity, cross-source dedupe, and dismissal tombstones | Done | URL/source/fingerprint identity plus durable tombstones; a live repeat-import smoke test preserved the 48-row count. |
| MS-04 | Five additional persisted role keywords | Done | Five normalized roles persist; the real profile now holds Supply Chain, Data Analyst, Data Governance, Master Data, and Business Analyst. |
| MS-05 | Source, country, and original posted date | Done | Normalized fields are stored, exported, and displayed; missing dates say unavailable. |
| MS-06 | Shared adapter contract plus persisted per-source run reports | Done | All configured sources have a truthful status and metrics row contract. |
| MS-07 | Refactor jobs.ch into the shared adapter | Implemented — live check pending | Run once behind the protected VPN launcher. |
| MS-08 | Other Swiss website adapters | Implemented — live check pending | jobup.ch and JobScout24 are enabled at the documented JobCloud risk; blocked/unavailable Swiss sources remain visible. |
| MS-09 | Netherlands website adapters | Implemented — live check pending | IamExpat and Undutchables enabled; Indeed/Nationale/I amsterdam remain truthfully blocked/unavailable/disabled; LinkedIn excluded. |
| MS-10 | One-click search-all orchestration | Implemented — live check pending | One API action isolates failures, deduplicates, analyzes, and persists a complete report; verify with active VPN. |
| MS-11 | Country/application/source filters and card controls | Done | Combined filters and independent card actions are implemented. |
| MS-12 | Latest-run and cumulative source dashboard | Done | Per-run discovery metrics and cumulative analyzed/pass/saved/applied/dismissed metrics are implemented. |
| MS-13 | Remove the manual Amsterdam source directory | Done | The handoff-card section is removed and replaced by coverage/status reporting. |
| MS-14 | Adapter, migration, date, role, filter, dedupe, and dismissal verification | Partial | 45 tests, clean lint/typecheck/build, live schema upgrade, criteria persistence, card state, tombstone, and duplicate checks pass. External adapter run awaits VPN. |

## After the MVP

| Phase | Scope | Status | Dependency |
|---|---|---|---|
| POST-01 | Add Netherlands and Amsterdam-area sources and Dutch-specific location/work-authorization filters. | In planning — automatic expansion accepted | `MS-01`–`MS-14` replace the handoff directory with a one-click, truthfully reported multi-source design. |
| POST-02 | Replace unsanctioned jobs.ch fetching with JobCloud permission, an authorized feed, alerts, or direct ATS/company sources. | Not started | JobCloud discussion and adapter architecture. |
| POST-03 | Scheduled searches, deduplicated digests, thresholds, quiet hours, and source-health monitoring. | Not started | Authorized sources, migrations, backups, and reliable diagnostics. |
| POST-04 | Better semantic CV matching, must-have qualification checks, visible explanations, and multiple CV versions. | Not started | Privacy/provider decision and a labeled evaluation dataset. |
| POST-05 | Cover-letter drafts, application preparation, interview stages, contacts, and reminders. | Not started | Stable job/CV records and explicit confirm-before-submit rules. |
| POST-06 | Public-product security: authentication, tenant isolation, encryption, audit logs, GDPR controls, deletion/export, and incident response. | Not started | Required before hosting for anyone other than the single local user. |

## Project-wide constraints

- “English sufficient” remains a hard gate: uncertain cases go to Review, never Matches.
- Do not add bot-detection evasion, automated jobs.ch login, or automatic application submission.
- Scheduled or higher-volume discovery requires authorized sources.
- Never send CV or job text to a third-party model without explicit consent and documented retention behavior.
