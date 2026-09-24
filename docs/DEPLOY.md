# Private production deployment

The owner approved a private, single-admin Cloudflare Worker on 2026-09-23.
The independent `ikbeneenappel-prod` D1 and first Worker version exist at
`https://ikbeneenappel-prod.anddonatas.workers.dev`. The owner-only Worker
secrets and sole administrator are configured; an actual production sign-in
returned HTTP 200 with an admin session on 2026-09-24. Cloudflare accepted
`ikbeneenappel.nl` as a custom domain after the owner removed the conflicting
apex A record. Verified independently on 2026-09-24: the .nl registry now
delegates to Cloudflare (`samara.ns.cloudflare.com`/`leonard.ns.cloudflare.com`),
and `https://ikbeneenappel.nl` and `/login` both return HTTP 200 with a valid
certificate and the full security-header set including `X-Robots-Tag: noindex,
nofollow, nosnippet, noimageindex`. `https://www.ikbeneenappel.nl` is not yet
working — Cloudflare proxies it (a DNS record exists) but returns 522, because
no redirect or Worker route is configured for that hostname. A CNAME alone
does not create a redirect; this needs either a Cloudflare Redirect Rule or a
host-aware redirect in the Worker, done as a separate follow-up.
This is not approval for open registration
or a public job-search service. Do not deploy to OpenAI Sites or `chatgpt.site`.

Production password recovery is `npm run reset:prod-admin-password` after
`npm run build:prod`. It refuses anything other than exactly one active admin,
generates a temporary password, revokes existing sessions, and prints it only
after verifying the remote D1 hash. The owner must change it in Settings.
Workers caps PBKDF2 at 100,000 iterations, so all newly created hashes use that
limit. Older 210,000-iteration local hashes cannot authenticate on the hosted
Worker; do not copy local users to production. Before opening public sign-ups,
replace this compatibility compromise with a reviewed password-hashing scheme.

The supported environments are documented in `docs/ENVIRONMENTS.md`:

- `dev` at `http://localhost:3000`
- `test` at `http://localhost:3001`

Both local environments use separate D1 emulation. Their jobs, accounts and search
history remain on this computer under ignored `.wrangler/` state. The remote D1
starts empty and must never be seeded from TEST. In-project recovery snapshots
were scrubbed of CV data on 2026-09-23; external copies were not inventoried.

The short-lived hosted test created on 2026-08-31 was removed from public access and is not a
supported environment. `.openai/hosting.json` contains logical local binding names only and no
hosted project identifier.

## First private release — with the owner present

1. The owner sets a fresh production `SESSION_SECRET` and `ALLOW_SIGNUPS=false`
   through `npx wrangler secret put ... --name ikbeneenappel-prod`. Do not paste
   secret values into chat, Git, shell arguments or assistant tools. Optionally
   set Adzuna credentials; **never** copy Careerjet or Indeed credentials to prod.
   `npx wrangler secret list --name ikbeneenappel-prod` exposes names only for review.
2. Build and verify without deploying: `npm run build:prod`. The generated
   Worker must be `ikbeneenappel-prod` and its D1 id
   `b0a513c7-0d01-486c-8b16-5cdb6690c959`.
3. The first `npm run deploy:prod` succeeded on 2026-09-24. For a future
   approved release, run it with the owner watching. Request its
   `workers.dev/api/state` URL once so `ensureSchema()` applies migrations;
   signed-out HTTP 401 is expected. Merely opening `/login` does not apply the
   schema. Check the migration count remotely.
4. Run `npm run bootstrap:prod-admin -- --dry-run` first using synthetic credentials.
   Then run `npm run bootstrap:prod-admin` in a local terminal; it prompts for
   the owner's email and a hidden password. Never pass either as an argument.
   The script refuses an existing user and leaves the HTTP first-signup block intact.
5. Sign in and verify the empty workspace, rejected second signup, source
   availability and security headers. Record the exact verified URL and findings
   in `docs/HANDOFF.md`. Do not approve the CI production deployment gate early.

The deployment workflow builds on pushes to master, but its `production`
environment needs the owner's explicit GitHub approval before the deploy job.
Before approving it, the owner must also add repository Actions secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. A later 2026-09-24
names-only check found both configured, but did not verify their values or
permissions. Do not put their values in chat or source files.
The custom `.nl` domain is attached and verified working (see above);
`www.ikbeneenappel.nl` still needs its own redirect, tracked separately.

## Keep the private site out of search results

All pages carry robots metadata and all page/API responses carry `X-Robots-Tag:
noindex, nofollow, nosnippet, noimageindex` through `next.config.ts`. Static assets
receive the same header through `public/_headers`. `public/robots.txt` allows
fetching so compliant crawlers can read the noindex directives; a blanket
Disallow would prevent that and can leave bare URLs indexed. No sitemap is
advertised. This applies to both the Worker URL and any attached custom domain.
Login and closed registration protect account data; crawler instructions are
not access control or a guarantee against discovery by noncompliant crawlers.
Remove the directives only after an explicit owner decision to allow indexing.

## Before public/open-registration hosting

Treat that as a new security and product project; private deployment does not
satisfy these public-service requirements:

1. Obtain a new explicit owner decision to accept public users.
2. Add durable edge limits, backups, email verification/reset and pagination.
3. Revisit every source policy and Careerjet's fixed-IP restriction.
4. Complete a privacy review for account and behavioural data.
