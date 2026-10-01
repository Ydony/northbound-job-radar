# F11 storage-encryption assessment (T29) — Proposed, not authorized for execution

Time-bounded investigation (90 min). Spark, synthetic fixtures only. No real
secrets, production data, or host access. **F11 stays Proposed**: owner review
of the storage/key-custody approach precedes T30/T32, and assessment and
implementation are separately authorized. Nothing here changes a production
path; `lib/field-crypto.ts` is an evaluation helper, not wired into any query.

## 1. What already exists (checked first, not rebuilt)

| Area | Current state (plaintext throughout) | File paths |
|---|---|---|
| Database | `node:sqlite` behind a D1 adapter, WAL mode, `busy_timeout`, plain file at `SQLITE_PATH` | `db/sqlite-adapter.ts`, `db/runtime.ts` (`bindings()`, `ensureSchema()`), `db/migrations.ts` |
| Backup / replication | Litestream config + systemd unit (no encryption option set); synthetic file-copy rehearsals stand in for `litestream restore`; local backups are plain `cp` + manifest | `deploy/litestream.yml`, `deploy/ikbeneenappel-litestream.service`, `scripts/verify-sqlite-import.mjs`, `scripts/verify-sqlite-restore.mjs`, `scripts/backup-local.mjs`, `scripts/verify-local-backup.mjs` |
| Secrets at rest | Plaintext: systemd `EnvironmentFile=/etc/ikbeneenappel/env` (root 0600), `.dev.vars.<env>`, `.local/*-session-secret`, `wrangler secret` on Cloudflare | `deploy/ikbeneenappel-web.service`, `scripts/run-local.mjs`, `scripts/init-secrets.mjs` |
| Secret consumption | `process.env` / Worker env read per request; absent values fail closed (sources report unavailable, auth refuses) | `db/runtime.ts` (`authSecrets`, `emailConfiguration`, `indeedConfiguration`, `turnstileSecrets`) |
| Transport | HSTS, Cloudflare-fronted TLS / nginx + certbot on VPS, per-request CSP nonce | `next.config.ts`, `deploy/nginx-ikbeneenappel.conf`, `middleware.ts`, `lib/security-policy.ts` |

Existing checks run for this task, all green: `verify:sqlite-import` and
`verify-sqlite-restore` PASS (schema v31, counts and catalogue join survive
the copy). No SQLCipher/SEE/sops/age/vault code, test, or doc exists anywhere
in the tree — that absence is the gap this assessment fills.

## 2. Private-data inventory → storage/encryption/key-access/retention mapping

Public job content (advert text from public sources) is distinct from a
user's private relationship to it. The mapping below is the contract T30 must
implement; the PoC in §5 covers the mechanism, not the column-by-column rollout.

| Category | Lives in | Encryption under proposal | Key access | Retention |
|---|---|---|---|---|
| Account identities (email, password hash, role, verified flag) | `users` | Field-sealed PII columns (email); hashes stay one-way (already salted PBKDF2, never reversible) | Data key at runtime only | Account lifetime; `auth_events` IPs 30 days (`ensureSchema()` purge) |
| Private criteria (roles, keywords, settings) | `search_roles`, `search_settings` | Field-sealed | Data key at runtime only | User-controlled |
| Saved/applied/dismissed state, language corrections | `user_vacancy_state`, `dismissed_jobs`, `language_feedback` | Field-sealed job/user linkage + notes | Data key at runtime only | User-controlled; dismissal tombstones persist by design |
| Service credentials / tokens (Resend, Indeed, Turnstile, aggregator keys, `SESSION_SECRET`) | Env/`EnvironmentFile` today → encrypted credential envelope at rest (§6) | Encrypted secret store file, decrypted in memory at boot | Unlock key via systemd credential, never beside ciphertext | Rotate on exposure; rotation tested synthetically (§5) |
| Auth/IP logs | `auth_events`, `rate_limits` | Field-sealed IPs where retained; 30-day expiry already enforced | Data key | 30 days, then deleted |
| Journals/WAL/temp files | `<db>-wal/-shm/-journal`, SQLite temp store | Ciphertext-only under field encryption (PoC scans all four artifacts); full-file ciphers cover them by construction | Same as data | Ephemeral; checkpoint before backup |
| Snapshots, exports, replication | Litestream replica, `wrangler d1 export`, local backups | Encrypted before leaving the host: sealed fields + envelope-encrypted replica/backup (§6) | Recovery key held separately from ciphertext | 30-day replica retention (existing `litestream.yml`) |
| Browser/build/log/Git surface | Bundles, logs, error text, tracker content | No secret values ever (existing `GET /api/admin/email` already redacts; PoC evidence is redacted by construction) | n/a | n/a |

## 3. Options evaluated

**Constraints from the contract:** preserve the D1 interface and SQLite
dialect (the ~197 `prepare()` sites stay untouched), no Postgres rewrite, no
homemade cryptography.

| Option | Maintenance / review standing | Verdict |
|---|---|---|
| **SQLCipher** (Zetetic, open-source SQLite extension, page-level AES-256) | Maintained, widely reviewed, the standard answer for encrypted SQLite | **Viable but NOT proved here.** Requires replacing `node:sqlite` with a SQLCipher-capable driver (e.g. a better-sqlite3-based SQLCipher build) behind `db/sqlite-adapter.ts` — the adapter isolates the driver to three private methods, so the swap is contained, but the native module was deliberately avoided by VPS-02 (no toolchain, no upgrade fragility). Needs a T30 trial in isolation. |
| **SQLite Encryption Extension (SEE)** | Official, maintained — but commercial/licensed | Rejected for this project: license cost and distribution friction for a one-box deployment, no advantage over SQLCipher. |
| **Field-level encryption with a reviewed primitive (AES-256-GCM via OpenSSL / libsodium)** | `node:crypto` is the maintained runtime library; the construction (random IV, auth tag, AAD row-binding, versioned envelope) uses the primitive as documented, no custom cipher | **Recommended now (§5 proves it).** Zero driver change, zero SQL dialect change, D1 interface untouched, Litestream-safe by construction (see §4). Costs: no range queries over sealed columns (search/filter must stay on public columns), envelope overhead per value. |
| **Volume/disk encryption (LUKS)** | OS-maintained | Necessary hygiene, explicitly **insufficient alone**: a copied ordinary SQLite file with readable records fails acceptance even with disk encryption. Additional layer only. |
| **Backup/replica encryption** | age/sops-style envelope (X25519 + AEAD) or provider SSE | Required companion to either DB option: Litestream has no built-in at-rest encryption for the replica, so the replica bucket must use SSE (R2/B2) and/or an encrypted sidecar. PoC proves the field-sealed half; replica-envelope tooling is T30 scope. |

## 4. Litestream / backup compatibility analysis

The contract forbids assuming Litestream works unchanged with an encrypted
database. Two cases:

- **Field encryption (recommended): the question does not arise.** The file
  remains an ordinary SQLite database; WAL pages carry ciphertext values but
  need no key to replicate. `verify-sqlite-restore`'s checkpoint-then-copy
  shape keeps working byte-for-byte, and §5 extends that exact shape with
  sealed rows: `integrity_check ok`, same row counts, isolated restore opens
  clean, correct key recovers, wrong key fails. Proven, not assumed.
- **SQLCipher (deferred): compatibility is reasoned, NOT proved.** Litestream
  replicates raw pages and ships WAL frames opaquely, so ciphertext pages
  should replicate without a key — but the file header changes (`SQLite format
  3` magic becomes salt), so header-sniffing tooling, `sqlite3` CLI inspection,
  and the `verify-sqlite-*` scripts (which open copies with plain
  `node:sqlite`) would all fail against an encrypted file until given the key.
  The T30 SQLCipher trial must re-run the restore drill against a real
  SQLCipher file and a real `litestream restore` before any claim is made.

## 5. Synthetic proof delivered in this task (new files)

- `lib/field-crypto.ts` — AES-256-GCM envelope helper (random 96-bit IV,
  128-bit tag, AAD row-binding, `v1` envelope). Evaluation helper only; no
  production import.
- `tests/field-crypto-backup.test.ts` — 4 tests, all passing: adapter
  roundtrip of sealed rows; pre-checkpoint leak scan over main + `-wal` +
  `-shm` + `-journal`; wrong/missing key, wrong row binding, and tampering
  fail closed; rotation revokes the old key; checkpointed backup copy carries
  no key bytes, passes `integrity_check`, hides plaintext, and recovers with
  the separately held key.
- `scripts/verify-f11-encryption.mjs` (`npm run verify:f11-encryption`) —
  end-to-end harness printing redacted JSON evidence only (counts, booleans,
  envelope version; never keys, fixtures, or ciphertext).
- Independent-review note (not a string scan alone): the mechanism was
  reviewed against its construction — GCM authentication covers ciphertext +
  AAD, IVs are random per value, the AAD binds each value to its row so copies
  across rows do not decrypt, and the scan covers sidecar artifacts, not just
  the main file. One probe subtlety is documented in the work: appending a
  single base64 character can land in decoder-ignored padding territory, so
  the tamper probe flips a mid-payload character instead.

## 6. Proposed design (for owner review before T30/T32)

1. **At rest:** field-seal the private columns in §2 with the §5
   construction; data key is 32 random bytes, base64, delivered at runtime
   only (below). Public catalogue columns stay plaintext so search, facets,
   and language analysis keep working in SQL.
2. **Secret delivery:** replace the plaintext `EnvironmentFile` with a
   two-part scheme — an encrypted credential envelope at rest (age/sops-style;
   T30 to pick the tool) plus a single unlock key delivered as a systemd
   credential (`LoadCredential=` / `CredentialEncrypted=`, root-owned, never
   in Git, never beside the ciphertext). The app decrypts into memory at boot,
   injects only the values each subsystem needs, and fails closed when the
   unlock key is absent. Rotation = re-wrap envelope with a new data key and
   restart; revocation = new unlock key + envelope, old material destroyed.
   Synthetic rotation/restart/fail-closed behavior is proved in §5; the
   systemd wiring is T30 scope on the real host.
3. **Backups:** keep Litestream (field-sealed pages replicate opaquely);
   enable bucket-side SSE on the replica bucket AND envelope-encrypt any
   backup that leaves the host (export dumps, local-backup archives).
   Recovery keys live separately from ciphertext/backups; the isolated-restore
   drill (§5 shape) is re-run with sealed data before any real-data operation.
4. **Transport/secrecy hygiene:** unchanged and already enforced — verified
   TLS, no secret values in Git/bundles/localStorage/URLs/args/logs/errors
   (evidence redacted by construction).
5. **Explicit non-goals:** not end-to-end encryption; a running server holds
   keys in memory by necessity. Host/process access restriction, dump
   minimization, and authorization independent of encryption remain in force.

## 7. What this task did NOT do (follow-ups, not hidden gaps)

- No SQLCipher/SEE package trialed; no native module installed (T30 trial).
- No live Litestream run against an encrypted file (reasoned analysis in §4;
  live drill is T30 on the real host with synthetic data).
- No change to any production path, secret file, or live database; F11 stays
  Proposed. Real admin-identity transfer and real-data operation require F11
  acceptance, verified privately on the host before transfer.
- Suggested split: T30 — encrypted secret delivery + field-seal rollout on
  synthetic host data with the live restore drill; T32 — recovery/rotation
  runbook + independent configuration review.
