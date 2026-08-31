# Hosting status

Ik Engels is intentionally local-only. Do not deploy it to OpenAI Sites, `chatgpt.site`,
Cloudflare Workers, or another public host unless the owner makes a new explicit decision.

The supported environments are documented in `docs/ENVIRONMENTS.md`:

- `dev` at `http://localhost:3000`
- `test` at `http://localhost:3001`

Both use local D1 and R2 emulation with separate storage. CV files, extracted CV text, jobs,
accounts, and search history remain on this computer under ignored `.wrangler/` state.

The short-lived hosted test created on 2026-08-31 was removed from public access and is not a
supported environment. `.openai/hosting.json` contains logical local binding names only and no
hosted project identifier.

## If hosting is reconsidered later

Treat that as a new security and product project. Before any deployment:

1. Get explicit owner approval for the hosting provider and public URL.
2. Create independent remote D1 and R2 resources; never point a deployment at local test data.
3. Generate a new remote `SESSION_SECRET`.
4. Add durable edge rate limits, backups, email verification/reset, and pagination.
5. Revisit every source policy and Careerjet's fixed-IP restriction.
6. Complete a privacy/GDPR review for CV and behavioural data.

Until then, no deploy command is part of the supported workflow.
