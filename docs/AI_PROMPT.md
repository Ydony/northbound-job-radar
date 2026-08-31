# Starting prompt for a coding agent

Copy everything below the line into a fresh session.

---

You are working on **Ik Engels**, a private job-search tool at `C:\Projects\Auto Job hunt`.
Confirm you are in that directory before doing anything — a similarly named copy exists at
`C:\Users\anddo\Documents\ChatGPT\Auto Job hunt` and is **not** the live project.

It finds Swiss and Dutch job advertisements where English alone is enough, screens each one, and
scores it against the user's CVs. React + Vinext on Cloudflare Workers, with D1 and R2.

## Read first, in this order

1. `docs/TASKS.md` — the ordered work list. Blocking items are at the top.
2. `docs/HANDOFF.md` — current state and the things that will surprise you.
3. `AGENTS.md` — rules that must not be broken.
4. `docs/ENVIRONMENTS.md` and `docs/DEPLOY.md` — before touching deployment.

Do not start coding until you have read 1–3.

## Work in this order. Do not skip ahead.

### Phase 1 — Set up the environments first

Follow `docs/ENVIRONMENTS.md` and create **development** and **testing**. The one rule that
matters: each environment owns its own D1 database and R2 bucket. If they share storage, a
development mistake destroys the data being tested against.

The owner needs to keep using a working copy while you change things, so testing must be a
separate, stable deployment. Do not begin Phase 2 until both exist and the owner can reach testing.

### Phase 2 — Then test the existing app in development, and fix what you find

Before building anything new, exercise what is already there and look for bugs and
inconsistencies. Work in development only. Report what you find before fixing it, then fix it.

Cover at least:

- **Register a second account and use it as a real user**, with new data of its own. Upload a CV,
  save search criteria, run a search, save and dismiss jobs, correct a language verdict, export,
  delete jobs, reset the workspace. This matters more than anything else on the list: the last
  review found that CV upload had been completely broken for every account, plus four cross-tenant
  defects, and none of it appeared in ordinary use because the existing data had been adopted
  rather than freshly created.
- **Confirm isolation holds.** From the second account, try to read and modify the first account's
  jobs by id. It must not be possible.
- **Both search modes.** The default search must run only non-restricted sources. The VPN mode must
  be refused unless started with `npm run dev:private`, and must be invisible and refused for a
  non-admin.
- **Account and admin screens.** Change email, change password (it should sign out other
  sessions), delete an account, disable/enable/promote/demote/reset from `/admin`, and confirm the
  last administrator cannot be removed.
- **The pages render and agree with the code**: `/`, `/login`, `/settings`, `/admin`, `/sources`,
  `/privacy`.
- **Look for inconsistencies**, not only crashes: numbers that disagree between screens, filters
  that do not match what a card shows, statuses that read as failures when nothing failed, copy
  that describes behaviour the code no longer has.

### Phase 3 — Only then, work through `docs/TASKS.md` in order

Start at the top of section A. Tick items off in that file as you complete them so the next session
sees the state. Ask the owner before making a product decision that the file leaves open — A2
(what happens to Careerjet in production) is one of those.

## Rules that are not negotiable

- **No detection evasion, ever.** No randomised or human-imitating timing, no fingerprint spoofing,
  no stealth browser plugins, no proxy or IP rotation, nothing designed to defeat bot detection.
  This survived a reversal of the no-scraping rule and is not open for reconsideration.
- **Sources have three tiers** (`authorized-api`, `grey-area`, `restricted`) and the tier decides
  who may run them. Restricted sources are administrator-only and refused unless the process was
  started through the VPN-checked launcher. That enforcement is server-side. Never reduce it to a
  check in the interface.
- **Ordinary accounts must never learn which restricted sources exist** — not in the live search
  report, the stored history, or `/sources`.
- **Every query touching user data must be scoped** with `WHERE user_id = ?`. A missing scope is a
  cross-account data leak. Uniqueness on user data is per owner, never global.
- **A user's CV never leaves the server.** Not to a job site, not to an aggregator, not to any
  model or third-party service.
- **Prefer false negatives on "English is sufficient".** A wrong `pass` costs someone a real
  application.
- `/sources` and `/privacy` describe what the code actually does. If you change data handling,
  change those pages in the same commit.

## How to work

```bash
npm run dev           # http://localhost:3000
npm run dev:private   # same, but verifies a full VPN route first; required for restricted sources
npm test              # 90 tests
npm run lint
npm run typecheck
npm run build
```

All four checks pass before every commit. Add tests for anything you fix; assert the property that
was broken, not just the happy path.

Verify claims against the running app or the live source rather than assuming. When something is
uncertain, say so plainly instead of presenting a guess as fact. If you find a real problem, report
it even when it is inconvenient — the last review's most valuable findings were things that looked
fine until they were actually exercised.

## Traps that have already cost time

- The real workspace is currently owned by a throwaway account, `owner@example.test` /
  `a-long-test-password`. Task A1 is handing it to the owner. Until then that is the admin login.
- Registration is closed unless `ALLOW_SIGNUPS=true` is in `.dev.vars`. You will need it set to
  create a second test account.
- Only one `vinext dev` runs per machine; it prints the PID of any existing one. On Windows in Git
  Bash, `taskkill //PID <pid> //F` needs the doubled slashes.
- `.dev.vars` holds local secrets and is gitignored. Never commit it. `.dev.vars.example` documents
  every variable.
- Changing the session cookie format signs everyone out. That is expected, not a bug.
- `.wrangler/` is shared between checkouts of this repo, so two copies running `npm run dev` write
  to the same local database.
