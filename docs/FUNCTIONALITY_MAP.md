# Functionality and code map

Verified against the source tree on 2026-09-23. This is the current implementation map, not a list of promised features. `docs/TASKS.md` and older sections of `docs/HANDOFF.md` contain historical decisions; the GitHub project board tracks open work.

## Request and data flow

```text
Browser pages (`app/`)  →  account-scoped API routes (`app/api/`)
                             ↓ session / role / origin checks (`lib/auth.ts`, `lib/guard.ts`)
                         feature modules (`lib/`)
                             ↓
                       local D1 (`DB`)

Manual search: criteria → source registry → source adapters → language gate
               → identity/deduplication → account's jobs + run report → dashboard
```

`db/runtime.ts` creates the legacy base schema and applies the numbered upgrades in `db/migrations.ts`. It runs on the first request; there is no Drizzle layer or `db:generate` command. Migration 28 removes CV storage and fit columns from the final schema. Earlier migrations retain CV references only so older databases can upgrade. `vite.config.ts` binds separate local D1 state for DEV and TEST. `scripts/run-local.mjs` builds and starts TEST; source edits do not hot-reload there.

## User-facing features

| Function | UI / entry point | Server and core code | Persisted data / tests |
|---|---|---|---|
| Registration, sign-in/out and sessions | `app/login/page.tsx`, `app/settings/page.tsx` | `app/api/auth/route.ts`, `app/api/account/route.ts`, `lib/auth.ts`, `lib/users.ts`, `lib/guard.ts` | `users`, `auth_events`, `rate_limits`; `tests/auth.test.ts`, `tests/tenant-route-bindings.test.ts` |
| Dashboard and job list | `app/page.tsx`, `app/job-radar.tsx` | `app/api/state/route.ts`, `lib/server-data.ts`, `lib/dashboard.ts`, `lib/paging.ts` | `jobs`, `search_runs`, `search_run_sources`; `tests/dashboard.test.ts`, `tests/keyword-pagination.test.ts`, `tests/collection-totals.test.ts` |
| Roles, country switches and required/excluded words | Dashboard search controls | `app/api/criteria/route.ts`, `lib/criteria.ts`, `lib/server-data.ts` | `search_settings`, `search_roles`; `tests/criteria.test.ts`, `tests/country-switches.test.ts` |
| Manually triggered multi-source collection | Dashboard search buttons; local CLI for Indeed | `app/api/scrape/route.ts`, `lib/job-adapters.ts`, `lib/eures.ts`, `lib/job-room.ts`, `lib/ats-feeds.ts`, `lib/job-aggregators.ts`, `lib/jobsch.ts`, `lib/indeed/*`, `scripts/indeed*.mjs` | `jobs`, `search_runs`, `search_run_sources`, `indeed_control`, `indeed_coverage`; adapter/Indeed tests |
| English-language verdict and explanation | Verdict on each card | `lib/analysis.ts`, `lib/language-rules.ts`, `lib/indeed/normalize.ts`, `lib/server-data.ts` | Detector fields on `jobs`; `tests/analysis.test.ts`, `tests/language-corpus.test.ts` |
| Correcting a language verdict | Card feedback control | `app/api/jobs/[id]/route.ts`, `lib/language-feedback.ts` | `language_feedback`; `tests/language-feedback.test.ts` |
| Extracted job requirements | Job-card requirement rail | `lib/requirements.ts`, `lib/excerpt.ts`, `app/api/admin/requirements-backfill/route.ts`, `lib/requirements-backfill.ts` | Derived job fields; `tests/requirements.test.ts`, `tests/requirements-backfill.test.ts` |
| Deduplication and repeated-search suppression | Folded cards, retained statuses | `lib/job-identity.ts`, `lib/server-data.ts`, `lib/rejected-listings.ts` | `jobs.duplicate_of`, `dismissed_jobs`, `rejected_listings`; `tests/job-identity.test.ts`, `tests/cluster-version.test.ts` |
| Save, dismiss, applied/not applied, workspace reset | Job cards and workspace controls | `app/api/jobs/[id]/route.ts`, `app/api/workspace/route.ts` | Per-owner job/action rows; `tests/tenant-route-bindings.test.ts`, `tests/job-payload.test.ts` |
| Country, city, website and language-result facets | Results sidebar | `lib/dashboard.ts`, `lib/places.ts`, `lib/nuts.ts`, `app/api/state/route.ts` | Jobs plus computed facets; `tests/dashboard.test.ts`, `tests/places.test.ts` |
| Search and source statistics | Dashboard statistics band | `lib/dashboard.ts`, `lib/analytics.ts`, `lib/server-data.ts`, `app/api/state/route.ts` | Runs, run sources, daily counters; `tests/dashboard.test.ts`, `tests/analytics.test.ts` |
| Account and administrator management | `app/settings/page.tsx`, `app/admin/page.tsx` | `app/api/account/route.ts`, `app/api/admin/route.ts`, `lib/users.ts` | `users` and user-scoped tables; `scripts/verify-admin-actions.mjs` |
| Source policy and privacy explanation | `app/sources/page.tsx`, `app/privacy/page.tsx` | `lib/source-policies.ts`, `lib/privacy-policy.ts` | Generated from code/policy; `tests/source-policies.test.ts`, `tests/privacy-policy.test.ts` |

## Administrator-only and dormant paths

The authorization check belongs in the API, not in whether a button is visible. `lib/job-adapters.ts` derives the administrator-only source keys; `app/api/state/route.ts` also filters older stored rows and run history. `app/api/admin/indeed/*` and `app/indeed-status.tsx` implement the local administrator Indeed experiment. `app/api/health/route.ts` checks keyed sources and exposes network information only to an administrator; opening it makes upstream requests. `app/api/admin/job-room-*-backfill/*` and `app/api/admin/requirements-backfill/*` are manually triggered repair tools.

CV upload and personal-fit scoring have been removed from the dashboard, API, scoring and final database schema. No CV is needed for search. The owner authorized deletion of the two saved TEST CV records and files on 2026-09-23. The legacy local state and every in-project TEST backup were also scrubbed while preserving job rows. Historical migration source remains solely for upgrade compatibility; external copies of the project were not inventoried.

**Present in code but absent from the current dashboard:** `lib/export.ts` has tested JSON/CSV serializers, but no application import uses them and there is no Export button; `GET /api/feedback` provides a correction report without a linked screen; `POST`/`DELETE /api/jobs` support manual import/deletion from scripts or direct API calls, not the current dashboard; the requirements backfill is API-only. These are not working user-facing controls. Before public launch, decide whether to restore each useful control or remove its dormant code and update `/privacy` accordingly.

The VPN setup and private launchers in `scripts/` are local administrator tooling. They are not a public deployment path. No source-site login or job application is automated.

## Security boundaries and verification

- `requireSession()` in `lib/guard.ts` checks the signed, revocable session and optionally the administrator role. User-data SQL must also bind `user_id`; a valid session alone is not a tenancy check.
- `lib/auth.ts` checks mutating requests against the full request origin. `middleware.ts` adds a per-request script nonce; `lib/security-policy.ts` constructs the CSP. `next.config.ts` supplies the other security headers.
- `lib/job-sources.ts` checks manually supplied apply URLs. The automated search path validates source-provided URLs before saving them.
- `tests/` covers core transformations and several route contracts. `scripts/verify-dev-workflow.mjs` and `scripts/verify-admin-actions.mjs` exercise fresh synthetic accounts; `npm run check:visual` exercises a browser. Passing unit tests does not prove a hosted multi-user deployment is safe.

## Where to change a behavior

Change search inputs in `lib/criteria.ts` and `app/api/criteria/route.ts`; change collection in the relevant adapter plus `app/api/scrape/route.ts`; change language judgment in `lib/language-rules.ts`/`lib/analysis.ts`; change card rendering in `app/job-radar.tsx` and `app/globals.css`; change data shape in a new `db/migrations.ts` version plus `lib/server-data.ts` and `lib/types.ts`. When data handling changes, update `/privacy` and `/sources` in the same change. Add focused tests and verify with a fresh second account whenever ownership changes.
