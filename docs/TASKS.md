# Task list

Ordered by what blocks launch. Everything here was identified from the code as it stands on
2026-08-28; tick items off in this file as they are done so the next session can see the state.

---

## A. Blocking — must be done before the first public deployment

### A1. Take ownership of the admin account
The workspace (831 jobs, 2 real CVs) is currently owned by a throwaway account created during
testing: `owner@example.test` / `a-long-test-password`. Sign in, go to `/settings`, change both the
email and the password. Changing the password now also signs out every other session.

Then delete the second test account (`second@example.test`) from `/admin`; it exists only to prove
tenant isolation.

### A2. Decide what happens to Careerjet in production
**Cloudflare Workers have no static outbound IP on the free or paid Workers plans.** A Worker's
`fetch()` egresses from Cloudflare's shared pool. Dedicated egress IPs exist but are a Cloudflare
One / Smart Shield add-on, not part of Workers.

Careerjet binds its API key to **at most 8 declared IP addresses**, so Cloudflare's shared range
cannot be declared. Careerjet will therefore stop working the moment it runs from a Worker. Pick one:

- **Drop Careerjet in production.** Adzuna covers both countries with no IP restriction, and
  Job-Room plus the 61 company boards need no key at all. This is the cheapest option and loses
  roughly 160 jobs per run.
- **Keep Careerjet local only.** Leave `CAREERJET_API_KEY` unset in production. It keeps working on
  the development machine where the IP is stable.
- **Proxy it.** Run the Careerjet call from a small fixed-IP host and have the Worker call that.
  Adds a component to run and secure.

Whatever is chosen, the source must report itself honestly rather than failing silently — it
already does, but confirm after deploying.

### A3. Create the two environments (see `docs/ENVIRONMENTS.md`)
Development and testing must not share a database, or testing will destroy the real workspace.

### A4. Set production secrets
Generate a **new** `SESSION_SECRET` for each environment rather than copying the local one. A
leaked development file must not be able to forge testing or production sessions.

### A5. Decide on registration
`ALLOW_SIGNUPS` is unset (closed) by default. Leave it closed until the app is meant to be public.
The first account created on a fresh database becomes the administrator regardless.

---

## B. Known gaps — the app works without these, but they matter for real users

### B1. No self-service password reset
There is no mail sender, so a locked-out user must ask an administrator to set a new password from
`/admin`. The `password_resets` table and token columns already exist, unused. Wiring this needs an
email provider (Resend, Postmark, MailChannels) and a `/reset` page.

### B2. No email verification
Anyone can register with an address they do not own. Matters as soon as registration opens.

### B3. Rate limiting is per instance
`lib/guard.ts` holds counters in memory, so they reset whenever a Worker instance recycles. The
Cloudflare dashboard rules in `docs/DEPLOY.md` are the durable layer and should be configured
before opening registration. Moving the counters into D1 would make them survive, at the cost of a
write per request.

### B4. The dashboard loads up to 1,000 jobs in one response
`app/api/state/route.ts` caps at 1,000 rows, about 1.7 MB. Past that the oldest jobs silently stop
appearing. Needs pagination or server-side filtering before any account grows beyond it. The
current owner account is at 831.

### B5. Undutchables should probably be removed
It is the weakest source in use: its `robots.txt` answers automated requests with HTTP 403, meaning
the site actively blocks this kind of traffic, and it yields 3 jobs. See `/sources`.

### B6. No backups
D1 has no automatic backup on the free tier. A `wrangler d1 export` on a schedule would cover it.

---

## C. Product improvements, in rough value order

- **C1.** Wire the language corpus properly: the gate has 88 tests but no labelled corpus of real
  ads. `docs/ROADMAP.md` makes this the Phase 0 exit criterion and it is still open.
- **C2.** Expand the company boards. `lib/ats-feeds.ts` holds 61 verified boards and documents how
  to add more; the probe pattern is in the git history. Direct employers are far higher yield than
  staffing agencies (measured: On 309 postings, Adecco 2).
- **C3.** Job alerts or a digest, so a user does not have to press the button.
- **C4.** Deduplicate across sources more aggressively; the fingerprint currently requires a
  posting date, so ads without one are never cross-matched.
- **C5.** Netherlands coverage is still thinner than Switzerland (163 vs 466 jobs). Job-Room has no
  Dutch equivalent — werk.nl is behind an SSO gateway and has no API.

---

## D. Done — for context, do not redo

- Multi-user accounts, per-account isolation of every table, verified live.
- Session cookies with revocation (epoch), CSRF origin checks, security headers, robots.txt.
- Admin panel: disable, enable, promote, demote, reset password, delete, with audit records.
- Account settings: change email, change password, delete account and all data.
- Cookieless visit counting (daily total and unique), with the privacy properties under test.
- Privacy/GDPR page and a sources/transparency page, both written from the code.
- Page-fetching restricted to administrators, enforced server-side, with source names withheld
  from everyone else.
- 61 public company career boards, Job-Room, Adzuna, Careerjet.
