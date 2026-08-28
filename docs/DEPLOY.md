# Deploying to Cloudflare

The app runs on Cloudflare Workers with D1 (database) and R2 (CV files). The free tier covers it:
100,000 requests/day, 5 GB of D1, 10 GB of R2.

## 1. Create the storage

```bash
npx wrangler d1 create ikengels --location weur
npx wrangler r2 bucket create ikengels-cvs --location weur
```

`--location weur` places the data in Western Europe. **It cannot be changed after creation**, so set
it now if GDPR residency matters to you.

Put the returned `database_id` into `vite.config.ts` in place of
`SITE_CREATOR_PLACEHOLDER_DATABASE_ID`, and set the bucket name alongside it.

## 2. Set the secrets

Never deploy `.dev.vars`; it is a local file and is gitignored. Secrets go to Cloudflare separately:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADZUNA_APP_ID
npx wrangler secret put ADZUNA_APP_KEY
npx wrangler secret put CAREERJET_API_KEY
npx wrangler secret put CAREERJET_REFERER
npx wrangler secret put CAREERJET_USER_IP
```

Generate a fresh `SESSION_SECRET` for production rather than reusing the local one — a leaked local
file should not be able to forge production sessions. Rotating it signs everyone out.

`ALLOW_SIGNUPS` is a plain variable, not a secret. Leave it unset (closed) until you are ready for
other people to register; the first account you create becomes the administrator regardless.

**Careerjet after deploying:** its key is bound to a registered site and a declared IP. A Worker's
outbound IP is Cloudflare's, not yours, so the declared IP will no longer match and Careerjet will
start refusing calls. Either declare Cloudflare's egress range with them, register the real domain,
or accept that Careerjet only works locally. Adzuna has no such restriction.

## 3. Deploy

```bash
npm run build
npx wrangler deploy
```

The schema builds itself on first request: `ensureSchema()` creates the tables and applies every
migration in order. Register the first account immediately after deploying — until an account
exists, registration is open, and the first one created becomes the administrator.

## 4. Turn on the edge protections

In the Cloudflare dashboard, for this zone:

- **Bot Fight Mode** (Security → Bots). Free, and blocks automated traffic before it reaches the
  Worker.
- **Rate limiting rule** on `/api/auth`: 10 requests per minute per IP. The app rate-limits in
  memory, which resets whenever an instance restarts, so this is the durable layer.
- **Always Use HTTPS** and **HSTS**. The session cookie is only marked `Secure` over HTTPS.

## 5. Custom domain

Add the domain in Workers → Settings → Domains & Routes. If the domain is registered elsewhere,
point its nameservers at Cloudflare first.

## Known limits at launch

- No email sending, so password reset is an administrator setting a new password and handing it
  over. There is no self-service "forgot password".
- No email verification on registration.
- In-app rate limiting is per instance and resets on redeploy; the Cloudflare rules above cover it.
- The dashboard loads up to 1,000 jobs in one response. Beyond that the oldest stop being returned,
  and the API would need pagination.
