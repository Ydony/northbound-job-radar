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

### P2. Admin: a conversion report per source — DONE

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

- [x] Built, administrator-only. Per source: found, then English confirmed / review / too short /
      blocked, each with its share. Sorted by usable jobs rather than volume, and the "too short"
      share is highlighted past half — that is the number saying a source is not publishing enough
      of its advertisements to judge.

### P3. The list is easy to use

Mostly built. Search, then work the results: dismiss, add to pipeline, mark applied or not applied.

- [x] Search, dismiss, save, applied / not applied.
- [x] Duplicates collapsed, with the other boards named.
- [x] Every action confirms itself in one line.
- [x] **Job requirements shown on the card.** Extracted only where the employer stated them under
      a heading — 109 jobs, about a quarter of full-length ads. Everything else shows nothing
      rather than an excerpt of marketing copy, which would read as an answer without being one.
      Possible only because ingest stopped flattening HTML: a requirements list is recognisable
      because it is a list.

### P4. Shelve the CV upload and the CV-fit score — DONE

**Shelved, not cancelled.** In the owner's words: *"CV score and CV add — shelve it, but we will
come back to it later. It is a feature which will be developed in future."*

Hidden from everyone, administrators included, and left intact in the code behind a flag. The point
of shelving rather than deleting is that turning it back on should be a switch, not a rebuild — so
the tables, routes and scoring stay, and stay working.

- [x] Hidden behind `CV_MATCHING_ENABLED` in `lib/features.ts`.
- [x] Search no longer requires a CV. It used to refuse to run without one, because terms were
      partly derived from it — an optional feature was blocking the product's only job. Measured
      first: the CV contributed one job title per file, both already overridden by typed roles, so
      the search terms are byte-identical without it.
- [x] **Decided:** the score circle goes entirely and the text runs full-width. The circle, the
      matched-keyword tags and the "no clear CV overlap yet" line are all CV-derived, so with the CV
      hidden there is nothing left for that column to say. Putting the source or the date there
      instead would be decoration filling a hole. The card gets cleaner, and it matches the MVP
      being one thing: a language filter, not a matcher. The language badge already carries the
      verdict, which is the signal that matters.
- [x] Tables, routes and scoring left intact and still running; they score zero with no CV stored.

### P5. Simplify the filters down to what defines the search — DONE

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

- [x] Removed from the form and the matching logic. The criteria columns stay in the database and
      are simply not read, with a test asserting a stored value cannot quietly keep filtering.
- [x] Role keywords unchanged at 5.

### P5b. Location as a results facet, not a search filter — DONE

Location stops being something to guess at up front and becomes something to narrow down after the
results are in. In the filter column beside the results, **under each country, list its cities with
the number of jobs found in each** — the same shape as the existing website filter, which already
shows counts.

- [x] Grouped by country, busiest first, each with a count. Switching country clears the place.
- [x] **Solved: EURES locations are not city names.** They arrive as NUTS region
      codes — `NL32B NL`, `CH031 CH` — so a naive facet would list "NL32B" as if it were a place.
      `CH031` is Basel and `NL32B` is part of North Holland, but nothing in the app resolves them.
      Either map the NUTS codes to names (a fixed public list, ~2,000 entries for the two countries,
      no lookups at runtime) or the facet is unusable for the largest source we have.
- [ ] Free text from other sources is still uneven: "Zürich" and "Zürich 8000 ZH" count as two
      places, and "Nederland" appears as though it were a city. Cosmetic, worth a pass later.

### P6. Sources that only an administrator may use — DONE

Some sources cannot be offered to ordinary users. Careerjet and IamExpat join the existing
`restricted` set in being administrator-only, but for a different reason and without the VPN
requirement — so this needs a flag of its own rather than reusing `access: 'restricted'`.

- [x] `adminOnly` added, separate from `access`, and set on both.
- [x] Excluded in SQL in the jobs read path, dropped before a run starts in the search path, and
      filtered from run rows — all from one derived list, so it cannot drift.
- [x] Retroactive by construction: the rule is on the source key, so stored jobs are covered.
- [ ] **Still to verify end-to-end with a second account** — the enforcement is unit-tested and the
      SQL is right, but nobody has yet signed in as a non-administrator and confirmed the rows are
      absent. `npm run verify:dev` creates disposable accounts and is the tool for it. Do this in P8.
- [x] A new account starts empty and inherits nothing — jobs are already owned per account, so
      there is no path by which a second user could see another account's stored results.

### P7. Switch between administrator and ordinary-user views — DONE

A control in the top bar toggling the administrator between the full view and exactly what an
ordinary user sees.

**Purpose, in the owner's words:** *"I could easily search for a job as normal user … and see all
the stuff as an admin."* It is both a working mode and the fastest way to check that the P6
restrictions actually hold.

- [x] Added to the top bar. In user view the admin-only rows, sources and panels are hidden.
- [x] Kept a display mode. The server enforces P6 regardless of the toggle, and the code says so
      where someone might later be tempted to rely on it.

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

Written up as `docs/ACCEPTANCE_TEST.md` — nine sections, in order, with what to look for rather
than just what to click.

- [ ] Owner walks every tab and page, reads all copy, gives feedback on wording and interface.
- [ ] Owner checks the security behaviour.
- [ ] **Section 7b is the one that matters most**: sign in as a genuine second account and confirm
      the administrator-only sources are absent. The Careerjet leak passed every unit test, so this
      is the check that would actually have caught it.
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
