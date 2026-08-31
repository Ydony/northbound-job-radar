# Post-MVP roadmap

This document describes the overall product, including capabilities that are intentionally outside the first jobs.ch MVP.

## Phase 0 — testable local multi-source MVP (current)

- One-click, manually triggered adapter orchestration for Switzerland and the Netherlands.
  Enabled: jobs.ch, jobup.ch, JobScout24, IamExpat, and Undutchables. LinkedIn is excluded;
  unsupported sources remain visible with truthful blocked/unavailable/disabled status.
- Up to two CV versions, local text extraction, automatic per-CV role derivation, and
  persisted role overrides. Every job is scored against both CVs.
- Five persisted role keywords plus location/canton, workplace, seniority, contract,
  required-keyword, and exclusion criteria for discovery and local filtering.
- Manually triggered, capped automatic search (`POST /api/scrape`) with no schedule,
  authentication, detection evasion, or application automation. See
  `docs/ARCHITECTURE.md` §2 for the source-specific permission record.
- Strict `pass / review / blocked` language gate.
- Persisted accurate/incorrect feedback with an optional corrected status and reason; explicit corrections control views without erasing detector evidence.
- Explainable CV-fit score.
- Independent saved, Applied/Not applied, and active/dismissed state; durable suppression
  of dismissed duplicates; source/country/application/result filters.
- Posted dates and source/country identity on cards; latest-run and cumulative source
  dashboards.
- Delete either CV or selected/all jobs, reset the workspace, and export safe JSON/CSV data.
- Optional VPN-enforced local launchers for Windows and macOS.
- Ordered local D1 migrations, R2 persistence, multi-user ownership, two real CV profiles, 916
  jobs in the stable test workspace, and a 90-test regression suite.
- Isolated local environments: hot-reload dev on port 3000 and a separately built test Worker on
  port 3001, with different D1, R2, and session state. No hosted environment is supported.

Exit criterion: the user can screen real jobs without a false “English sufficient” result in the agreed regression examples.

## Phase 1 — hardening for personal daily use

- Complete the VPN-protected live adapter run and add captured parser fixtures for every
  enabled source without committing personal job data.
- Add a labeled language corpus covering Swiss phrasing, CEFR levels, combined-language requirements, and optional wording.
- Add OCR for scanned CVs and robust parsing for multi-column PDFs.
- Add editable salary and visa/work-permit constraints; refine the Phase 0 location, workplace, seniority, contract, keyword, and exclusion filters as real usage demands.
- Add job expiry checks initiated by the user, notes, deadlines, contacts, and import/restore.
- Add retention schedules, encrypted backups, error telemetry with no CV content, accessibility tests, and mobile polish.

## Phase 2 — authorized Swiss discovery

Phase 0 already includes a manually-triggered, capped jobs.ch fetch (`POST
/api/scrape`), done knowingly against jobs.ch's ToS/robots.txt at the user's explicit
instruction — see `docs/ARCHITECTURE.md` §2. This phase is about replacing that
unsanctioned path with a real, permitted one, and separately about lifting the caps
(scheduling, higher volume, authentication) that Phase 0 does not attempt.

Preferred route: contact JobCloud for written approval and a job-seeker search feed/API or partnership. Confirm permitted fields, caching, refresh frequency, attribution, deep links, data deletion, and rate limits.

If JobCloud does not authorize ingestion, keep jobs.ch user-driven and add compliant inputs instead:

- parse job-alert emails that the user connects and authorizes;
- accept a browser share action that sends only the page the user is viewing, subject to a fresh terms review;
- ingest employer career pages through documented public ATS endpoints such as Greenhouse or Lever;
- let users upload or paste exported/saved-job lists.

Never disguise crawling as a virtual Chrome browser. The mechanism does not change the platform permission requirement.

## Phase 3 — authorized Switzerland + Netherlands coverage expansion

Phase 0 now has the one-click shared-adapter implementation requested on 2026-08-27 and
the manual Amsterdam handoff directory is gone. `docs/MULTI_SOURCE_PLAN.md` records the
implementation and its source status. LinkedIn remains excluded.

The next expansion must prioritize authorized feeds, direct employer career pages, and
public ATS endpoints. JobCloud remains unsanctioned and Indeed remains blocked; keep the
dashboard's blocked/disabled/failed states rather than claiming unsupported coverage.

For sustainable automated coverage, prioritize direct employer career pages and public ATS
endpoints. Add Dutch as a prohibited mandatory language, Amsterdam-radius filtering,
commute/remote rules, and Netherlands-specific work-authorization fields.

## Phase 4 — better ranking and learning

- Semantic CV/job matching with explicit user consent, documented model/provider retention, and a local or privacy-preserving option.
- Separate must-have qualification checks from general similarity.
- Explain every score using matched evidence and detected gaps.
- Learn from saves, ignores, applications, and interview outcomes without silently changing hard language rules.
- Extend beyond the current two CV slots to an arbitrary number of CV versions (Phase 0 already scores two and reports which fits each job better).
- Add salary normalization and company-quality signals from licensed sources.

## Phase 5 — scheduled runs and alerts

- Recurring discovery only for authorized sources.
- User-configurable daily/weekly schedule, quiet hours, and digest size.
- Notify only on new, deduplicated, passing matches above a score threshold.
- Keep “review” items in a separate digest.
- Record source health, last successful run, rate-limit state, and why a source was skipped.

## Phase 6 — application assistance

- Generate a tailored CV summary and cover-letter draft with user approval.
- Pre-fill application answers only in a user-visible, confirm-before-submit flow and only where platform rules permit it.
- Track application stages, interviews, follow-ups, contacts, and reminders.
- Do not auto-submit applications, answer legal eligibility questions, or impersonate the user.

## Platform and business requirements before any future public product

- Revalidate authentication and tenant isolation under deployment conditions; add managed secrets,
  encryption policy, backups, incident response, and production privacy controls.
- DPIA/GDPR review for CV and behavioral data; processor agreements for model, email, hosting, and analytics providers.
- Source-specific legal review, written permissions, rate limits, attribution, and takedown handling.
- Observability, retry/idempotency design, cost controls, source-adapter tests, and a feature flag that can disable a source immediately.
- Clear product metrics: passing precision, review rate, duplicate rate, useful-match rate, application conversion, and user-corrected language decisions.

## Suggested implementation order after the MVP

1. Test corpus and privacy/delete controls.
2. Search-profile depth and pipeline usability.
3. JobCloud permission request plus direct ATS adapters in parallel.
4. Amsterdam-radius and work-authorization filters.
5. Authorized alerts and expiry monitoring.
6. Semantic matching and application drafting.

This order protects the core promise—English really is enough—before increasing source volume.
