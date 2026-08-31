# Acceptance test — the owner's pass before launch

This is P8 in `docs/MVP.md`: the last gate before anything ships. It is deliberately yours to run.
Software that passes its own tests can still be wrong in ways only a person notices.

Work through it in order. Where something is wrong, note **what you saw** rather than what you think
caused it — the cause is my job and a wrong guess sends me down the wrong hole.

---

## Credentials

**Not written down here.** This repository is public
(`github.com/Ydony/northbound-job-radar`), so anything committed to it is published.

Your logins are in the environment files, which `.gitignore` already excludes:

```bash
cat .dev.vars.test    # test environment, port 3001
cat .dev.vars.dev     # dev environment, port 3000
```

Accounts: `admin-test@ikengels.test` (test) and `admin-dev@ikengels.test` (dev). Both addresses
still carry the old product name; that is deliberate — they are credentials, and renaming them
breaks sign-in for no benefit. They get replaced when A1 rotates both logins for the live
environment.

## Starting up

```bash
npm run test:local     # builds, then serves on http://localhost:3001
```

If the build fails with `EPERM ... dist`, a previous server is still holding the folder. Stop any
running `wrangler`/`workerd` process, delete `dist`, and run it again. This has happened repeatedly
and is a known annoyance, not a code fault.

**A running server is not proof of a current build.** When the build fails, the old server keeps
answering on 3001 and everything looks fine while you are testing yesterday's code. If something
you expect to have changed has not, check the build output before reporting it.

---

## 1. First impressions — before signing in

Open `http://localhost:3001/login` in a fresh private window.

- [ ] The name reads **Ik ben een appel**, and the tagline is *"An English job-search filter for
      people who do not speak Dutch."*
- [ ] Nothing mentions CVs. That feature is shelved, so any copy promising CV upload or scoring is
      a leftover.
- [ ] "Register" is reachable but registration is **closed** — creating an account should be
      refused. Confirm it actually is.
- [ ] The privacy notice and sources pages open from here, and read as though written for a stranger
      rather than for you.
- [ ] Nothing identifies you personally: no email address, no job list, no CV, no IP address.

**Read every word on this page.** It is the one strangers will see when you link this from LinkedIn.

## 2. Sign in and look at the shape of it

- [ ] The list loads without an error.
- [ ] The header stays put as you scroll.
- [ ] Four buckets, and the counts add up to the total: **English confirmed**, **Not enough of the
      ad**, **Review**, **Blocked**.
- [ ] No score circle on any card, and no keyword tags — the CV is shelved, so nothing should claim
      to score against one.

## 3. The language gate — the thing this product is

This is the part worth being slow about.

- [ ] Open **English confirmed** and read five or six ads in full on the source site. Does English
      genuinely look sufficient for each? **Any job here that actually needs Dutch or German is the
      most serious kind of failure this app can have** — note the title and the source.
- [ ] Open **Blocked** and read a few. Is each genuinely requiring a local language, or has
      something been thrown away wrongly? Over-blocking is safer than under-blocking but still
      costs you jobs.
- [ ] Open **Not enough of the ad**. These should be short, truncated listings — mostly Adzuna and
      Careerjet. If a full-length advertisement is sitting here, something is wrong.
- [ ] Use **Flag wrong** on anything you disagree with. That is recorded with what the detector saw
      at the time, and it is the raw material for improving the filter.

## 4. Duplicates

- [ ] Scroll a page or two. Do you see the same job twice?
- [ ] Where a card says **"Also posted on …"**, are those genuinely the same job?
- [ ] The reverse matters too: two *different* jobs at the same company wrongly merged into one.
      Harder to spot, worth watching for.

## 5. Every action does what it says

For a single job, in order:

- [ ] **Save** — a line appears saying it was saved to the pipeline, and clears after a moment.
- [ ] **Applied** — says so, and the job appears under Pipeline.
- [ ] **Not applied** — says so.
- [ ] **Dismiss** — says so, the card leaves the view, and it turns up under Dismissed.
- [ ] **Restore** from Dismissed — comes back.
- [ ] Reload the page. Every one of those survived.

## 6. Search settings

- [ ] Only three things: **role keywords**, **required keywords**, **excluded keywords**.
- [ ] Nothing for location, workplace, seniority or contract type — those were removed.
- [ ] Change a role keyword, save, and confirm it holds after a reload.
- [ ] Run a search. It should work **without a CV**, since there is no longer any way to add one.

## 7. Sources — and the check that matters most

- [ ] The website filter counts jobs, not websites, and does not list sources with nothing in the
      current view.
- [ ] **Source health** is visible to you as an administrator. It shows the server's public IP,
      which is why it must never appear for anyone else.

### 7b. The one thing still unverified

A Careerjet leak was found on 31 August: 218 jobs were stored under `jobviewtrack.com` while the
hidden list named `careerjet-ch`, so they were reachable by ordinary accounts while every unit test
passed. The tests now cover it — **but nobody has yet signed in as a non-administrator and seen
those rows absent**, and that is precisely the gap the leak lived in.

- [ ] Press **View as user**. Careerjet, IamExpat, jobs.ch, jobup.ch and Undutchables must vanish
      from the job list, from the website filter, and from the source coverage report.
- [ ] **Then do it for real**, because the toggle is only a display mode and proves nothing about
      the server:

      npm run dev              # port 3000, registration is open there
      npm run verify:dev       # creates a disposable account and exercises the app

      Sign in as that second account and confirm those sources are absent. If any Careerjet or
      IamExpat job is visible, stop and tell me — that is a real hole, not a cosmetic one.

## 8. Security

- [ ] Sign out. Then paste a job URL from your list directly into the address bar. You should be
      sent to sign in, not shown the job.
- [ ] While signed out, try `http://localhost:3001/api/state` — it must refuse, not return data.
- [ ] Try `/admin` as the second account from 7b. It must refuse.
- [ ] Change your password in Settings, then confirm the old one no longer works.
- [ ] Open the browser console on the dashboard. Errors there are worth reporting even if
      everything looks right — the page can render perfectly while being broken underneath.

## 9. Read all of it

- [ ] Every page: dashboard, settings, admin, sources, privacy, login, register.
- [ ] Anything that reads as though written by a machine, over-explains, or promises something the
      app does not do.
- [ ] Anything still referring to CVs, fit scores, or the old names *Ik Engels* or *Northbound*.
- [ ] Anything you would be embarrassed by if a recruiter followed your LinkedIn link and read it.

---

## Reporting back

For each problem: **where you were, what you did, what you saw.** A screenshot beats a description.

Sort them yourself into:

- **Blocking** — wrong job verdicts, anything visible that should not be, anything broken.
- **Should fix** — wording, layout, confusing behaviour.
- **Later** — ideas and preferences.

I will fix the first two before this ships, and record the third against the post-launch aims.

---

## Not part of this pass

These are known, tracked, and deliberately not done yet:

| | |
|---|---|
| **A1** | Both administrator passwords were pasted in plain text and must be rotated before anything goes live. Given this repository is public, that also means never committing the new ones. |
| **A7** | CSP still allows `'unsafe-inline'`; nonces before public traffic. |
| **B3** | Rate limiting resets with the process. |
| **P2** | The admin conversion report is not built yet. |
| **P5b** | The location facet is not built yet, though the place names behind it are now correct. |
| **E6** | Job requirements are not shown on the card yet. |
