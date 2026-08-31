# Local environments

Ik Engels is local-only. It has two named environments and no hosted or public environment.
Both use Cloudflare's local Miniflare/Workers runtime, so D1 and R2 behaviour remains realistic
without sending CVs or job data to a hosted service.

| Environment | URL | Purpose | Storage |
|---|---|---|---|
| **dev** | `http://localhost:3000` | Hot-reload coding and disposable experiments | `.wrangler/dev/state` |
| **test** | `http://localhost:3001` | Stable built release used as a real user | `.wrangler/test/state` |

The paths are intentionally different. A dev reset cannot delete test jobs or CV files.

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

`dev` uses Vinext/Vite hot reload. `test:local` first builds the current source, then runs that
fixed build through `wrangler dev` on port 3001. Wrangler receives an explicit `--persist-to`
path, so test D1 and R2 data stay under `.wrangler/test/state`.

Both may run at the same time. Restart `test:local` only when a validated change is ready for real
use; source edits do not hot-reload into the running test release.

## What differs between dev and test, deliberately

The two run the same code. Everything below is configuration or data, and is meant to differ — do
not "fix" it by making them match.

| | dev | test | why |
|---|---|---|---|
| `ALLOW_SIGNUPS` | `true` | `false` | `verify:dev` and `verify:admin` create and delete disposable accounts, so dev must accept registrations. Test stays closed. |
| Data | empty by default | the real workspace | Dev is disposable; exercising freshly created data is what catches write-path bugs that adopted data never touches. |
| Reload | hot | fixed build | Test must not change under you while dev is being edited. |

To confirm the two are running the same code: no file under `app/`, `lib/`, `db/` or
`next.config.ts` should be newer than `dist/server/index.js`, and both should serve the same
`Content-Security-Policy` and the same `/api/state` shape. If test is behind, rebuild it with
`npm run test:local`.

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
copy `.wrangler/test/state` to a dated local backup. Never reset test state merely to make a
migration pass.

## Legacy state

The former single-environment workspace under `.wrangler/state` is retained as a recovery copy.
Its populated workspace was copied—not moved—into `.wrangler/test/state` when the two local
environments were introduced. New work must use only the named `dev` and `test` paths.
