# Task list

Ordered by what blocks dependable local use. Tick items off as they are completed so another
session can continue without reconstructing the state.

## A. Current work — complete in order

### A1. Owner changes BOTH administrator logins (exposed, not merely temporary)

The populated test workspace is owned by `admin-test@ikengels.test`; dev is owned by
`admin-dev@ikengels.test`. **Both generated passwords were posted in plain text into a chat
transcript**, so they are exposed rather than merely temporary, and both need replacing — not just
test.

- [ ] Change the email and password at `http://localhost:3001/settings` (test).
- [ ] Change the email and password at `http://localhost:3000/settings` (dev).

Changing a password revokes that account's other sessions. Never write these into a file, a commit,
or a chat message.

This is the only step that requires the owner. Coding and testing may continue while it is pending.

### A2. Local environments — done 2026-08-31

- [x] `dev` runs at `http://localhost:3000` with hot reload.
- [x] `test` runs the built Cloudflare Worker locally at `http://localhost:3001`.
- [x] D1 and R2 state are isolated under `.wrangler/dev/state` and `.wrangler/test/state`.
- [x] Session secrets are isolated in `.dev.vars.dev` and `.dev.vars.test`.
- [x] The legacy workspace was copied into test; its original state remains as recovery data.
- [x] Both login pages return HTTP 200 while the two processes run concurrently.

### A3. Exercise the existing app as a new second user

Dev's database is empty, which is the point: exercising freshly created data is what surfaces the
write paths that adopted data never touches. That is how a completely broken CV upload went
unnoticed before. Set `ALLOW_SIGNUPS=true` in `.dev.vars.dev` to create the second account.

- [ ] Create a non-admin account in dev and upload a new CV.
- [ ] Save criteria and exercise default and VPN/restricted search modes.
- [ ] Save, apply, dismiss, restore, correct a verdict, export, delete, and reset.
- [ ] Attempt to read and change another account's jobs by id and confirm isolation.
- [ ] Exercise settings and every admin action, including last-admin protection.
- [ ] Render `/`, `/login`, `/settings`, `/admin`, `/sources`, and `/privacy` and reconcile their
  claims with the code.
- [ ] Report findings before making Phase 2 bug fixes; add regression tests for every fix.

### A4. Remove leftover test debris from the test workspace

The test workspace still contains `second@example.test`, an account created during an earlier
isolation check. It holds one synthetic CV and no jobs. Test is the environment used as a real
user, so it should not carry debris from development.

- [ ] Delete `second@example.test` from `http://localhost:3001/admin`.
- [ ] Confirm the remaining account is the owner's and holds the 916-job workspace.

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

### B4. The dashboard caps state at 1,000 jobs

`GET /api/state` returns at most 1,000 rows. The populated test account has 916, so pagination or
server-side filtering is the next capacity requirement.

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
