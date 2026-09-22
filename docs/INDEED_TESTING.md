# Indeed: local setup and everyday use

Indeed is an explicitly configured, local-administrator integration. No phone, personal
Indeed login, VPN verification or separate readiness request is required for a normal search.
It is not a public service or an unlimited catalogue API.

## One-time setup

Run from the checkout you intend to use, not a similarly named copy. Node 22.13+ is required.

```text
npm run init-secrets
npm run indeed -- setup --env test --approved-jobspy
```

This explicit option uses the owner's approved experimental profile from JobSpy revision
`fda080a373e8226f3fd60635323f5da9af9892b1`. It downloads configuration as data (never executes
the Python file), validates it, and saves the three profile values plus the three enable flags
in ignored `.dev.vars.test`. It preserves all other settings and the session secret. There is
no bundled key in Git and no download on subsequent searches. This is the profile provenance
behind the successful September 19/21 experiments, not a provider-issued partnership credential.
The owner reports permission; public redistribution rights and profile lifetime are not established.

Alternatively, omit `--approved-jobspy` and supply a JSON object on standard input containing
`INDEED_API_KEY`, `INDEED_USER_AGENT`, and `INDEED_APP_INFO`. Do not put secrets in command arguments,
chat, Git or logs. Configure `--env dev` separately if wanted. Restart only the selected server
once after setup, using `npm run test:local` or `npm run dev`; coordinate the restart if it is in use.
Do not copy databases between environments or reset them.

## Click to search

Sign into the app as an administrator, save your role keywords and countries, then click
**Search Indeed only**. No **Check readiness** click is needed. The check button is optional
diagnostics and sends no Indeed request. Results are screened, deduplicated and saved in that
account. Use All with English confirmed for passing jobs (the default arrival); New shows only additions since the latest search under the chosen language filter.
Previously saved/applied/dismissed jobs retain those states. A repeat search can legitimately add zero.

## Call from another LLM or a script

Authenticate once to **this app**, not to Indeed. Supply an existing administrator's email/password
as JSON on standard input to:

```text
node scripts/indeed.mjs login --env test
```

Use a protected input source or an interactive agent's secret handling, not a literal password
in shell history. The client saves only an app session under `.wrangler/indeed-client/test.json`.
It is bound to the exact loopback origin; dev and test files are separate. Treat this file as a
credential. POSIX creation modes are owner-only; on Windows protect the checkout with your user ACL.

Every subsequent owner-requested search is one command:

```text
npm run indeed -- search --env test
```

For machine-readable stdout without npm's banner:

```text
node scripts/indeed.mjs search --env test
```

An alternate isolated port can be selected with `--url http://127.0.0.1:3114`, on both login
and search. Defaults are dev 3000 and test 3001. The running app and saved criteria are required.
There is no preflight, phone probe, test suite or credential re-entry on a search. The server
still authenticates the current account on every request; demotion, disablement, logout and
expiry are respected. A new login is needed after expiry/revocation, not before every search.

Output contains `ok`, `added` job cards, `scanned`, `alreadyKnown`, and the persisted per-country
`run` report. `added` excludes previously known jobs; description text stays on the server,
while description length, requirements, verdict, dates and original links are returned.
Exit 0 means at least one source returned a complete/partial result; exit 2 means no source
could run (configuration/cooldown/refusal); exit 1 means a local/authentication/protocol error.
Check per-source statuses: `ok` does not mean exhaustive coverage or that every job passed.

Node callers can import `createIndeedOperator` from `scripts/indeed-operator.mjs` and call
`search()` with `{baseUrl, cookie}`. Do not print the cookie. The underlying HTTP operation is
authenticated `POST /api/scrape` with `{"mode":"authorized","sourceGroup":"indeed"}` and a
matching Origin header. It streams progress followed by the final JSON result. No new bypass
endpoint or separate job store exists. Saved roles/countries are editable in the dashboard or
through the existing authenticated `PUT /api/criteria` contract.

## Indeed place and distance (administrator only)

Each admin account holds its own Indeed place per selected country plus a distance in
kilometres: `GET`/`PUT /api/admin/indeed/settings` (admin session required; ordinary
accounts get 403 and can neither read nor modify these). Defaults are Amsterdam,
Netherlands and Switzerland at 16 km, which converts to the 10 provider miles the
collector used before settings existed — an account that never touches them searches
exactly what it searched before. The collector sends integer miles; only the first two
distinct saved role queries are searched, the five shared role inputs unchanged. Any
place or distance change gives later searches a new query identity, so incremental
coverage never applies to a different query. Settings ride along in admin `/api/state`
only, are deleted with the account/workspace, and never reach ordinary accounts.
Website editing controls arrive with #116; until then the API is the interface.

## Limits, disconnect and troubleshooting

- First two distinct saved roles; selected NL/CH countries only; 25 rows per role/country.
  Maximum four upstream requests/100 returned rows per click. Only jobs posted in the last
  seven days are kept (older rows are dropped, undated rows stay); the window is applied
  locally because upstream relevance ordering is unverified. This is a bounded sample, not
  200–400 jobs, guaranteed new jobs, or exhaustive paging. No unattended schedule is added.
- A shared durable lease prevents concurrent runs. A normal run has a 60-second cooldown;
  provider Retry-After can require longer. No automatic retry or IP/profile rotation.
- 401/403, redirects and malformed responses pause collection for operator review. Do not
  clear that pause or switch identities to retry a refusal. Correct configuration only after
  reviewing the cause/permission with the provider; setup deliberately does not clear the latch.
- `npm run indeed -- status --env test` is optional read-only diagnostics.
- `npm run indeed -- logout --env test` revokes/removes the CLI session. To disable collection
  for all admins in one environment, set `INDEED_ENABLED=false` in its ignored vars file and
  restart that environment. Remove its three profile values when they are no longer wanted.
- Missing configuration: run setup once and restart. Expired app session: login again.
  No server: start the selected environment. Interrupted stream: inspect history before a
  manual retry because earlier jobs might already have been saved.
- Key/profile renewal has no automatic OAuth flow. Reconfigure only an explicitly approved
  replacement; repeated setup with the same pinned profile does not establish renewed access.
- Phone USB debugging and the phone app are unnecessary for normal use; temporary phone
  assessment settings can be restored. No phone tokens or account cookies were extracted.

## Verification evidence, not a prerequisite for searching

2026-09-21: built-runtime CLI login, saved-session search with no readiness preflight,
25 Dutch rows returned, 12 known, 2 newly saved (one pass, one review).
The same command also returned 25 rows and saved 14 jobs in isolated hot-reload dev. A browser
click without readiness returned 25 rows, recognised 14 known jobs, and added no duplicates.
All 353 unit/integration tests, lint, typecheck and the final build passed. A build while the disposable built
server held its output failed with Windows EPERM; stop that disposable server before rebuilding.
The owner servers must not be stopped to fix a worktree's build lock.

Earlier integrated
live run returned 25 Dutch + 25 Swiss rows in two requests and saved 27 descriptions of
2,692–8,200 characters. Live evidence is a small sample, not a long-term availability guarantee.

Automated regression tests exercise direct invocation, safe config updates, local-only URL
validation, truncated responses, no automatic retries, and the immediately enabled UI button.
`scripts/verify-indeed-workflow.mjs` is a separate synthetic developer harness, never called
by the operator module. It requires fresh disposable signup-enabled storage with Indeed
disabled. It covers two accounts, hidden/private records, demotion, guessed IDs, corrections,
saved/applied/dismissed retention and reset isolation. It passed against the final built Worker
on fresh disposable storage at port 3115, with no upstream requests. Do not run it on the owner's workspace.
