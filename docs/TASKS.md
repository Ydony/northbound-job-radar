# Northbound task tracker

Last updated: 2026-08-27.

This is the execution tracker for finishing the personal MVP and planning the work after it. Update the status, evidence, and next action whenever a task changes.

## Current snapshot

- Core jobs.ch flow: **verified working** with both real PDFs and 24 real ads.
- Quality baseline: **31 tests passing; type-check, lint, and production build clean**.
- Git: Netherlands sources and macOS VPN support are committed as `6fd7b18`; the Windows VPN foundation is `bfce858` and the baseline is `344a642`.
- Local preview: `http://localhost:3000/` while the current VPN-enforced development server is running.
- Current local data: both real CV profiles, saved role overrides, and 24 screened jobs (5 pass, 1 review, 18 blocked). Temporary feedback test rows were cleared.
- Optional VPN bootstrap: official-client installation and VPN-enforced local startup are implemented for Windows and macOS. Windows passed live through a Netherlands exit; macOS awaits testing on the Apple device. Provider credentials remain user-visible and outside Northbound.

## MVP completion tracker

| ID | Task | Status | Progress/evidence | Next action | Done when |
|---|---|---|---|---|---|
| MVP-01 | Commit verified fixes | Done | Verification commit `2a77a70` records the tested two-CV flow, classifier fix, migration, and 14-test suite. | None. | Completed 2026-08-26. |
| MVP-02 | Test with real CVs | Done | Both PDFs parsed and saved. Detection now returns `Data Analyst` / `Data Governance Analyst`; specific overrides are saved. Two capped runs produced and reviewed 24 ads. | None. Keep the real PDFs and their temporary copies out of Git. | Completed 2026-08-26. |
| MVP-03 | Editable search criteria | Done | Role overrides, location/canton, workplace, seniority, contract, required keywords, and exclusions persist. Role/location shape discovery; all fields filter local views; Reset clears optional criteria. | Refine semantics only when real usage exposes a gap. | Completed 2026-08-26 in `a8e7ba1`. |
| MVP-04 | Validate and correct language results | Partial — controls done | Every card now supports persisted Accurate/Flag wrong feedback, corrected pass/review/blocked status, optional reason, clearing, and effective view reassignment. Feedback survived reload, rescore, and re-import; 26 tests pass. | Use the controls to label a representative set of real ads, then promote confirmed edge cases into the maintained regression corpus. | A representative labeled corpus passes; corrections persist; corrected cases become regression tests; ambiguous cases still fail closed. |
| MVP-05 | Data controls | Done | The dashboard now deletes either CV, selected jobs, or all jobs; exports JSON/CSV; and performs a confirmed full reset. API guards and a temporary-job create/delete round trip passed while preserving both real CVs, all 24 real jobs, and saved criteria. | None. Destructive success paths were deliberately not run against the real workspace. | Completed 2026-08-27 in `7c1fa3b`. |
| MVP-06 | Scraper diagnostics | Partial | Search-level errors surface, but individual detail-fetch and parse failures are silently skipped. | Return requested/fetched/parsed/skipped counts and safe failure reasons; record a run summary and display it in the UI. | A partial or broken source run is distinguishable from “no new jobs,” without exposing CV content or sensitive data. |
| MVP-07 | Migrations and backups | Partial | Two-CV migration `0000` and search-settings migration `0001` exist, but runtime still creates tables with `CREATE TABLE IF NOT EXISTS` and applies neither migration. | Add an ordered migration runner, migration-version table, backup/export path, restore instructions, and a migration test. | Existing data survives a schema upgrade and can be backed up and restored deliberately. |

## Recommended execution order

1. `MVP-04` — expand the language corpus using the completed correction loop.
2. `MVP-06` — make source failures observable.
3. `MVP-07` — protect accumulated data before longer-term use.

## After the MVP

| Phase | Scope | Status | Dependency |
|---|---|---|---|
| POST-01 | Add Netherlands and Amsterdam-area sources and Dutch-specific location/work-authorization filters. | Partial — handoffs done | Five source handoffs and strict manual imports are implemented without LinkedIn; country-specific saved filters and authorized automation remain. |
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
