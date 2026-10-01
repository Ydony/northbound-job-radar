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
   that is not a full 40-character SHA on master.
2. Dispatch **Owner-triggered VPS release with SHA evidence**, inputs `sha`
   (the release) and `previous_sha` (the last known-good, for the rollback
   reference — read it from the `production-vps` environment deployment
   history).
3. The workflow builds the standalone bundle from exactly that SHA
   (`npm ci`, lint, typecheck, tests, `npm run build`), keeps it as
   `vps-release-<sha>`, then serves that exact artifact from an empty
   database (`npm run verify:selfhosted`). Any failure stops the release;
   nothing is recorded.
4. Approve the `production-vps` environment when the owner is ready. The
   `record` job writes the verified SHA into the run summary **only after**
   verification passed. That environment's deployment history is the SHA
   evidence: a SHA appears in `production-vps` if and only if its artifact
   verified.
5. On the host, deploy that exact SHA — never `latest`, never a rebuild:

```bash
# Fetch the recorded artifact (or the repo at the recorded SHA) and unpack it
# beside the live release, keeping the previous release on disk:
#   /opt/ikbeneenappel/releases/<previous-sha>/  (stays)
#   /opt/ikbeneenappel/releases/<sha>/            (new)
# Point /opt/ikbeneenappel/dist at the new release only after it is complete.
sudo systemctl restart ikbeneenappel-web.service
systemctl --failed
```

6. Health-check the host run before calling it done: the app answers over
   HTTPS, signed-out `/api/state` is 401 (migrations applied), sign-in as the
   administrator works on a real account, and `journalctl -u
   ikbeneenappel-web` shows no errors. A release that fails any of these is a
   failed deployment — roll back, do not fix forward on the live unit.

## Rollback

Two levels, fastest first:

1. **Instant revert, no new deploy.** The previous release is still on disk,
   so point `/opt/ikbeneenappel/dist` back at
   `/opt/ikbeneenappel/releases/<previous-sha>/` and restart the web unit.
   Use this when the new bundle is broken and the old one was good.
2. **Re-dispatch the workflow** with `sha` set to the last known-good SHA
   from the `production-vps` history. This rebuilds, re-verifies and
   re-records — the slow path, for when the on-disk previous release is
   itself suspect.
3. **Worker fallback.** Until cutover (#201) the Cloudflare Worker stays
   deployed and idle as the rollback target (`docs/VPS_MIGRATION_PLAN.md`
   §6.8). After cutover it is retired by a separate owner decision, not by
   this runbook.

Never roll back by resetting the database: the restore procedure
(`docs/DEPLOY.md`, rehearsed synthetically by
`scripts/verify-sqlite-restore.mjs`) restores into a scratch path, and the
live file is never the test subject.

## Synthetic rehearsal

`npm run verify:vps-release` checks this procedure's logic without a host:
it asserts the workflow gates above (manual trigger only, verify-before-
record ordering, `production-vps` environment on the record job alone, no
automatic Cloudflare deploy left) and rehearses the instant revert — stage
two synthetic releases, swing a `current` pointer, fail the new one, swing
back — on throwaway directories. It proves the files and the revert shape,
not the VPS. `tests/vps-release.test.ts` pins the same gates in the suite
so a later edit cannot silently re-arm an automatic deploy.
