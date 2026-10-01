# Cloudflare retirement checklist (F8, post-stability)

Why this exists: the VPS takes over serving and the Cloudflare Worker + D1
become a rollback path, then nothing. Recovery must stay available until the
new service has demonstrated stable operation, and every deletion below
happens only on explicit owner instruction — never as a side effect of a
passing check.

Spec: `docs/VPS_MIGRATION_PLAN.md` (§5 old vs new, §6 order of work, step 8:
keep the Worker deployed and idle for a week as a rollback). Tracking: #193
with #194–#201 as VPS-01…VPS-08; cutover itself is #201. The restore drill
this checklist depends on is specified in `docs/DEPLOY.md` ("Self-hosted
target: continuous backup and restore", #200) and rehearsed synthetically by
`npm run verify:sqlite-restore`.

Nothing here touches production. Evidence is assembled from VPS-side
observations and recorded on the tracker; this file is the checklist, not
the evidence.

## 0. Preconditions (none of the gates below run without these)

- [ ] Cutover (#201) is done: DNS serves the VPS, and the Worker is deployed
      and idle as the rollback path per the migration plan §6 step 8.
- [ ] The owner has selected an observation period in days and recorded it on
      the tracker (F8 "Done when", first bullet). No default is assumed here:
      until the owner writes the number down, every gate below reports
      `observation-period-unset` and retirement is blocked.
- [ ] `npm run verify:retirement-readiness -- <evidence.json>` passes on the
      assembled evidence file (synthetic rehearsal:
      `npm run verify:retirement-readiness -- --example-pass` must pass and
      `--example-blocked` must fail). The script checks the shape of the
      evidence, never production.

## 1. Stability review for the observation period

For the exact window the owner selected, review all four — a quiet week means
nothing if one of them was never looked at:

- [ ] **Search failures:** every `POST /api/scrape` failure and every
      per-source `blocked`/`failed` status in the window is listed, with cause
      (upstream refusal vs VPS fault). VPS-caused failures are fixed and the
      fix has itself survived a search run. (Context: #192 — the 50-subrequest
      wall the VPS is the fix for — must not reappear in another form.)
- [ ] **Restarts:** `systemctl show ikbeneenappel-web.service -p NRestarts`
      (plus the refresh unit) for the window, with each unexpected restart
      explained. OOM or crash-loop restarts block retirement regardless of age.
- [ ] **Backup age:** the remote Litestream prefix holds snapshots and WAL
      segments minutes old at review time, and the youngest backup in the
      window is never older than the interval the owner accepted at #200.
      A green unit with a stale bucket is a failure, not a pass.
- [ ] **Storage growth:** database size and object-storage usage at window
      start vs end, with headroom for the retention window (30 days). Growth
      that would exhaust disk or leave the free storage tier inside retention
      blocks retirement until provisioned.

Each item records *reviewed-by and date*, not just a number: an unreviewed
metric is a failed gate (`lib/retirement-readiness.ts` treats a missing
`reviewedAt` the same as a missing value).

## 2. Recovery prerequisites (both must hold on the day of the decision)

- [ ] **A real off-box restore is still usable.** Re-run the full drill from
      `docs/DEPLOY.md` on the VPS: stop the units, `litestream restore` into a
      scratch path (never over the live file), confirm `schema_migrations`
      version, `integrity_check = ok`, per-table counts match, serve one real
      account's dashboard from the scratch copy on a throwaway port, delete the
      scratch copy, restart replication then web. Record version, counts and the
      dashboard load as restore evidence. A restore older than the observation
      period — or any truncated-restore symptom (`file is not a database`,
      `malformed`, short counts) — blocks retirement.
- [ ] **VPS production evidence is correct.** The served app version matches
      the deployed commit, `/api/state` serves the account's dashboard, and
      security headers (including `X-Robots-Tag: noindex, …`) verify as in
      `docs/DEPLOY.md`. Evidence that describes the wrong host, commit or
      database is not evidence.

## 3. Secrets and resources inventory (private, never in this repo)

- [ ] The owner holds a private inventory of everything Cloudflare-side that
      retirement would touch: Worker name, D1 database id, secrets present
      (`wrangler secret list` shows names only — record names, never values),
      custom-domain bindings, redirect rules, and any CI secrets
      (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
- [ ] The inventory lives outside this repository, issues and transcripts.
      This checklist records only *that* it exists and its date — a missing
      inventory reference blocks every deletion gate.

## 4. Explicit owner deletion gates (ordered, each gated separately)

Retirement runs in this order, and each step waits for its own explicit owner
instruction. A pass on gates 0–2 authorizes *deciding*, never deleting.

| # | Action | Gate: proceeds only when |
|---|--------|--------------------------|
| D1 | Remove DNS / tunnel cutover leftovers pointing at Cloudflare | Owner names the records and says "remove" |
| D2 | Delete the idle Cloudflare Worker (rollback path) | Owner confirms the VPS served the full observation period alone, then says "delete the Worker" |
| D3 | Delete the Cloudflare D1 database | Owner confirms D2 plus a fresh off-box restore *after* D2, then says "delete D1" |
| D4 | Remove Cloudflare-side secrets and CI deploy secrets | Owner confirms D2–D3, then says "remove the secrets" |
| D5 | Close or downgrade the Cloudflare account scope used for this project | Owner says so, last, after D1–D4 are confirmed gone |

Rules for every D-step: quote the owner's instruction (date + channel) on the
tracker before acting; act on exactly what was instructed; re-verify the VPS
serves after each step. If any step reveals the VPS depends on something
Cloudflare-side, stop — the checklist re-opens at gate 1 with a new
observation period.

## 5. After retirement

- [ ] Confirm the VPS serves alone (dashboard load + one search run).
- [ ] Confirm the next Litestream backup and the next systemd timer tick both
      succeed with nothing Cloudflare-side left to succeed quietly behind them.
- [ ] Close #193 only when D1–D5 are each evidenced on the tracker.
