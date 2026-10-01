# VPS release and rollback (T03, F1)

Owner-triggered release process for the self-hosted target specified in
`docs/VPS_MIGRATION_PLAN.md`. This is preparation (T01–T04): it proves the
procedure's shape on synthetic fixtures, not the real host. F1 acceptance
stays pending until the owner checkpoints — rented VPS, supplied host
configuration, authorized provisioning, and an executed backup restore and
capacity walkthrough — are evidenced.

## Why two workflows, both manual

| Workflow | Trigger | Environment | Target |
|---|---|---|---|
| `release-vps.yml` | `workflow_dispatch` only | `production-vps` | The VPS (primary once cut over, #201) |
| `deploy-prod.yml` | `workflow_dispatch` only | `production` | The Cloudflare Worker (standby/rollback path) |

Neither fires on push. Every master push still builds, lints, typechecks and
tests through `ci.yml`. The automatic Cloudflare deploy-on-push was removed
(T03) because it queued a production deployment behind every merge while the
VPS proposal is active — the two would race for one production. Dispatch
exactly one of them by hand.

## Release

1. Pick the SHA: a master commit with CI green. The workflow refuses anything
   that is not a full 40-character SHA on master — format, checkout match and
   master ancestry are all checked before anything is built.
2. Dispatch **Owner-triggered VPS release with SHA evidence**, inputs `sha`
   (the release) and `previous_sha` (the last known-good — the ref of the
   latest `success` `production-vps` deployment whose description starts
   "Verified VPS release", or the rollback reference from the previous run's
   summary).
3. The workflow builds the standalone bundle from exactly that SHA
   (`npm ci`, lint, typecheck, tests, `npm run build`), keeps it as
   `vps-release-<sha>`, then serves that exact artifact from an empty
   database (`npm run verify:selfhosted`). Any failure stops the release;
   nothing is recorded.
4. Approve the `production-vps` environment when the owner is ready. The
   `record` job creates a `production-vps` deployment whose ref is the
   verified input SHA and marks it `success`, then writes the same SHA into
   the run summary — only after verification passed. That explicit deployment
   is the SHA evidence: a SHA appears as a `production-vps` deployment ref if and only if its artifact verified.
   (The run also leaves an automatic
   environment entry for its dispatch head — that entry is the approval log,
   not the evidence. Always read the deployment whose ref matches the
   released SHA.)
5. On the host, deploy that exact SHA — never `latest`, never a rebuild.
   Both units run the same SHA: the web unit serves `dist/`, while the
   refresh job (`deploy/ikbeneenappel-refresh.service`) runs from the source
   tree — so releasing one without the other leaves serving and collection on
   different code, and possibly different migrations.

```bash
# Fetch the recorded artifact (or the repo at the recorded SHA) and unpack it
# beside the live release, keeping the previous release on disk:
#   /opt/ikbeneenappel/releases/<previous-sha>/  (stays)
#   /opt/ikbeneenappel/releases/<sha>/            (new)
# Point /opt/ikbeneenappel/dist at the new release only after it is complete.
# Check out the same SHA in the source tree the refresh job runs from:
git -C /opt/ikbeneenappel fetch origin
git -C /opt/ikbeneenappel checkout <sha>
sudo systemctl restart ikbeneenappel-web.service ikbeneenappel-refresh.service
systemctl --failed
systemctl is-enabled ikbeneenappel-refresh.timer
```

6. Health-check the host run before calling it done: the app answers over
   HTTPS, signed-out `/api/state` is 401 (migrations applied), sign-in as the
   administrator works on a real account, `journalctl -u
   ikbeneenappel-web` shows no errors, the refresh timer is enabled, and both
   units are on the released SHA (`git -C /opt/ikbeneenappel rev-parse HEAD`
   prints the recorded SHA). A release that fails any of these is a
   failed deployment — roll back, do not fix forward on the live unit.

## Rollback

Two levels, fastest first. The instant revert below has not been run on a
host — it is unverified until the owner runs it there (see Synthetic
rehearsal).

**Pre-flight for either level:** migrations apply on first request and are
forward-only. Pointing `dist/` (and the source tree) back at the previous
release is only safe when no migration shipped between the two SHAs
(migration 28, for one, removed a table). Check first:

```bash
git diff --quiet <previous-sha> <sha> -- db/migrations.ts \
  && echo 'no migration between releases: instant revert is safe' \
  || echo 'migrations changed: use the backup restore instead'
```

If migrations changed, do not swing the pointer — restore from the off-box
backup instead (`docs/DEPLOY.md`, rehearsed synthetically by
`scripts/verify-sqlite-restore.mjs`), then re-dispatch the workflow at the
last known-good SHA.

1. **Instant revert, no new deploy.** The previous release is still on disk
   (and only when the pre-flight above is clean), so point
   `/opt/ikbeneenappel/dist` back at
   `/opt/ikbeneenappel/releases/<previous-sha>/`, check out `<previous-sha>`
   in the source tree so the refresh job follows it back too, and restart
   both units: `sudo systemctl restart ikbeneenappel-web.service
   ikbeneenappel-refresh.service`. Use this when the new bundle is broken
   and the old one was good.
2. **Re-dispatch the workflow** with `sha` set to the last known-good SHA
   (the ref of the latest `success` `production-vps` deployment). This
   rebuilds, re-verifies and re-records — the slow path, for when the on-disk
   previous release is itself suspect.
3. **Worker fallback.** Until cutover (#201) the Cloudflare Worker stays
   deployed and idle as the rollback target (`docs/VPS_MIGRATION_PLAN.md`
   §6.8). After cutover it is retired by a separate owner decision, not by
   this runbook.

Never roll back by resetting the database: the restore procedure
(`docs/DEPLOY.md`, rehearsed synthetically by
`scripts/verify-sqlite-restore.mjs`) restores into a scratch path, and the
live file is never the test subject.

## Synthetic rehearsal

`npm run verify:vps-release` checks this procedure's gates without a host:
manual trigger only, verify-before-record ordering with the `production-vps`
environment on the record job alone, the explicit deployment for the verified
SHA (inputs reach shell only through `env:`, never interpolated; the dispatch
head is never presented as the evidence), the master-ancestry pre-flight
before any build, both units on the same SHA for release and revert, the
migration pre-flight before any pointer swing, and no automatic Cloudflare
deploy left. It proves the files and the procedure's shape, not the VPS — and
not the host-side revert, which is unverified until the owner runs it on a host.
`tests/vps-release.test.ts` pins the same gates in the suite so a later
edit cannot silently re-arm an automatic deploy, re-interpolate an input into
shell, or record an unverified SHA.
