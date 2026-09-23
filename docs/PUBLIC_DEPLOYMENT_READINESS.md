# Public-deployment readiness — not a deployment plan

Assessment from the code on 2026-09-23. The owner approved a separate, private,
single-admin Cloudflare production plan (milestone 12; initial D1 configuration
in commit `35cfa9e`). The first Worker version has been deployed, but it is
not configured for sign-in and has no administrator yet. DEV (`:3000`) and TEST (`:3001`)
remain local; do **not** publish either one or copy their D1 state or credentials
to the host. The blockers below govern a future *public/open-registration*
service; they are not claims that the private installation is already safe or
deployed. “Administrator-only” is a code boundary, not permission from a job source.

## Current position

The local app has signed sessions, user-scoped queries, a nonce-based script CSP, a closed-by-default registration setting, and tests for several cross-account paths. On 2026-09-23, lint, typecheck, design checks and the unit suite passed; `npm audit --omit=dev` reported zero production advisories. Those checks do not establish that a public service is safe. The hosted architecture in `docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` is a proposal, not an implemented collector or shared catalogue.

## Release blockers, in order

| Priority | Gap in current code | Required before public traffic |
|---|---|---|
| Blocker | The first remote registration is now rejected even if `ALLOW_SIGNUPS=true`, closing the easy administrator-takeover path. However there is **no hosted first-admin bootstrap** yet; `lib/users.ts:createUser` also has a non-atomic first-user check. | Add an out-of-band administrator bootstrap or installation-only invitation/secret, and test concurrent first registrations. Never publish an empty installation as-is. |
| Blocker | Public signup has no email ownership proof or self-service recovery. `password_resets` is only a dormant table. | Choose an email provider and implement verified registration, password reset, abuse controls and recovery runbook, or keep public signup closed and use an explicit invitation flow. |
| Blocker | One user click fans out to upstream sources and bulk ingestion has `MAX_NEW_PER_BULK_SOURCE = Infinity` in `app/api/scrape/route.ts`. In-memory search limits are per worker instance. | Build the shared public catalogue/coalesced refresh described in the integration plan, plus durable per-user/global budgets, bounded database writes, backpressure and source-specific kill switches. Do not use local administrator sources in that collector. |
| Blocker | Source permission, display, attribution and retention rules are not uniformly approved for a public catalogue; the current local portfolio includes deliberately private sources. | Revalidate every public feed and its current terms, obtain any required publisher access, and test that admin-only data cannot leak through results, counts, search history, corrections, exports, or errors. EURES attribution and third-party advertisement-text reuse require specific handling; see `docs/SOURCE_POLICY.md`. |
| Blocker | The dashboard has **no Export control**; `lib/export.ts` is not imported by the app. The privacy page now says this is unavailable. | Implement account-scoped portability, define data retention/deletion, complete a privacy review, and test erasure including recovery snapshots. |
| Blocker | A separate remote D1 and first Worker version now exist for the planned private installation, but owner-only secrets/bootstrap are outstanding. Those steps do not make a public service ready. | Before public traffic, verify isolated production credentials, deployment permissions, migrations, rollback and abuse controls. Rotate administrator credentials exposed in chat; never use local TEST data as production seed. |
| High | Auth and search limits rely on D1 or per-process maps; the durable limiter currently fails open on DB errors and its read/update steps are not atomic under concurrent requests. | Set a documented failure policy, make critical limits atomic/durable, add edge abuse protection and concurrency tests; verify behavior under a multi-instance runtime. |
| High | Authenticated GET responses such as `/api/state`, `/api/account`, and `/api/feedback` do not consistently set `Cache-Control: no-store`. | Add and test a consistent private-response cache policy at the API boundary before placing a CDN or reverse proxy in front. |
| High | There is no production-grade event/audit trail, alerting, or incident process; `auth_events` is limited to sign-ins. | Record minimal security events without job content, define retention/access, alerts, abuse response, key rotation and incident handling. |
| High | The dashboard still requests up to 2,000 rows at once and client-side facets/counts require the loaded set. Recent attempts to use 40-row paging regressed filters and were reverted. | Move facets/counts and filtered paging to the server, with a representative >2,000-job browser and API test before public scale. |
| High | Account removal and workspace reset still use multi-statement deletion without a recovery/verification report. | Make remaining deletion/retention operations recoverable and verifiable. |

## Deployment-safe sequence

1. Migration 28 applied to TEST and all in-project recovery snapshots were scrubbed of CV rows/objects; retain historical migration source for upgrades. Audit any external copies separately.
2. Fix the first-administrator bootstrap, registration/recovery and account-scoped portability; add fresh two-account abuse tests, not just owner-account tests.
3. Separate public collection from local administrator discovery. Define source policy and independent egress/storage so a public request cannot trigger restricted collection.
4. Bound ingestion and paging, set consistent no-store headers, then test under concurrency, large data and failure injection.
5. Choose hosting/domain with the owner. Create new resources/secrets, a migration/backup/restore drill, and a staging environment with synthetic accounts only.
6. Perform a final security/privacy/source-policy review in that actual environment before opening registration or sharing a URL.

Cloudflare documents [encrypted Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Those are options to evaluate for a chosen deployment, not a substitute for this app's own access controls or a tested restore. D1 restore overwrites the target database, so rehearse on disposable state first.
