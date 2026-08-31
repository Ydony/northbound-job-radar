# Environments

Three environments, added as they are needed. The rule that matters: **each one owns its own
database and its own bucket.** Sharing storage between them means a development mistake destroys
the data you were testing against, and a test reset destroys real work.

| | Purpose | Who uses it | Data |
|---|---|---|---|
| **development** | Where changes are made | The person or agent working on the code | Disposable. Reset freely. |
| **testing** | A stable build to use while development continues | You, as a real user | Realistic and worth keeping, but not irreplaceable |
| **production** | The public site | Real users | Real. Never reset. |

Development runs locally against Miniflare (`npm run dev`); it needs no Cloudflare resources at
all. Testing and production are deployed Workers.

## Creating an environment

Each needs its own D1 database and R2 bucket:

```bash
npx wrangler d1 create ikengels-testing --location weur
npx wrangler r2 bucket create ikengels-testing-cvs --location weur
```

`--location weur` keeps the data in Western Europe and **cannot be changed after creation**.

Repeat with `ikengels-production` when production is needed. Put the returned `database_id` values
into the environment's config; do not reuse one id across environments.

## Secrets per environment

Every environment gets its **own** `SESSION_SECRET`:

```bash
npx wrangler secret put SESSION_SECRET --env testing
```

Never copy one between environments. If the development machine is compromised, that secret must
not be able to forge a session anywhere else. The same applies to the aggregator keys — testing can
share the Adzuna key with development if you accept the shared daily quota, but be aware they draw
from the same 250 requests per day.

`ALLOW_SIGNUPS` should stay unset on testing and production until you want strangers registering.

## Which environment gets which sources

- **development and testing**: all sources, including the administrator-only page-fetching mode, so
  behaviour can be exercised end to end.
- **production**: consider leaving Careerjet unset (it cannot work from a Worker — see
  `docs/TASKS.md` A2), and think carefully before running page-fetching from a public deployment.
  It is administrator-only and manually triggered, but it runs from Cloudflare's IPs rather than
  yours, which changes who appears to be making the requests.

## Promoting a change

1. Build and test locally against development.
2. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` — all four must pass.
3. Deploy to testing and use it as a real user for a while.
4. Only then deploy to production.

Migrations apply themselves on the first request after deploying, in order, recorded in
`schema_migrations`. They are additive and safe to run against a populated database — migration 7
rebuilds two tables and was verified against the 831-job workspace without loss — but take a
`wrangler d1 export` of production before deploying a migration anyway.

## A caution about the shared local database

Development currently uses `.wrangler/` in the project directory. `npm run dev` from two different
checkouts of this project will share it. If two agents or two copies of the repo are running at
once, they are writing to the same database.
