# Post-MVP roadmap

This document describes the overall product, including capabilities that are intentionally outside the first jobs.ch MVP.

## Phase 0 — testable MVP (current)

- One Swiss source: jobs.ch.
- Up to two CV versions, local text extraction, automatic per-CV role derivation, and
  persisted role overrides. Every job is scored against both CVs.
- Persisted location/canton, workplace, seniority, contract, required-keyword, and
  exclusion criteria for discovery and local filtering.
- Manually-triggered automatic search + fetch (`POST /api/scrape`), alongside
  user-driven search and manual ad import — see `docs/ARCHITECTURE.md` §2 for the
  2026-08-26 decision to automate this against jobs.ch's ToS/robots.txt, and the caps
  (no schedule, capped listings per click, no auth, no detection evasion) that bound it.
- Strict `pass / review / blocked` language gate.
- Persisted accurate/incorrect feedback with an optional corrected status and reason; explicit corrections control views without erasing detector evidence.
- Explainable CV-fit score.
- Save, hide, mark applied, and open the original application page.
- Local D1/R2 persistence, a verified real-CV/24-ad run, and a focused 26-test regression set.

Exit criterion: the user can screen real jobs without a false “English sufficient” result in the agreed regression examples.

## Phase 1 — hardening for personal daily use

- Add a labeled language corpus covering Swiss phrasing, CEFR levels, combined-language requirements, and optional wording.
- Add OCR for scanned CVs and robust parsing for multi-column PDFs.
- Add editable salary and visa/work-permit constraints; refine the Phase 0 location, workplace, seniority, contract, keyword, and exclusion filters as real usage demands.
- Add duplicate detection, job expiry checks initiated by the user, notes, deadlines, contacts, and export/import.
- Add CV deletion, retention controls, encrypted backups, error telemetry with no CV content, accessibility tests, and mobile polish.

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

## Phase 3 — Netherlands / Amsterdam expansion

Add country-specific source adapters and a shared normalized job schema. Initial market sources to evaluate are LinkedIn, Indeed Netherlands, I amsterdam Jobs, IamExpat Jobs, and Nationale Vacaturebank. LinkedIn and Indeed prohibit unauthorized automated extraction, so use alerts/user handoff or obtain partner access rather than scraping.

For automated coverage, prioritize direct employer career pages and public ATS endpoints. Add Dutch as a prohibited mandatory language, Amsterdam-radius filtering, commute/remote rules, and Netherlands-specific work-authorization fields.

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

## Platform and business requirements before a public product

- Authentication, tenant isolation, secrets management, encryption, audit trails, deletion/export, backups, incident response, and a privacy policy.
- DPIA/GDPR review for CV and behavioral data; processor agreements for model, email, hosting, and analytics providers.
- Source-specific legal review, written permissions, rate limits, attribution, and takedown handling.
- Observability, retry/idempotency design, cost controls, source-adapter tests, and a feature flag that can disable a source immediately.
- Clear product metrics: passing precision, review rate, duplicate rate, useful-match rate, application conversion, and user-corrected language decisions.

## Suggested implementation order after the MVP

1. Test corpus and privacy/delete controls.
2. Search-profile depth and pipeline usability.
3. JobCloud permission request plus direct ATS adapters in parallel.
4. Netherlands market adapter and Amsterdam filters.
5. Alerts and deduplication.
6. Semantic matching and application drafting.

This order protects the core promise—English really is enough—before increasing source volume.
