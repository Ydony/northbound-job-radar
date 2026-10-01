# Local environments

Dev and test run the self-hosted stack: the standalone Node bundle on SQLite
(owner decision, 2026-09-27). A separate private Cloudflare production
environment now exists; it never shares their data.

| Environment | URL | Purpose | Storage |
|---|---|---|---|
| **dev** | `http://localhost:3000` | Disposable experiments, rebuilt on every start | `.local/dev.sqlite` + `.local/dev-server/` |
| **test** | `http://localhost:3001` | Stable built release used as a real user | `.local/test.sqlite` + `.local/test-server/` |
| **prod** | `https://ikbeneenappel-prod.anddonatas.workers.dev` and `https://ikbeneenappel.nl` (verified 2026-09-24; `www` not yet redirecting) | Hosted Worker, single admin, registration closed permanently | Remote `ikbeneenappel-prod` D1, never local TEST |

The workerd pair is archived as `dev:cloudflare` / `test:cloudflare` with its own
`.wrangler` state. It is what production still runs until cutover, and the only
pair with hot reload. New work must use only the named `dev` and `test` paths.

The paths are intentionally different. A dev reset cannot delete test jobs.

## First setup

```text
npm install
npm run init-secrets
```

`npm run init-secrets` creates ignored `.dev.vars.dev` and `.dev.vars.test` files with different
session-signing secrets. When a legacy `.dev.vars` exists, non-session source credentials are
copied into both files; the session secret is never copied.

Do not commit `.dev.vars*` or `.wrangler/`. The checked-in `.dev.vars.example` documents the
supported values without containing credentials.

## Start the environments

In one terminal:

```text
npm run dev
```

In another terminal:

```text
npm run test:local
```

`test:local` first builds the current source, then serves that fixed build from
this environment's own copy under `.local/test-server/` on port 3001. Each
environment serves its own copy of the build: chunk filenames are
content-hashed, so building for one environment deletes the exact chunk names
the other is lazily importing, which broke the other environment's `/api/state`
into a 500 while its pages still served. Configuration comes from
`.dev.vars.<env>`, parsed by `scripts/run-local.mjs` itself, because the
standalone bundle only knows `process.env`. Each environment keeps its own
SQLite file (`.local/<env>.sqlite`) and session secret
(`.local/<env>-session-secret`), so dev and test cannot see each other's
accounts or jobs. Delete a database file to start that environment over.

Both may run at the same time. Restart `test:local` only when a validated change is ready for real
use; source edits do not hot-reload into the running test release. There is no
hot reload on this stack: rerun the command after a change. The archived
`dev:cloudflare` pair still has HMR, at the price of not being the stack that
will ship.

Production is not a third local server. `npm run build:prod` builds and verifies its
Worker/D1 bindings. `npm run deploy:prod` performs a real Cloudflare deployment;
use it only during the owner-witnessed first release or an approved update. The
GitHub `production` environment requires the owner's review before a CI deploy.
Deployment does not copy jobs or accounts from TEST. After the first deployment,
request `/api/state` once (expect signed-out HTTP 401) to apply migrations,
then use the one-time local
`npm run bootstrap:prod-admin` script. See `docs/DEPLOY.md`.

## What differs between dev and test, deliberately

The two run the same code. Everything below is configuration or data, and is meant to differ — do
not "fix" it by making them match.

| | dev | test | why |
|---|---|---|---|
| `ALLOW_SIGNUPS` | `true` | `false` | `verify:dev` and `verify:admin` create and delete disposable accounts, so dev must accept registrations. Test stays closed. |
| Data | empty by default | the stable workspace | Dev is disposable; exercising freshly created data is what catches write-path bugs that adopted data never touches. Local data does not matter and is not carried over. |
| Reload | rebuild on rerun | fixed build | Neither hot-reloads. Test must not change under you while dev is being edited. Hot reload exists only on the archived `dev:cloudflare` pair. |

To confirm the two are running the same code: both are built from the same
source by the same `scripts/run-local.mjs` build step, and both should serve
the same `Content-Security-Policy` and the same `/api/state` shape. If test is
behind, rebuild it with `npm run test:local`.

## VPN-enforced variants

Windows:

```text
npm run dev:private
npm run test:private
```

macOS:

```text
npm run dev:private:mac
npm run test:private:mac
```

These launchers verify a full VPN route before setting `VPN_ENFORCED=true`. They do not store VPN
credentials. Restricted page-fetch adapters remain unavailable without this verified marker.

## Promote a change from dev to test

1. Exercise the change at `http://localhost:3000`.
2. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
3. Stop and restart `npm run test:local` to build the stable test release.
4. Exercise the change at `http://localhost:3001` as a real user.

Migrations apply on first request and are recorded in `schema_migrations`. Before a schema change,
copy `.local/test.sqlite` to a dated local backup. Never reset test state merely to make a
migration pass.

## Disposable duplicate-workflow verification

`scripts/verify-cluster-workflow.mjs` exercises duplicate handling using newly registered
ordinary accounts and synthetic ads. Run it only in an isolated checkout with
disposable storage and `ALLOW_SIGNUPS=true`. It makes no external source requests. Set
`IKBENEENAPPEL_VERIFY_DISPOSABLE=true` and `IKBENEENAPPEL_VERIFY_URL` to that local instance,
then run `node scripts/verify-cluster-workflow.mjs`. Run once against rebuilt dev and once
against the built test release. It deletes its ordinary accounts afterward; on an empty database,
the bootstrap administrator is retained because the app forbids deleting the last administrator.

For a custom Cloudflare test launch, use an absolute `--env-file` path as `run-cloudflare.mjs` does;
a relative path may resolve under the generated configuration directory and omit session settings.

## Legacy state

The former single-environment workspace under `.wrangler/state` is gone: the old
D1 state was deleted when dev and test moved onto the new stack, and local data
is not carried over. Local state for the current stack lives under the ignored
`.local/` directory; `.wrangler/` holds only deploy output and whatever state
the archived Cloudflare pair recreates when it runs. New work must use only the
named `dev` and `test` paths.
