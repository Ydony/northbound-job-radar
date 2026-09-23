# Ik ben een appel

A local tool for finding Netherlands and Switzerland jobs where English may be sufficient. It collects from configured sources when the user starts a search, evaluates the published advertisement, and keeps a private job pipeline. Applying and signing in to a job site remain manual.

This repository is **not ready for public hosting**. DEV and TEST run only on this computer; see [environments](docs/ENVIRONMENTS.md), [functionality and code map](docs/FUNCTIONALITY_MAP.md), and [public-deployment readiness](docs/PUBLIC_DEPLOYMENT_READINESS.md). No public URL or hosted storage is configured.

## Run locally

Requires Node.js 22.13 or newer.

```text
npm install
npm run init-secrets
npm run dev
```

DEV opens at `http://localhost:3000`. For the separate, fixed-build TEST environment:

```text
npm run test:local
```

TEST opens at `http://localhost:3001`. The environments have separate D1 storage and session secrets. Do not copy, reset, migrate, or rebuild TEST casually; it contains the owner's saved workspace. See [the setup guide](docs/GETTING_STARTED.md) and [environment rules](docs/ENVIRONMENTS.md). Optional VPN-enforced launchers for local administrator sources are explained in [VPN guidance](docs/VPN.md).

## Current behavior

- Sign in to a private account and keep up to five role keywords, required/excluded words and country search switches.
- Run a manually triggered search, see source outcomes and newly collected jobs, then filter the retained list by language verdict, country, place, website and application state.
- Inspect a job's language explanation and extracted requirements, correct a verdict, save or dismiss it, mark it applied, and open its source page yourself. Dismissal survives later searches.
- Reset the workspace, change account credentials, or delete the account. Administrators have separate account management and maintenance tools.
- The local administrator-only Indeed experiment has a status/settings panel and CLI; [the operator guide](docs/INDEED_TESTING.md) records prerequisites and limits. It is not a public feature.

CV upload and CV-to-job matching have been removed. Search uses the role keywords you enter, and jobs are judged for language sufficiency, not personal fit. JSON/CSV serializers and manual-import/deletion API paths exist without dashboard controls, so they are not completed user-facing features. The exact active/dormant mapping is in [docs/FUNCTIONALITY_MAP.md](docs/FUNCTIONALITY_MAP.md).

## Code and checks

`app/` contains pages and API routes, `lib/` contains screening, source adapters, identity and policy, `db/` contains the runtime base schema and numbered migrations, and `scripts/` contains local launchers and verification tools. There is no Drizzle schema or `db:generate` script.

```text
npm run lint
npm run typecheck
npm test
npm run check:design
```

`npm run build` builds the Worker. Do not run a competing build while the fixed TEST server is using `dist`; follow [the promotion workflow](docs/ENVIRONMENTS.md) instead. A green unit suite is not a browser or deployment security check.

The [GitHub project board](https://github.com/users/Ydony/projects/4) tracks active work. [AGENTS.md](AGENTS.md) sets the coding and data-safety rules for another LLM. [docs/HANDOFF.md](docs/HANDOFF.md) contains recent checkpoints; many older sections are historical.

Source permissions vary. Administrator-only does not mean licensed or suitable for a public service. Review [the source policy](docs/SOURCE_POLICY.md) before changing an adapter or hosting the app. LinkedIn is excluded; this app does not automate job-site login or applications.
