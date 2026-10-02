# Encrypted service-secret delivery (T32) — Proposed, not authorized for rollout

Synthetic-only follow-up to T29's assessment
(`docs/F11_STORAGE_ENCRYPTION_ASSESSMENT.md`) and T28's inventory
(`docs/PRIVATE_DATA_MAP.md`). **F11 stays Proposed**: owner review of the
storage/key-custody approach precedes any change to a production path, real
secret file, or live database. Nothing here is wired into `db/runtime.ts`,
any route, or any systemd unit. The mechanism is proved on synthetic
fixtures by `tests/secret-store.test.ts` and
`scripts/verify-secret-rotation.mjs` (`npm run verify:secret-rotation`).

## 1. What already exists (checked first, not rebuilt)

| Plaintext location today | File paths |
|---|---|
| systemd `EnvironmentFile=/etc/ikbeneenappel/env` (root 0600, permissioned plaintext) | `deploy/ikbeneenappel-web.service`, `deploy/ikbeneenappel-refresh.service`, `deploy/ikbeneenappel-litestream.service` |
| `.dev.vars.<env>` per-environment session + provider keys | `scripts/init-secrets.mjs`, `.dev.vars.example` |
| `.local/<env>-session-secret` fallback when the vars file has no `SESSION_SECRET` | `scripts/run-local.mjs` |
| Consumption: `process.env` / Worker env read per request, absent values fail closed | `db/runtime.ts` (`authSecrets`, `emailConfiguration`, `indeedConfiguration`, `turnstileSecrets`) |

Existing checks re-run for this task: `verify:sqlite-import`,
`verify:sqlite-restore`, and `verify:f11-encryption` (T29) all PASS — the
envelope changes none of those paths.

## 2. Selected mechanism

Encrypted credential envelope at rest + single unlock key delivered
separately at runtime — the two-part scheme T29 §6 proposed, with the tool
choice fixed to **no new tool**: the envelope uses the same reviewed
primitive as T29's field encryption (AES-256-GCM via `node:crypto`, random
96-bit IV, 128-bit tag, purpose AAD, versioned `senv1` envelope), so there
is no new dependency, no native module, and no SQL or D1-interface change.
A future move to age/sops or systemd `CredentialEncrypted=` changes the
key-delivery half only; the envelope construction and the runbook below do
not depend on it.

- **At rest:** one envelope file (e.g. `/etc/ikbeneenappel/secrets.enc`,
  root-owned `0600`) holding only `senv1:…` ciphertext. It replaces the
  secret lines in the `EnvironmentFile`, never sits beside the unlock key in
  a backup, and scans clean for every sealed value.
- **Unlock key:** 32 random bytes, base64, delivered as a systemd credential
  (`LoadCredential=secrets-unlock:/etc/ikbeneenappel/.unlock-key`, root-owned
  `0600`, never in Git, never in the backup). The app opens the envelope
  into memory at boot and injects only the values each subsystem needs
  (session signer gets `SESSION_SECRET`, mail gets `RESEND_API_KEY`).
- **Sealed names:** `SEALED_SECRET_KEYS` in `lib/secret-store.ts`
  (`SESSION_SECRET`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`,
  `INDEED_API_KEY`, `ADZUNA_APP_KEY`, `CAREERJET_API_KEY`,
  `AWS_SECRET_ACCESS_KEY`). Unknown names are refused so a typo cannot leave
  a secret outside the envelope. Nonsecret configuration (`RESEND_FROM`,
  `ALLOW_SIGNUPS`, ports, paths, URLs) stays plaintext by design, as do
  one-way password hashes, which must never be sealed reversibly.
- **Fail-closed:** absent/unreadable unlock key, wrong key, wrong purpose,
  or any tampering refuses to boot — the same posture as today's missing
  `SESSION_SECRET` 503, never a run without secrets.

## 3. systemd wiring (example only — not installed)

```ini
# /etc/systemd/system/ikbeneenappel-web.service.d/secrets.conf (example)
[Service]
# Ciphertext at rest; the unlock key arrives as a credential, never as Env.
EnvironmentFile=/etc/ikbeneenappel/env
LoadCredential=secrets-unlock:/etc/ikbeneenappel/.unlock-key
# Boot opens /etc/ikbeneenappel/secrets.enc with $CREDENTIALS_DIRECTORY/secrets-unlock.
```

File layout on the host (owner-provisioned, never committed):

```text
/etc/ikbeneenappel/env            nonsecret config only (no *_SECRET*, no *_KEY*)
/etc/ikbeneenappel/secrets.enc    senv1:… ciphertext (0600, root-owned)
/etc/ikbeneenappel/.unlock-key    base64 unlock key (0600, root-owned, backed up separately)
/etc/ikbeneenappel/litestream.yml unchanged shape; replica credentials stay in the
                                  envelope, bucket uses SSE (see T29 §4)
```

## 4. Runbook (synthetic rehearsal; real host steps are owner-supervised)

Bootstrap (throwaway values shown; real keys are generated on the host):

```bash
node --import tsx scripts/verify-secret-rotation.mjs   # green before any host change
```

| Operation | What happens | Expected |
|---|---|---|
| Bootstrap | Seal `{SESSION_SECRET, RESEND_API_KEY, …}` under a fresh unlock key; write envelope + key to their separate paths | Both boots in the harness print `boot: ok` |
| Restart | `systemctl restart ikbeneenappel-web` (harness: two separate `--boot` processes) | Second boot opens the same envelope; sessions survive because the key did not change |
| Rotation | Re-wrap the envelope to a new unlock key, replace the envelope file, replace the credential, restart | New key boots; `unlockKeyMatches` with the old key is false; old material destroyed |
| Revocation | Seal fresh values under a fresh key (exposure assumed); retire the old envelope + key | Old key cannot open the new envelope; provider-side revocation (Resend/Turnstile dashboards) accompanies the re-wrap |
| Absent key | Credential file missing or empty | Boot refuses with a fail-closed error; no secret value in the message |
| Recovery | Restore the envelope backup in isolation (no key alongside it); supply the separately held unlock key | `integrity` equivalent holds (envelope parses, required names present); wrong key still refuses |

## 5. What this task did NOT do

- No change to `db/runtime.ts`, any route, `scripts/run-local.mjs`,
  `scripts/init-secrets.mjs`, or any live secret file. Local dev/test keep
  their plaintext files; the VPS keeps its `EnvironmentFile`.
- No SQLCipher/native module, no Litestream live drill against an encrypted
  file (T29 §4 analysis stands; the live drill is T30 on the real host).
- No real admin-identity transfer or real-data operation — those require F11
  acceptance, verified privately on the host before transfer.
- Evidence is redacted by construction: the harness and tests print counts,
  booleans, and the envelope version only — never keys, values, or
  ciphertext. An exposed real credential requires owner-authorized
  revocation at the provider, not file deletion.
