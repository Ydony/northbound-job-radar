# Secure transfer, independent secrets and rollback checks (T07)

This is a **procedure and checklist document, not authorization**. The real
identity transfer, real secret handling and DNS cutover remain an explicit
owner checkpoint under F2: they happen privately, in a local terminal with the
owner present, and this file is not permission to run them. Everything below
uses placeholders (`<owner-email>`, `<new-host>`, `<old-host>`) and the
synthetic `synthetic-… / example.invalid` namespace. **No real emails,
hashes, tokens or secret values appear here**, and none may be added.

Companion to `docs/ADMIN_IDENTITY_TRANSFER.md` (T05: what the code copies and
refuses on synthetic fixtures) and `docs/PRIVATE_DATA_MAP.md` §4 (T28: the
full secret lifecycle). T05 rehearses the mechanism; T06 rehearses the
Settings credential change on two synthetic sessions
(`scripts/verify-dev-workflow.mjs` step 7/10); this document covers what those
two deliberately leave out: handling the real transfer securely, giving the
new host independent secrets, and keeping the old host as a rollback that
never receives new data back automatically.

## 1. Secure transfer procedure (private, owner-witnessed)

Prerequisites: the new host has passed its own acceptance task (F1), the
owner has explicitly authorized this transfer, and both databases report the
same `schema_migrations` version. The helper has no CLI and no production
file paths by design (`scripts/admin-identity-transfer.mjs`); real use is a
short private session, never a ticket, chat message, assistant prompt, log
line or committed file.

1. On the old host, confirm exactly one active, verified administrator exists
   and note its address as `<owner-email>` only — never copy the row, the
   hash or any token out of the database client.
2. On the new host, confirm a freshly migrated, empty database: the only
   permitted pre-existing content is the `schema_migrations` bookkeeping
   plus the untouched `indeed_control` seed row from migration 19. Anything
   else means the host is not fresh — stop.
3. Run the transfer helper between the two already-migrated databases. It
   copies one `users` row through the T05 allowlist (identity and verifier
   retained, `session_epoch` incremented by one, `last_seen_at` cleared) and
   copies nothing else: no jobs, catalogue rows, search history, settings,
   feedback, sessions, auth events or verification/reset tokens.
4. The helper runs refusal and insert inside one destination transaction, so
   a failed check leaves the new database unchanged. It never deletes or
   replaces rows. A refusal naming a nonempty destination, a schema
   mismatch, or a source that is not exactly one verified administrator is
   a stop signal, not something to override.
5. Privately verify the retained login on the new host (the owner enters the
   existing password; it is never spoken, pasted or written down for anyone
   else), confirm the administrator role and the verified state, and confirm
   the workspace is empty. Do not require disclosure of the current
   password in chat — there is no step here that needs it.
6. Record only names and outcomes (which checks passed, the schema version,
   the date). Secret values, hashes, tokens and addresses stay out of the
   record, exactly as the synthetic rehearsal prints redacted evidence.

## 2. Independent secrets on the new host

The new host must receive **freshly generated secrets that never equal the
old host's values**. The `session_epoch` increment from §1 revokes old
cookies even if the session signing secret (`SESSION_SECRET`) were
accidentally reused; it is a second layer, not a substitute for independence.

| Secret | Old host | New host (independent value) |
|---|---|---|
| Session signing secret | Existing value stays until rollback is released | Fresh random value, generated on the new host itself |
| Verification/reset sender key | Existing sender key untouched | Separately issued sender key, if email is configured there |
| Bot-check secret | Existing value untouched | Separately issued value before any open registration |
| Backup replica credentials | Existing bucket credentials untouched | Separate bucket and credentials, never shared with the old host |
| Aggregator quota keys | Existing values untouched | Re-issued or left unset (source reports unavailable) |

Rules that apply on every host (see `docs/PRIVATE_DATA_MAP.md` §4 and
`docs/DEPLOY.md` for the full lifecycle):

- Cloudflare production secrets are set with the secret-put command in a
  local terminal; VPS secrets live in the root-owned `0600`
  `EnvironmentFile` (`deploy/ikbeneenappel-web.service`,
  `deploy/litestream.yml`). Secret values never appear in Git, bundles,
  command arguments, logs, error messages, tracker content or model prompts.
- Verify **names only**: the secret-list command exposes names for review,
  never values. Confirm the expected names exist on each host and that the
  new host's values were generated independently — by generation procedure
  and separate storage, never by comparing pasted values side by side.
- Local `dev` and `test` already model this: `npm run init-secrets` writes
  a different `SESSION_SECRET` per environment file and never copies the
  session secret between them. The new production-equivalent host gets the
  same treatment, one fresh value of its own.
- Rotation signs everyone out; never rotate while the administrator is
  unverified (sign-in refuses unverified accounts). Provider-issued keys
  are additionally revoked at the provider when replaced.
- Restricted keys are never copied to a host that must not hold them:
  publisher and experiment credentials stay local-only and are never set
  on a hosted installation.

## 3. Rollback: the old host stays, nothing copies back

Until the owner releases it (at least a week idle after cutover, per
`docs/VPS_MIGRATION_PLAN.md` §6), the old production stays deployed and
available. Rollback is a **service/DNS switch back to the untouched old
host** — never a database copy in either direction:

- The transfer helper refuses a nonempty destination, in both directions.
  Once the new host holds the administrator row, a second forward transfer
  is refused; a reverse transfer back into the old host is refused because
  the old host is nonempty. There is no automatic copy-back path in the
  code, and no new-host account data, jobs or tokens are ever merged back
  into the old database automatically.
- If rollback is chosen, point serving back at the old host and confirm the
  old administrator login there. The new host's data stays on the new host
  and is reconciled only by a fresh explicit owner decision — never by an
  unattended job.
- The encrypted-backup restore drill (`docs/DEPLOY.md`, from #200) is a
  separate throwaway-instance procedure for proving backups; it is not a
  rollback and its scratch copy is deleted afterwards, never served.

Pre-cutover checklist (owner confirms privately, records only outcomes):

- [ ] New host signs in with the retained login; role is administrator and
  the address is verified; the workspace shows no imported jobs.
- [ ] New host secrets were generated independently; names verified
  names-only; old host values untouched.
- [ ] Schema version matches on both hosts; Settings credential change,
  email verification and session revocation behave as rehearsed in T06.
- [ ] Old host remains deployed and reachable as the rollback target; no
  automation copies new-host data back.

## 4. Reproducible evidence (synthetic only)

`npm run verify:transfer-rollback` rehearses the mechanical shape on
throwaway databases: forward transfer of a synthetic administrator succeeds
with the password verifier intact and the epoch incremented; a second
forward transfer is refused; the reverse transfer back into the old
database is refused with both databases unchanged; two freshly generated
synthetic secrets differ and match the expected shape; and this document
plus the transfer helper contain secret names only, never values.
`tests/transfer-rollback.test.ts` pins the same contract at unit speed and
runs the rehearsal end to end. Neither touches DEV, TEST, Cloudflare or
production, and neither proves the real password, the real secrets or the
real DNS cutover — those stay behind the owner checkpoint by design.
