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

### P4. Hide the CV upload and the CV-fit score

The CV feature is **hidden from everyone, administrators included** — not deleted. It stays in the
code to be switched back on later once there is a clearer idea of what it is for.

- [ ] Hide CV upload, both CV slots, the fit-score circle, and the per-slot score breakdown.
- [ ] Decide what the card shows where the score circle was. **Open question** — the circle, the
      matched-keyword tags and the "no clear CV overlap yet" line are all CV-derived, so hiding the
      CV leaves a visible hole in the card layout that needs a deliberate answer, not a blank.
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
| ~~B1/B2~~ | ~~No password reset, no email verification~~ | **Not a blocker.** The owner is the only user and registration stays closed, so no email provider is needed to launch. Becomes blocking the moment anyone else gets an account. |
| B6 | Careerjet is IP-locked to a declared address | Cloudflare Workers have no static egress IP, so it cannot work in production as it stands. P6 makes it administrator-only, which contains but does not solve this. |

---

## After launch

### Better filtering, measured

The conversion report (P2) exists to answer one question: **which jobs are we losing, and why?**
The aim is to keep raising the share of advertisements we can decide about, without ever loosening
the rule that a `pass` requires evidence.

Two things already point the way:

- **626 jobs sit in `unknown`** because Adzuna caps descriptions at 500 characters and Careerjet at
  279. Fetching their full text through the aggregator redirect is a licensing question, not a
  technical one.
- **Job-Room proved the value of the fix**: its detail endpoint returns 4,193 characters against 316
  in search, and on 20 test advertisements **18 changed verdict** once the whole text was read.

### Deferred, not dropped

- **The CV fit score** (P4) — switched back on if a use for it becomes clear.
- **Jooble** (TASKS E9) — owner registers a key, then one measurement decides it.
- **Apify** (TASKS E11) — only with an actor that reads documented public endpoints.
- **Arbeitnow** (TASKS E10) — strong source, wrong countries. Revisit if Germany or the UK is added.
