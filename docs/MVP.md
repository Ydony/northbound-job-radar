# MVP scope — pre-launch and after

Dictated by the owner 2026-08-31. This is the scope document; `docs/TASKS.md` tracks the work.

**The product does one thing:** it shows you jobs where English is enough, and hides the ones that
need Dutch, German, French or Italian. Everything below either serves that or gets out of its way.

---

## Pre-launch — what must be true to ship

### P1. Sources: every feed we can legally read

Already built. Jobs come from APIs and public endpoints, never from working around an access
control. The interface keeps showing what each run scanned and added, as it does now.

- [x] EURES ×2, Job-Room, Adzuna ×2, Careerjet, and the public ATS boards.
- [x] Per-run counts: found, known, new, imported, duplicate, skipped.

### P2. Admin: a conversion report per source

**New.** For each source, what came in and what survived:

> EURES Switzerland — 1,000 found, 100 kept as English-confirmed.

Percentages, not just counts:

**"Found" means the total matching the current filter** — what the search actually returned, not
what the source holds in total. Measurable today for every source; source-wide totals are not, since
the ATS boards do not report them.

That total then breaks down into:

- **English is enough** — confirmed against a full advertisement
- **To review** — a local language is named, but not clearly required
- **Unknown** — the advertisement was too short to judge
- **Filtered out** — a local language is required

**Why it exists, in the owner's words:** *"in long term, we could find a better filtering way to
make sure we do not miss any jobs."* This is the instrument for improving the filter — it shows
where jobs are being lost and whether a source is worth keeping. It is admin-only.

- [ ] Build the report. Group by source, over a chosen run or all time.

### P3. The list is easy to use

Mostly built. Search, then work the results: dismiss, add to pipeline, mark applied or not applied.

- [x] Search, dismiss, save, applied / not applied.
- [x] Duplicates collapsed, with the other boards named.
- [x] Every action confirms itself in one line.
- [ ] **Job requirements shown on the card** (TASKS E6). Still open, and now worth doing: EURES and
      Job-Room supply full advertisements, which they did not when this was first raised.

### P4. Shelve the CV upload and the CV-fit score

**Shelved, not cancelled.** In the owner's words: *"CV score and CV add — shelve it, but we will
come back to it later. It is a feature which will be developed in future."*

Hidden from everyone, administrators included, and left intact in the code behind a flag. The point
of shelving rather than deleting is that turning it back on should be a switch, not a rebuild — so
the tables, routes and scoring stay, and stay working.

- [ ] Hide CV upload, both CV slots, the fit-score circle, and the per-slot score breakdown.
- [x] **Decided:** the score circle goes entirely and the text runs full-width. The circle, the
      matched-keyword tags and the "no clear CV overlap yet" line are all CV-derived, so with the CV
      hidden there is nothing left for that column to say. Putting the source or the date there
      instead would be decoration filling a hole. The card gets cleaner, and it matches the MVP
      being one thing: a language filter, not a matcher. The language badge already carries the
      verdict, which is the signal that matters.
- [ ] Keep the tables, the routes and the scoring code intact behind the flag so re-enabling is a
      switch rather than a rebuild.

### P5. Simplify the filters down to what defines the search

**Keep:**

| Filter | Change |
|---|---|
| Role keywords | **No change — stays at 5.** (An earlier draft raised this to 10; the owner kept 5.) |
| Required keywords | Unchanged — "ad must contain". |
| Excluded keywords | Unchanged — "ad must not contain". |

**Remove:**

- CV 1 / CV 2 role overrides — follows from P4.
- Workplace (remote / hybrid / on-site).
- Seniority.
- Contract type.
- **Location** — as a *search* filter. It moves to the results instead; see P5b.

Also considered and explicitly rejected: repurposing required-keywords as a location filter
("Amsterdam, Hoofddorp"). *"Actually, ignore that. Don't do that."* — people can type a city into
required keywords themselves if they want that behaviour.

- [ ] Remove the four filters above from the form, the criteria model and the matching logic.
- [x] Role keywords unchanged at 5.

### P5b. Location as a results facet, not a search filter

Location stops being something to guess at up front and becomes something to narrow down after the
results are in. In the filter column beside the results, **under each country, list its cities with
the number of jobs found in each** — the same shape as the existing website filter, which already
shows counts.

- [ ] Group by country, then city, each with a count. Selecting a city filters the visible list.
- [ ] **Blocker to solve first: EURES locations are not city names.** They arrive as NUTS region
      codes — `NL32B NL`, `CH031 CH` — so a naive facet would list "NL32B" as if it were a place.
      `CH031` is Basel and `NL32B` is part of North Holland, but nothing in the app resolves them.
      Either map the NUTS codes to names (a fixed public list, ~2,000 entries for the two countries,
      no lookups at runtime) or the facet is unusable for the largest source we have.
- [ ] Other sources give free text of varying shape — "Pfaeffikon · Schweiz", "Zürich",
      "Amsterdam" — so the city needs normalising before it can be counted.

### P6. Sources that only an administrator may use

Some sources cannot be offered to ordinary users. Careerjet and IamExpat join the existing
`restricted` set in being administrator-only, but for a different reason and without the VPN
requirement — so this needs a flag of its own rather than reusing `access: 'restricted'`.

- [ ] Add an `adminOnly` flag, separate from `access`, and set it on **Careerjet** and **IamExpat**.
- [ ] Non-administrators must not see those results, those source names, or those run rows. Enforce
      server-side, as `restricted` already is — not merely hidden in the interface.
- [ ] **Retroactive.** Jobs already stored from those sources are administrator-only too, not just
      newly imported ones. In the test workspace that is 213 Careerjet and 4 IamExpat jobs.
- [x] A new account starts empty and inherits nothing — jobs are already owned per account, so
      there is no path by which a second user could see another account's stored results.

### P7. Switch between administrator and ordinary-user views

A control in the top bar toggling the administrator between the full view and exactly what an
ordinary user sees.

**Purpose, in the owner's words:** *"I could easily search for a job as normal user … and see all
the stuff as an admin."* It is both a working mode and the fastest way to check that the P6
restrictions actually hold.

- [ ] Add the toggle. While in user view, hide admin-only sources, their results and the admin
      panels.
- [ ] **This is a display mode, not a privilege drop.** The account is still an administrator and
      the server still knows it. Do not let the toggle become the thing that enforces P6 — the
      server-side checks must hold regardless of which view is selected.

### P8b. Security, verified after deployment

*"Pre-launch we also need to make sure all is secure, and test its security once deployed."*

**This is not the same posture as a local tool, and the reason is the LinkedIn plan.** The owner
intends to link this publicly, to show how they look for work and build their own tools. That means
strangers will open the URL. Nobody else gets an account, but the login page, the sources page and
the privacy page become publicly reachable, and the site will attract exactly the automated traffic
that finds new domains.

That promotes three carried blockers from "before public traffic" to **actually blocking**:

| | Why it blocks now |
|---|---|
| **A1** | Both administrator passwords were pasted into a chat transcript in plain text. The only account on a publicly reachable login page must not be one of them. Rotate both, and issue a fresh `SESSION_SECRET` rather than copying a local one. |
| **A7** | The CSP allows `'unsafe-inline'` for React hydration. Acceptable while nothing is reachable; not once a URL is being handed to strangers. Move to nonces. |
| **B3** | Rate limiting resets with the process, so it is close to useless against a distributed attempt on the one account that exists. Needs a durable store. |

- [ ] Rotate both administrator logins and the session secret (A1).
- [ ] Nonce-based CSP, drop `'unsafe-inline'` (A7).
- [ ] Durable rate limiting on the login route (B3).
- [ ] **Test the deployed site, not the local one.** Confirm security headers are actually served
      from the edge, that registration is genuinely closed, that an unauthenticated request to every
      API route is refused, and that admin-only sources stay invisible without a session.
- [ ] Confirm nothing identifying the owner leaks on the public pages: no CV content, no job list,
      no email address, and no administrator email in any error message.

### P8. Owner's acceptance pass

The last gate. Not something to be done for the owner.

- [ ] Owner walks every tab and page, reads all copy, gives feedback on wording and interface.
- [ ] Owner checks the security behaviour.
- [ ] Fix what comes back, then ship.

---

## Known launch blockers, carried from TASKS.md

Not part of the dictated scope, but they gate a public deployment regardless.

| | Blocker | Needs |
|---|---|---|
| A1 | Both administrator passwords were pasted in plaintext | Rotate, plus a fresh `SESSION_SECRET` |
| A7 | CSP allows `'unsafe-inline'` for React hydration | Nonces before public traffic |
| B3 | Rate limiting resets with the process | A durable store |
| B1/B2 | No password reset, no email verification | **Not blocking the launch** — the owner is the only user and registration stays closed. But the owner also expects *"most users will be from"* the Netherlands, so this is a "not yet" rather than a "never": both become blocking the moment a second account exists, and an email provider has to be chosen before then. |
| B6 | Careerjet is IP-locked to a declared address | Cloudflare Workers have no static egress IP, so it cannot work in production as it stands. P6 makes it administrator-only, which contains but does not solve this. |

---

## After launch — aims, in the owner's order

**The overall aim, above all the rest: find as many jobs as possible where English alone is good
enough.** Every aim below serves that; where they conflict, this one wins.

### 1. Coverage — more jobs where English is enough

Not more jobs. More *screenable* jobs, and fewer lost to a filter that could not see enough of the
advertisement to decide.

- **626 jobs sit in `unknown`** because Adzuna caps descriptions at 500 characters and Careerjet at
  279. Their full text is only reachable through the aggregator's redirect link, which is a
  licensing question rather than a technical one.
- **Job-Room already proved the value of fixing this**: its detail endpoint returns 4,193 characters
  against 316 in search, and on 20 test advertisements **18 changed verdict** once the whole text
  was read.
- The admin conversion report (P2) is the instrument for this. It shows where jobs are being lost.

### 2. The Netherlands is the priority market

*"Most users will be from there."* The name is Dutch, the domain is `.nl`, and the tagline names
Dutch. Where effort has to be chosen between the two countries, the Netherlands comes first.

Worth knowing: **EURES Netherlands alone holds 245,007 jobs**, against 41,896 for Switzerland, so
the priority and the available supply already agree.

### 3. Cheap or free to run

*"It should be efficient and not use a lot of resources, to make it cheap or free to run."* A
standing constraint on design, not a task — it rules things out before they are built.

Already relevant:

- **`/api/state` sends every job in one response**, roughly 2 MB at 1,000 jobs, of which about a
  third is advertisement text carried only so the browser can match keywords. Tracked as B4. This is
  the single largest running cost in the app and it grows with use.
- **Bulk sources are cheap, per-job fetching is not.** EURES returns 50 complete advertisements per
  request; Job-Room needs one request per advertisement. Prefer the former shape when adding
  sources.
- Cloudflare's free tier is the target. Anything requiring a paid subscription — a scraping service,
  a paid aggregator — should be weighed against EURES being free and already sufficient.

### 4. Better filtering, and a more polished interface

The filter and the interface, in that order. Filtering is the product; polish is what makes it
usable by someone who is not its author.

### Deferred, not dropped

- **The CV fit score** (P4) — switched back on if a use for it becomes clear.
- **Jooble** (TASKS E9) — owner registers a key, then one measurement decides it.
- **Apify** (TASKS E11) — only with an actor that reads documented public endpoints.
- **Arbeitnow** (TASKS E10) — strong source, wrong countries. Revisit if Germany or the UK is added.
