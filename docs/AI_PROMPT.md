# Starting prompt for a coding agent

Copy everything below the line into a fresh session.

---

You are working on **Ik ben een appel**, a private local job-search tool at
`C:\Projects\Auto Job hunt`. Confirm that directory before doing anything. The obsolete similarly
named folder under `C:\Users\anddo\Documents\ChatGPT` is not the project and must not be used.

Read, in order, `docs/TASKS.md`, `docs/HANDOFF.md`, and `AGENTS.md`. Do not code until all three
have been read. Then read the documents those files route you to for the area being changed.

The application finds Swiss and Netherlands job advertisements where English alone is sufficient,
screens their language requirements, and scores them against up to two CVs. It is React/Vinext on
the Cloudflare local runtime, using local D1 and R2 bindings.

## Environment boundary

- Everything is local. Do not deploy or create a hosted site without a new explicit owner request.
- `npm run dev` is the disposable hot-reload environment at `http://localhost:3000`.
- `npm run test:local` builds and runs the stable test Worker at `http://localhost:3001`.
- Dev and test use separate storage under `.wrangler/dev/state` and `.wrangler/test/state` and
  separate secrets in `.dev.vars.dev` and `.dev.vars.test`. Never point either at the other.
- Never commit or display credentials, CV content, `.dev.vars*`, or `.wrangler/` data.

## Work order

Continue `docs/TASKS.md` from the first unchecked item. For functional verification, use a new
second account with new data and exercise the full workflow, not only the migrated owner account.
Attempt cross-account access by id and verify that it fails. Report findings before fixing them,
then add regression tests.

The owner must personally change the temporary test administrator email and password in
`http://localhost:3001/settings`; never store those credentials in a document or commit.

## Non-negotiable rules

- No detection evasion, proxy/IP rotation, fingerprint spoofing, stealth browser, automated source
  login, or automated application submission.
- Restricted page-fetching sources remain administrator-only, VPN-gated, manually triggered, and
  server-side enforced. Non-admin users must not learn their names.
- Every user-data query must be scoped by `user_id`; uniqueness is per owner.
- A CV never goes to a job site, aggregator, model, or other third party.
- Preserve `pass / review / blocked` and prefer false negatives for “English sufficient.”
- Keep `/sources` and `/privacy` synchronized with actual behavior.

## Completion gate

Run `npm run lint`, `npm test`, `npm run typecheck`, and `npm run build`. Exercise the affected
flow in dev and the built test environment, update the handover/task documentation, and state any
unverified behavior plainly before committing.
