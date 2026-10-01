# Administrator identity-only transfer contract (T05)

This is a **synthetic rehearsal and code contract**, not authorization or a
procedure to copy a real account. The owner checkpoint for a real transfer,
secret setup and rollback remains open under F2/T07. Do not run this code on
production files or include real database rows, hashes, addresses or secrets in
a ticket, log or assistant prompt.

The transfer helper is `scripts/admin-identity-transfer.mjs`. It has no CLI or
production file paths. It accepts two already-migrated SQLite handles and
copies **one row from `users` only**, using this explicit allowlist:

| Source field | Destination behavior |
| --- | --- |
| `id`, `email`, `password_hash`, `role`, `status`, `email_verified_at`, `created_at` | Retained; source must contain exactly one active, verified administrator. |
| `session_epoch` | Written as source epoch + 1, so old cookies are revoked even if a secret were accidentally reused. |
| `last_seen_at` | Reset to empty. |

No other `users` fields are copied. No rows from jobs, catalogue, search history,
settings, feedback, sessions, auth events, verification/reset tokens or any
other table are copied. The new host must use an independent `SESSION_SECRET`;
the epoch change is an additional safeguard, not a substitute for that secret.

The helper refuses a source with zero, multiple, inactive, non-admin or
unverified accounts, an incomplete identity, a schema-version mismatch, and a
destination with any pre-existing domain data. The only permitted nonempty
destination table is `schema_migrations` plus the **untouched** `indeed_control`
row seeded by migration 19. The refusal and insert occur inside a destination
transaction, so a failed check leaves it unchanged. It does not delete or
replace existing rows.

Run `npm run verify:admin-transfer` for a reproducible rehearsal. It creates
throwaway old/new databases with the app's current migrations, seeds a
synthetic administrator, job and verification token in the old database,
transfers the allowlisted identity, verifies the retained password hash and
administrator/verification state, checks that job/token rows did not move,
checks the epoch bump and nonempty-destination refusal, then removes the
throwaway files. `tests/admin-transfer.test.ts` covers the field-level contract
and refusal cases. Neither command uses DEV, TEST, Cloudflare or production.

This proof does **not** establish that the owner's real password verifies on
the new host, that host secrets are independent, or that rollback and DNS
cutover are safe. The documented procedure and synthetic checks for those are
in `docs/ADMIN_TRANSFER_ROLLBACK.md` (T07, no real values); the private
execution itself remains an owner checkpoint with the host acceptance task.
No real identity transfer has been run.
