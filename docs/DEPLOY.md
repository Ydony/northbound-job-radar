# Private production deployment

> **A self-hosted alternative is proposed, not decided (2026-09-27, #193).** Everything
> below describes the Cloudflare Worker deployment, which is what production runs. The VPS
> path — Node 22, SQLite behind a `D1Database` adapter, systemd, nginx, Cloudflare Tunnel —
> is specified in `docs/VPS_MIGRATION_PLAN.md`, tracked by #193 with #194–#201, and gated on
> an owner scope decision. When #201 cuts over, the restore procedure from #200 belongs in
> this file and the Worker steps below become the rollback path, not the primary one.

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
nofollow, nosnippet, noimageindex`. `https://www.ikbeneenappel.nl` redirects
(301, path and query preserved) to the apex via a Cloudflare Redirect Rule —
configured in the Cloudflare dashboard (Rules → Redirect Rules, "Redirect
from WWW to root" template), not in this repo. Verified 2026-09-24.
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
   Verification/reset email needs `RESEND_API_KEY` (also via `wrangler secret put`)
   and a `RESEND_FROM` sender, but only once registration opens — the closed
   single-admin installation does not send email.
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

## Self-hosted target: continuous backup and restore (VPS-07, #200)

D1 was managed — backups were Cloudflare's problem. On the VPS they are
ours, and this is the single largest new operational risk in #193.

**Setup.** Litestream tails the SQLite WAL and replicates every
checkpointed page off-box within seconds (config
`deploy/litestream.yml`, sidecar unit
`deploy/ikbeneenappel-litestream.service`). Off-box is the requirement: a
replica on the same disk as the database is not a backup. Credentials live
in the same root-owned `0600` EnvironmentFile as the web unit and never in
the repo. Retention is 30 days — long enough to survive a defect that is
not noticed the same day, short enough to stay inside the object-storage
free tier at this database size. Verify replication by inspecting the
remote bucket, not by assuming the unit is green:

```bash
systemctl status ikbeneenappel-litestream.service
# then list the remote prefix — snapshots and WAL segments must be minutes old
```

A nightly `cp` is explicitly not the backup: WAL mode keeps recent writes
outside the main file, and a copy taken mid-write is a truncated database.
That is why the restore drill below exists.

**Restore procedure (rehearse before cutover, #201).** The restored copy
holds real account data: it is a throwaway instance for proving the
backup, never a second live one, and nothing from it goes into the repo,
an issue, or a transcript.

```bash
# 1. Stop both units so nothing writes during the restore.
sudo systemctl stop ikbeneenappel-web.service ikbeneenappel-refresh.service \
  ikbeneenappel-litestream.service

# 2. Restore into a SCRATCH path — never over the live file.
sudo -u ikbeneenappel litestream restore \
  -config /etc/ikbeneenappel/litestream.yml \
  -o /var/lib/ikbeneenappel/restore-drill.sqlite

# 3. Confirm the schema version matches production (currently 31; compare
#    against the live file, not from memory).
sudo -u ikbeneenappel sqlite3 /var/lib/ikbeneenappel/restore-drill.sqlite \
  "SELECT MAX(version) FROM schema_migrations;"
sudo -u ikbeneenappel sqlite3 /var/lib/ikbeneenappel/restore-drill.sqlite \
  "PRAGMA integrity_check;"
# expected: the same version number, then a single line reading `ok`

# 4. Confirm row counts match the live file, per table.
for t in users vacancies vacancy_sources user_vacancy_state jobs; do
  echo -n "$t live/restored: "
  echo "$(sudo -u ikbeneenappel sqlite3 "$SQLITE_PATH" "SELECT COUNT(*) FROM $t;") / \
$(sudo -u ikbeneenappel sqlite3 /var/lib/ikbeneenappel/restore-drill.sqlite "SELECT COUNT(*) FROM $t;")"
done

# 5. Serve the app from the scratch copy and load one real account's
#    dashboard over it (SQLITE_PATH pointed at the scratch file on a
#    throwaway port — never the live unit). Record the version, the counts
#    and the dashboard load as restore evidence on #200.

# 6. Delete the scratch copy, restart replication, then the web unit.
rm /var/lib/ikbeneenappel/restore-drill.sqlite*
sudo systemctl start ikbeneenappel-litestream.service ikbeneenappel-web.service
```

**Good vs truncated restore.** A good restore prints the expected
`schema_migrations` version, `integrity_check` returns one line reading
`ok`, every per-table count matches the live file, and the scratch
instance serves the account's dashboard. A truncated restore fails loudly
instead: SQLite refuses to open the file (`file is not a database`) or
`integrity_check` reports `database disk image is malformed`, or counts
come back short. Any of those means the backup path is broken — do not
cut over (#201) until a restore passes end to end.

**Synthetic rehearsal.** `node --import tsx
scripts/verify-sqlite-restore.mjs` runs the shape of this drill on
throwaway synthetic data (checkpoint, copy standing in for the replica,
restore into scratch, version/counts/`integrity_check`/catalogue join).
It proves the procedure's logic, not the VPS's replication — the real
drill above still has to run on the server before cutover.

## Operational review across the observation period (F8, T24)

The old Cloudflare deployment stays as a rollback until the VPS has shown
stable operation over an owner-selected observation period. The review
instrument is `npm run check:ops`, and it is host-free on purpose: it
never shells out, never reads EnvironmentFiles, and rejects any evidence
file containing a secret-like key — so a pasted secret can never become a
"passing check" or a transcript leak. The owner collects four numbers on
the VPS and evaluates them anywhere:

```bash
npm run check:ops -- --print-collection   # the exact VPS collection commands
npm run check:ops -- --evidence /tmp/ops-evidence.json
```

The evidence file holds timestamps, restart counts and byte counts only
(services active/restarts, refresh tick outcomes as printed by
`scripts/run-refresh.mjs`, newest replica timestamp from the bucket
listing, database size and free disk). Exit codes are 0 pass, 2 warnings
only, 1 any failure. The same run also checks the deploy artifacts
themselves — refresh timer on the 6-hour cadence, Litestream 30-day
retention, oneshot collector, restart-on-failure web unit, the nginx auth
brake — so configuration drift fails loudly too.

What the alerts mean: a replica older than 1h means Litestream has
stalled (it syncs every 10s); older than 24h blocks cutover and
retirement until a real restore passes. No successful refresh within
two cadences (12h) means scheduled collection is broken, not late; any
restart or failed tick in the period is a warning the retirement review
must explain. Database growth past 500 MB or free disk under 5 GB is a
warning; past 2 GB or under 1 GB fails. The off-box restore drill above
and the retirement/deletion decision itself stay owner-run and are
recorded on the F8 record, not in this output.

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
5. Before open registration, set the real Turnstile keys: `npx wrangler secret put
   TURNSTILE_SECRET_KEY --name ikbeneenappel-prod` for the secret, and the matching public
   sitekey as `TURNSTILE_SITE_KEY`. Without a real secret the app honors its committed test
   keys on loopback only and refuses non-local registration, so this step is what actually arms
   the bot check. The `AUTH_RATE_LIMIT` edge binding (namespace `17101`) ships in the Worker
   configuration; no dashboard step is needed for it.
