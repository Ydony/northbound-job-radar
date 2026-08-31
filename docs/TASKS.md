# Task list

Ordered by what blocks dependable local use. Tick items off as they are completed so another
session can continue without reconstructing the state.

## A. Current work — complete in order

### A1. Rotate both administrator logins before any live environment — deferred by decision

Both generated passwords were posted in plain text into a chat transcript. The owner has accepted
that risk for now (2026-08-31) on the grounds that both environments are local-only, bound to
loopback, and hold no third party's data. Work continues using them.

This becomes blocking the moment anything is reachable beyond this machine.

- [ ] Rotate both logins as part of creating the first live environment, before it accepts traffic.
- [ ] Rotate `SESSION_SECRET` for the live environment rather than copying a local one.

### A2. Local environments — done 2026-08-31

- [x] `dev` runs at `http://localhost:3000` with hot reload.
- [x] `test` runs the built Cloudflare Worker locally at `http://localhost:3001`.
- [x] D1 and R2 state are isolated under `.wrangler/dev/state` and `.wrangler/test/state`.
- [x] Session secrets are isolated in `.dev.vars.dev` and `.dev.vars.test`.
- [x] The legacy workspace was copied into test; its original state remains as recovery data.
- [x] Both login pages return HTTP 200 while the two processes run concurrently.

### A3. Exercise the app as a new second user — done 2026-08-31

Both halves are now scripted and repeatable rather than done by hand once.

- [x] `npm run verify:dev` — 14 checks covering registration, CV upload, criteria, authorized
  search and the refusal of restricted mode, pipeline states, language correction, tenant
  isolation, export shape, credential change, session revocation, page rendering, workspace reset,
  and account deletion.
- [x] `npm run verify:admin` — 9 checks covering the administrator half that was previously
  deferred: the overview being counts-only, administration refused to non-admins, promote and
  demote, disable ending a live session immediately, enable restoring access, a password reset
  invalidating the old password, the last-administrator and self-action guards, and deletion.

Each asserts the effect rather than a 200: disabling must end that account's session, a reset must
kill the previous password, and a deleted account must not be able to sign in.

Dev keeps `ALLOW_SIGNUPS=true` because both verifiers create disposable accounts. Test keeps it
false.

### A4. Remove leftover test debris from the test workspace — done 2026-08-31

- [x] Deleted `second@example.test` from test. It held one synthetic CV and no jobs.
- [x] Confirmed test now has one account, `admin-test@ikengels.test`, owning all 1,004 jobs and
  both real CVs.

### A5. Coordinate restarts of the test environment

Reported 2026-08-31: saving criteria in test failed with "NetworkError when attempting to fetch
resource", and settings and admin appeared broken. The failure did not reproduce afterwards. Every
endpoint and page was re-checked and all returned 200 — `/api/account`, `/api/admin`,
`/api/criteria` with five roles, `/settings`, `/admin`, `/sources`, `/privacy`, admin
disable/enable, last-admin protection, and a second account saving its own criteria.

The likely cause is the test Worker being rebuilt or restarted while a browser tab had it open.
`test:local` serves a fixed build, so a restart drops in-flight requests, and a dropped fetch is
exactly what that browser message reports. It is not a code fault, but it will keep happening while
one person uses test and another restarts it.

- [ ] Agree that whoever restarts test says so first, since it interrupts the person using it.
- [ ] If it recurs, capture the browser network tab and the `test:local` terminal output at that
  moment — a status code or a server-side stack trace would distinguish a real fault from a
  restart, and neither was available this time.

### A6. Protect the local test workspace

- [ ] Add a documented, repeatable backup command for the test D1 and R2 state.
- [ ] Verify a restore into a disposable directory without touching test.
- [ ] Decide retention for old backups and make the operation recoverable by default.

### A7. Replace the inline-script CSP allowance with nonces before any public deployment

Fixed 2026-08-31: `script-src 'self'` blocked every inline script React streams for hydration.
Pages rendered server-side, so direct URLs worked, but nothing hydrated — links showed a target on
hover and did nothing on click, and no button or form responded. It reads like a browser or
ad-blocker fault and is not one.

`'unsafe-inline'` is the fix that works in this stack, because there is no middleware here to stamp
a per-request nonce. The exposure is limited while the app is local and single-tenant: all user
data renders through React's escaping and there is no `dangerouslySetInnerHTML` anywhere.

- [ ] Before any public deployment, move to nonce-based script CSP and drop `'unsafe-inline'`.
- [ ] Note that a restart is required after changing `next.config.ts`; dev kept serving the old
  header until it was restarted, which briefly made the fix look ineffective.

## B. Known gaps

### B1. No self-service password reset

There is no mail sender. A locked-out user needs an administrator to set a new password from
`/admin`. The existing unused reset schema should not be exposed until an email provider and a
complete reset flow exist.

### B2. No email verification

Registration is closed by default. If it is opened later, users can currently register an address
they do not own.

### B3. Rate limiting is process-local

`lib/guard.ts` counters reset with the process. This is acceptable for loopback-only use but must
be replaced before any future public hosting.

### B4. The dashboard still loads every job in one response

Partly addressed 2026-08-31. The test workspace had reached 1,004 jobs against a 1,000-row cap, so
four were silently missing from the interface with nothing to indicate it. The limit is now 2,000,
the true total is returned, and the header says "Showing the N most recent of M" whenever the
response is truncated — hiding jobs without saying so was the actual defect.

This buys headroom rather than solving it. The response is ~2 MB at 1,000 jobs and descriptions are
about a third of that, carried only so the client can match required/excluded keywords.

- [ ] Move keyword filtering server-side, or stop sending full descriptions, then paginate.
- [ ] Revisit before any account approaches 2,000 jobs.

### B5. Undutchables is a weak, restricted source

Its `robots.txt` rejects automated requests and it yields very few jobs. Keep the adapter truthful
and administrator/VPN-only; removal remains a reasonable product decision.

### B6. Careerjet licensing and IP scope remain unresolved

Local execution avoids the former Cloudflare static-egress problem, but the API key is still tied
to registered publisher/IP terms. Keep Careerjet disabled when its key or permission is absent and
never describe an unavailable source as searched.

**Registering the real domain closes most of this.** The intended domain is **ikbeneenappel.nl**,
confirmed free (no DNS records as of 2026-08-31). Careerjet binds a key to one registered publisher
website, and the key in use currently names a placeholder domain nobody here owns — that is the
"open question" shown on `/sources`. Registering the real domain with Careerjet, and setting
`CAREERJET_REFERER` to match, moves the integration inside its licensed scope. The declared IP
still has to match wherever the app actually runs, which is fine while it stays local on a stable
connection.

### B7. Product name and domain do not match

The product is called **Ik Engels** throughout the code, the dashboard header, the login page,
`/sources`, `/privacy`, and both READMEs. The intended domain is `ikbeneenappel.nl`. If the name
changes with the domain, decide before writing more user-facing copy — the rename is cheap now and
touches several pages later.

## C. Product improvements, in value order

- [ ] **C1.** Build and label a representative real-ad language corpus.
- [ ] **C2.** Add pagination/server-side job filtering before the test account exceeds 1,000 jobs.
- [ ] **C3.** Expand authorized direct-employer and public ATS feeds.
- [ ] **C4.** Improve cross-source deduplication when posting dates are absent.
- [ ] **C5.** Add alerts/digests only for sources that authorize scheduled discovery.
- [ ] **C6.** Improve Netherlands coverage without LinkedIn or access-control bypasses.

## D. Completed product capabilities

- [x] Multi-user accounts and per-account ownership across user-data tables.
- [x] Session revocation, CSRF checks, security headers, and closed-by-default registration.
- [x] Admin and account settings, including deletion and password changes.
- [x] Two CVs, derived/overridden roles, five general roles, filters, dual fit scoring.
- [x] Saved/applied/dismissed states and durable dismissal tombstones.
- [x] Country/source/result filters and per-source search-run statistics.
- [x] Language corrections preserved separately from detector output.
- [x] JSON/CSV export, job deletion, CV replacement/deletion, and workspace reset.
- [x] Local-only dev/test environment split with no supported hosted environment.
