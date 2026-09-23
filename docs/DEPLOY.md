# Private production deployment

The owner approved a private, single-admin Cloudflare Worker on 2026-09-23.
The independent `ikbeneenappel-prod` D1 exists, but the Worker, first administrator
and custom domain are **not live yet**. This is not approval for open registration
or a public job-search service. Do not deploy to OpenAI Sites or `chatgpt.site`.

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
3. With the owner watching, run `npm run deploy:prod`. Request its
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
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; a 2026-09-24 names-only
check found neither configured. Do not put their values in chat or source files.
The custom `.nl` domain is a separate step after registry delegation is live.

## Before public/open-registration hosting

Treat that as a new security and product project; private deployment does not
satisfy these public-service requirements:

1. Obtain a new explicit owner decision to accept public users.
2. Add durable edge limits, backups, email verification/reset and pagination.
3. Revisit every source policy and Careerjet's fixed-IP restriction.
4. Complete a privacy review for account and behavioural data.
