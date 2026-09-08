# Ik ben een appel — working notes for Claude Code

**This is `C:\Projects\Auto Job hunt`.** If your session root is anywhere else, stop and
fix that first — see "Wrong-project guard" below. There is a separate, unrelated project
at `C:\Projects\vehicle-transfer-mvp` whose rules do not apply here and will actively
mislead you.

Read `AGENTS.md` first — it is the substantive contract (source-integration boundaries,
multi-user rules, engineering rules, definition of done). Then `docs/HANDOFF.md` for the
current state. This file exists so those get loaded at all, and to hold the facts that
are most often got wrong.

## Wrong-project guard

This has gone wrong twice. Both times the session root was `vehicle-transfer-mvp` while
the work was here, which produces two silent failures:

1. **Path-less tools use the session root, not your last `cd`.** `preview_start` reads
   `.claude/launch.json` from the session root, so it started the other project's Vite
   server on :5173 while every Bash command was correctly running here.
2. **The other project's `CLAUDE.md` is the one loaded into context.** Its rules —
   pnpm, Supabase, pgTAP, `pnpm check`, "27 Playwright locators" — are not true here and
   were quoted into a GitHub issue as if they were.

**Before running anything path-less** (`preview_start`, launch configs, plan files),
confirm the session root is this folder. If it is not, move the session with
`change_directory` rather than working around it with `cd` in Bash.

## What is true here, that is not true there

| | Here | `vehicle-transfer-mvp` |
|---|---|---|
| Package manager | **npm** | pnpm |
| Runtime | Cloudflare Workers (workerd), D1, R2 | Supabase, Postgres |
| Browser tests | **none at all** | Playwright + axe |
| Merge gate | `npm run lint`, `typecheck`, `test`, `build` | `pnpm check` |
| Dev / test | :3000 / :3001 (`npm run dev`, `npm run test:local`) | :5173 |
| Board | [Job Hunt #4](https://github.com/users/Ydony/projects/4) | Vehicle Transfer #3 |

**Nothing tests `app/job-radar.tsx`.** The 122-test suite covers `lib/` and the API
surface only. Lint, typecheck and build all pass on a page that renders wrongly, so UI
changes need a signed-in look at a running server before they are called done.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Dev environment, :3000, registration open |
| `npm run test:local` | Test environment, :3001 |
| `npm run lint` / `npm run typecheck` / `npm test` / `npm run build` | The merge gate |
| `npm run verify:dev` | Local-only harness: creates a throwaway account and exercises the app |

`EPERM ... dist` on build means a previous `workerd` still holds the folder. Stop it,
delete `dist`, rebuild. **A running server is not proof of a current build.**

## Ground rules

- Synthetic data only. Never commit real identity data, CVs, credentials or `.dev.vars.*`.
- Every query scoped to the session user. A missing `WHERE user_id = ?` is a cross-account
  leak; four such defects were found in review immediately after the tenancy change.
- Page-fetching sources are administrator-only and enforced server-side. Ordinary accounts
  must never learn which page-fetched sources exist — jobs, run history and `/sources`.
- `docs/SOURCE_POLICY.md` is authoritative on what may be shown publicly. Reading a source
  and republishing its advertisement text are separate questions.
- No detection evasion, ever: no timing randomisation, fingerprint spoofing, stealth
  plugins, or proxy rotation.
- Task tracking lives on the board and in decision cards, not in `docs/TASKS.md`.
  A user scope decision is required before implementation starts.
