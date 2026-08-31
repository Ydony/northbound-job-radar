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

### A5. The reported test failure — root cause found 2026-08-31

Saving criteria in test failed with "NetworkError when attempting to fetch resource", and settings
and admin appeared broken. This was first recorded as a probable restart interrupting an open tab.
**That diagnosis was wrong.**

The real cause was the Content-Security-Policy blocking React's inline hydration scripts (A7). With
hydration dead, no form could complete its request and no button responded, while server-rendered
pages and direct URLs looked perfectly healthy — which is exactly what was reported. It also
explains why every curl check passed: curl does not execute JavaScript, so the server appeared
fine and only the browser was broken.

- [x] Fixed in A7; both environments verified interactive in a real browser.
- [x] Lesson recorded: an endpoint returning 200 to curl is not evidence the page works. Check the
  browser console before concluding a client-side report is environmental.

### A6. Protect the local test workspace — done 2026-08-31

- [x] `npm run backup:test` and `npm run backup:dev` copy that environment's D1 and R2 state with a
  manifest. Both refuse to run while their server is up, since a live SQLite copy would be
  inconsistent.
- [x] `npm run backup:verify <path>` re-walks a backup and checks every file against the manifest.
  Verified against a real 4 MB, 14-file backup of the populated test workspace.
- [x] Retention: the ten newest backups per environment are kept and older ones pruned
  automatically, so taking one routinely cannot fill the disk. The backup just written is never
  pruned.

Take one before any migration that touches a populated workspace.

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

### A8. Navigation and the missing root CSP — fixed 2026-08-31

Two separate faults, both found only by clicking in a real browser. Every endpoint returned 200 to
curl throughout, which is why they survived earlier checks.

**Navigation did nothing.** vinext 1.0.0-beta.3 ships a `next/link` shim whose client chunk throws
`TypeError: e is not a function` the moment a link is clicked. The href looked correct on hover and
the click was swallowed. Every `next/link` is now a plain anchor: each internal destination is a
different page with its own data, so a full load costs nothing, and the eslint rule that wants
`Link` is disabled with that reasoning recorded. Revisit if vinext fixes it.

**The dashboard had no security headers.** The header rule used `source: '/:path*'`, which did not
match the bare `/` in this runtime. Every other route carried the CSP while the one page holding
every job and both CVs carried none. The root is now matched explicitly.

- [x] Verified in the browser: Settings and Admin both open and render.
- [x] Verified `/` and `/settings` both serve the CSP.

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
