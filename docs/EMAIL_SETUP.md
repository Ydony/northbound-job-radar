# Email delivery — what the owner has to provide

Verification and password-reset messages go out through [Resend](https://resend.com), over
plain `fetch()` from the Worker. The code is finished and tested; what is missing is a key,
a sender address, and DNS records proving the domain is ours to send from.

Nothing here can be done for you. Two of the three steps are account actions on a service
you own, and the third is a secret that must never reach a chat window, a file in this
repository, a command line or a commit.

## What is already built

- `lib/email.ts` — token issue and consumption, hashing, TTLs (verification 24h, reset 1h),
  and the Resend call. Fully unit-tested against an injected mock; the real API is never
  contacted by the test suite.
- `POST /api/auth` (registration) and `POST /api/account` (email change) send a verification
  message and report `verificationEmailSent`.
- `POST /api/auth/password-reset` sends a reset link, and answers identically whether or not
  the address exists — it must, or it becomes a way to test which addresses have accounts.
- `GET /api/auth/verify?token=…` confirms an address; `POST` to the same route resends.
- **`GET /api/admin/email`** — configuration status and a 24-hour tally of deliveries and
  failures. Administrator only. Reports whether a key is present, never the key.
- **`POST /api/admin/email`** with `{"to":"you@example.com"}` — sends one real message and
  returns Resend's own answer, including its refusal text. This is the thing to run first.

## The three inputs

### 1. A Resend account and a verified sending domain

Sign up at resend.com, add the domain you will send from, and add the DNS records it gives
you (SPF and DKIM, usually three records). Resend will not send from an unverified domain,
and this is the single most common reason a correct key still produces no email.

If `ikbeneenappel.nl` is the sending domain, the records go wherever that domain's DNS is
managed. Verification usually completes within minutes.

### 2. `RESEND_FROM` — the address messages come from

A plain configuration value, not a secret. It must be at the verified domain, and Resend
accepts a display name:

```
RESEND_FROM=Ik ben een appel <noreply@ikbeneenappel.nl>
```

Set it in `.dev.vars.dev` / `.dev.vars.test` for local environments. For production it is an
ordinary `vars` entry.

### 3. `RESEND_API_KEY` — the secret

Create it in the Resend dashboard with **sending permission only**. Then, and only ever this
way:

```
npx wrangler secret put RESEND_API_KEY --name ikbeneenappel-prod
```

For a local environment, paste it into `.dev.vars.dev` or `.dev.vars.test`, which are
gitignored. Never into a commit, a worker prompt, or a chat message.

## Proving it works

Signed in as an administrator, on the environment you configured:

```
GET  /api/admin/email
POST /api/admin/email   {"to":"an address you can read"}
```

`GET` tells you what is still missing. `POST` sends a real message and hands back whatever
Resend said. The failures worth recognising:

| What comes back | What it means |
|---|---|
| `"Resend refused the email (HTTP 401)"` | The key is wrong, revoked, or from another account. |
| `"Resend refused the email (HTTP 403)"` … `domain is not verified` | Step 1 is unfinished, or `RESEND_FROM` is at a different domain. |
| `"Resend refused the email (HTTP 422)"` | `RESEND_FROM` is malformed, or the recipient was rejected. |
| `sent: true` but nothing arrives | Look in spam. A brand-new domain has no sending reputation; this settles. |

After that, the real flows are worth one pass each: register a throwaway account and click
the link, then use *forgot password* and check the reset link works once and only once.

## What is deliberately not configured locally

Dev and test have no `RESEND_API_KEY`, and that is on purpose. With no sender configured,
registration and password reset hand the token straight back in the JSON response on
loopback, so the local harnesses can exercise the whole flow without sending anything to a
real address. Configuring a real key locally would start sending real email from test runs.

Set it in production first. Set it locally only if you specifically want to test delivery,
and prefer Resend's own test addresses if so.

## Where failures show up afterwards

A send that fails in normal use cannot be reported to the caller — the reset route has to
answer identically whichever way it went. The outcome is therefore recorded server-side as
an `auth_events` row (`email-sent` / `email-failed`) and surfaced in `GET /api/admin/email`
as a 24-hour tally.

The *reason* is not recorded: Resend's refusal text can quote the address it refused, and
that table is not scoped to a single account. To find out why, send a test message and read
the answer.
