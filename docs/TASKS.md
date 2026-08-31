# Task list

Ordered by what blocks dependable local use. Tick items off as they are completed so another
session can continue without reconstructing the state.

## A. Current work — complete in order

### A1. Rotate both administrator logins before any live environment — deferred by decision

Both generated passwords were posted in plain text into a chat transcript. The owner has accepted
that risk for now (2026-08-31) on the grounds that both environments are local-only, bound to
loopback, and hold no third party's data. Work continues using them.

This becomes blocking the moment anything is reachable beyond this machine.

- [ ] Rotate both logins as part of creating the first live environment, before it accepts traffic.
- [ ] Rotate `SESSION_SECRET` for the live environment rather than copying a local one.

### A2. Local environments — done 2026-08-31

- [x] `dev` runs at `http://localhost:3000` with hot reload.
- [x] `test` runs the built Cloudflare Worker locally at `http://localhost:3001`.
- [x] D1 and R2 state are isolated under `.wrangler/dev/state` and `.wrangler/test/state`.
- [x] Session secrets are isolated in `.dev.vars.dev` and `.dev.vars.test`.
- [x] The legacy workspace was copied into test; its original state remains as recovery data.
- [x] Both login pages return HTTP 200 while the two processes run concurrently.

### A3. Exercise the app as a new second user — done 2026-08-31

Both halves are now scripted and repeatable rather than done by hand once.

- [x] `npm run verify:dev` — 14 checks covering registration, CV upload, criteria, authorized
  search and the refusal of restricted mode, pipeline states, language correction, tenant
  isolation, export shape, credential change, session revocation, page rendering, workspace reset,
  and account deletion.
- [x] `npm run verify:admin` — 9 checks covering the administrator half that was previously
  deferred: the overview being counts-only, administration refused to non-admins, promote and
  demote, disable ending a live session immediately, enable restoring access, a password reset
  invalidating the old password, the last-administrator and self-action guards, and deletion.

Each asserts the effect rather than a 200: disabling must end that account's session, a reset must
kill the previous password, and a deleted account must not be able to sign in.

Dev keeps `ALLOW_SIGNUPS=true` because both verifiers create disposable accounts. Test keeps it
false.

### A4. Remove leftover test debris from the test workspace — done 2026-08-31

- [x] Deleted `second@example.test` from test. It held one synthetic CV and no jobs.
- [x] Confirmed test now has one account, `admin-test@ikengels.test`, owning all 1,004 jobs and
  both real CVs.

### A5. The reported test failure — root cause found 2026-08-31

Saving criteria in test failed with "NetworkError when attempting to fetch resource", and settings
and admin appeared broken. This was first recorded as a probable restart interrupting an open tab.
**That diagnosis was wrong.**

The real cause was the Content-Security-Policy blocking React's inline hydration scripts (A7). With
hydration dead, no form could complete its request and no button responded, while server-rendered
pages and direct URLs looked perfectly healthy — which is exactly what was reported. It also
explains why every curl check passed: curl does not execute JavaScript, so the server appeared
fine and only the browser was broken.

- [x] Fixed in A7; both environments verified interactive in a real browser.
- [x] Lesson recorded: an endpoint returning 200 to curl is not evidence the page works. Check the
  browser console before concluding a client-side report is environmental.

### A6. Protect the local test workspace — done 2026-08-31

- [x] `npm run backup:test` and `npm run backup:dev` copy that environment's D1 and R2 state with a
  manifest. Both refuse to run while their server is up, since a live SQLite copy would be
  inconsistent.
- [x] `npm run backup:verify <path>` re-walks a backup and checks every file against the manifest.
  Verified against a real 4 MB, 14-file backup of the populated test workspace.
- [x] Retention: the ten newest backups per environment are kept and older ones pruned
  automatically, so taking one routinely cannot fill the disk. The backup just written is never
  pruned.

Take one before any migration that touches a populated workspace.

### A7. Replace the inline-script CSP allowance with nonces before any public deployment

Fixed 2026-08-31: `script-src 'self'` blocked every inline script React streams for hydration.
Pages rendered server-side, so direct URLs worked, but nothing hydrated — links showed a target on
hover and did nothing on click, and no button or form responded. It reads like a browser or
ad-blocker fault and is not one.

`'unsafe-inline'` is the fix that works in this stack, because there is no middleware here to stamp
a per-request nonce. The exposure is limited while the app is local and single-tenant: all user
data renders through React's escaping and there is no `dangerouslySetInnerHTML` anywhere.

- [ ] Before any public deployment, move to nonce-based script CSP and drop `'unsafe-inline'`.
- [ ] Note that a restart is required after changing `next.config.ts`; dev kept serving the old
  header until it was restarted, which briefly made the fix look ineffective.

### A8. Navigation and the missing root CSP — fixed 2026-08-31

Two separate faults, both found only by clicking in a real browser. Every endpoint returned 200 to
curl throughout, which is why they survived earlier checks.

**Navigation did nothing.** vinext 1.0.0-beta.3 ships a `next/link` shim whose client chunk throws
`TypeError: e is not a function` the moment a link is clicked. The href looked correct on hover and
the click was swallowed. Every `next/link` is now a plain anchor: each internal destination is a
different page with its own data, so a full load costs nothing, and the eslint rule that wants
`Link` is disabled with that reasoning recorded. Revisit if vinext fixes it.

**The dashboard had no security headers.** The header rule used `source: '/:path*'`, which did not
match the bare `/` in this runtime. Every other route carried the CSP while the one page holding
every job and both CVs carried none. The root is now matched explicitly.

- [x] Verified in the browser: Settings and Admin both open and render.
- [x] Verified `/` and `/settings` both serve the CSP.

## B. Known gaps

### B1. No self-service password reset

There is no mail sender. A locked-out user needs an administrator to set a new password from
`/admin`. The existing unused reset schema should not be exposed until an email provider and a
complete reset flow exist.

### B2. No email verification

Registration is closed by default. If it is opened later, users can currently register an address
they do not own.

### B3. Rate limiting is process-local

`lib/guard.ts` counters reset with the process. This is acceptable for loopback-only use but must
be replaced before any future public hosting.

### B4. The dashboard still loads every job in one response

Partly addressed 2026-08-31. The test workspace had reached 1,004 jobs against a 1,000-row cap, so
four were silently missing from the interface with nothing to indicate it. The limit is now 2,000,
the true total is returned, and the header says "Showing the N most recent of M" whenever the
response is truncated — hiding jobs without saying so was the actual defect.

This buys headroom rather than solving it. The response is ~2 MB at 1,000 jobs and descriptions are
about a third of that, carried only so the client can match required/excluded keywords.

- [ ] Move keyword filtering server-side, or stop sending full descriptions, then paginate.
- [ ] Revisit before any account approaches 2,000 jobs.

### B5. Undutchables is a weak, restricted source

Its `robots.txt` rejects automated requests and it yields very few jobs. Keep the adapter truthful
and administrator/VPN-only; removal remains a reasonable product decision.

### B6. Careerjet licensing and IP scope remain unresolved

Local execution avoids the former Cloudflare static-egress problem, but the API key is still tied
to registered publisher/IP terms. Keep Careerjet disabled when its key or permission is absent and
never describe an unavailable source as searched.

**Registering the real domain closes most of this.** The intended domain is **ikbeneenappel.nl**,
confirmed free (no DNS records as of 2026-08-31). Careerjet binds a key to one registered publisher
website, and the key in use currently names a placeholder domain nobody here owns — that is the
"open question" shown on `/sources`. Registering the real domain with Careerjet, and setting
`CAREERJET_REFERER` to match, moves the integration inside its licensed scope. The declared IP
still has to match wherever the app actually runs, which is fine while it stays local on a stable
connection.

### B7. Product name and domain do not match

The product is called **Ik Engels** throughout the code, the dashboard header, the login page,
`/sources`, `/privacy`, and both READMEs. The intended domain is `ikbeneenappel.nl`. If the name
changes with the domain, decide before writing more user-facing copy — the rename is cheap now and
touches several pages later.

## E. Requested 2026-08-31 — from screenshots of the test workspace

The user reviewed the live list and reported four defects and two changes. Recorded verbatim in
intent so nothing is lost if this is picked up by someone else.

### E1. Language screening misses obvious requirements — DONE

Reported: *"language filtration does not work too well"*, with a card titled "Online Data Analyst -
German Language" marked ENGLISH SUFFICIENT.

Measured before changing anything: of 1,004 stored jobs, 13 name a language in the title and **9 of
those were not blocked** (7 review, 2 pass). The gate only ever saw the description, and on
aggregator teasers the description is a truncated blurb that never repeats what the headline says.

Requested design, in the user's words:

- A database of phrases such as "fluent in German", and common variations built from `mandatory`,
  `fluent` + French / Italian / Dutch / German.
- If the text matches one of those phrases → **exclude**, because "we do not want to see it".
- After that filter, if a language word (French, Italian, Dutch, German, Spanish) is merely
  mentioned → **review needed**.
- Constraint: "a reasonable amount of key phrases … without overloading the server or making the
  filter too long to run."

- [x] Read the job title, not only the description.
- [x] Build the phrase table and the two-stage exclude → review decision (`lib/language-rules.ts`).
- [x] Add Spanish to the languages that are recognised at all.
- [x] Backfill jobs stored under the old rules (`normalizeStoredJobs`, versioned so future rule
      changes re-run automatically). In the test workspace: pass 191→179, blocked 233→249.

### E2. The same job appears several times — DONE

Reported with a screenshot of one advertisement listed twice.

Root cause: `identity_fingerprint` hashes location and exact posting day, so "LGT Capital Partners
AG, Pfaeffikon · Schweiz" and "LGT Capital Partners AG · Schweiz" hashed differently. A hash cannot
express "within four days" or "one location contains the other".

Requested rule: same or similar job title, same company, same city, posted within 4 days.

Measured: **207 of 993 active jobs (21%) are redundant copies**, across 129 groups, 64 of which span
more than one board.

- [x] Cluster key, near-duplicate comparison, `duplicate_of`, and a backfill for existing jobs.
- [x] Show "also posted on X, Y" on the job that is kept, with a count of what was folded away.
      105 copies folded in the test workspace, 81 cards carry the line.

### E3. Remove the manual "Analyze & add" dialogue — DONE

Reported: *"no need for analyse job section"*, with a screenshot of the paste-an-advertisement modal.

Superseded by automated search across the configured sources; keeping it costs a route, a modal, and
a validation surface for a workflow nobody uses now.

- [x] Dialogue and both triggers removed. `POST /api/jobs` kept: it is the only non-search import
      path and is covered by tests.

### E4. Confirm every list action with one line of text — DONE

Reported: *"when pressed saved and when moved to pipeline, there should be a tiny one line text
saying saved to pipeline. same for other actions, like dismissed"*.

Today save / applied / not-applied / dismiss change the card silently, so on a long list it is not
obvious the click registered.

- [x] Added, self-clearing after 3.2s. A failed write rolls the confirmation back too, rather than
      claiming a save that did not happen.

### E5. HTML entities are shown raw in titles — DONE

Spotted while measuring E2: `Senior Cost &amp; Inventory Analyst` sat next to
`Senior Cost & Inventory Analyst` — displayed wrongly, and never matched as a duplicate.

- [x] Decode entities, and apply it to titles rather than only to description HTML.

### E6. Requirements are not shown on a card

Reported earlier the same day: *"each job should have requirements displayed, so it would be easier
to decide if fits me or not"*.

Measured: only 23% of stored jobs contain a detectable requirements heading, but 85% of full-length
advertisements (≥1500 chars) do — and there are only 114 of those. 512 of 1,004 are teasers under
400 characters with no requirements in them to find. Ingest was also destroying the structure:
jobs.ch descriptions averaged 3,173 characters with 0% surviving list markup.

- [x] Stop flattening `<ul>`/`<li>`/`<p>` at ingest so the structure survives.
- [ ] Extract a requirements section by heading and show the first few bullets, collapsed.
- [ ] For teaser-length ads, link out instead of showing a fake excerpt.
- [ ] Re-fetch existing jobs, which were stored before structure was preserved.

### E7. Source health showed a red IP alert above "Careerjet — Working" — DONE

The panel compared the live IP against CAREERJET_USER_IP, which is only the value configured
locally. On a dynamic home connection those drift apart while Careerjet keeps answering.

- [x] The verdict now follows the probe. A mismatch while Careerjet answers is reported as a stale
      local note, not an outage.

### E8. Sources research — DONE

Requested: "look for more links, maybe european union job website ... search for more possible
sources", then "I meant europa.eu".

- [x] **EURES added** — 245,007 NL and 41,896 CH jobs, full advertisements (median 1,955 / 3,191
      chars), public endpoint, no key, CC BY 4.0. Now the best source in the project by a distance.
- [x] **Job-Room full-text fetch** — detail endpoint returns 4,193 chars against 316 in search.
      18 of 20 test advertisements changed verdict once the whole text was read.
- [x] Rejected and recorded so it is not researched twice: `data.europa.eu` (a dataset catalogue;
      the Dutch entries are CBS vacancy *statistics*), `werk.nl`/UWV (no public API, and reached
      through EURES anyway).
- [ ] **Open decision:** Adzuna produces 148 "English sufficient" verdicts and none rests on a full
      advertisement. Either fetch through its redirect link (a licensing question) or reclassify
      short ads as *unknown*. See `docs/SOURCES_PIPELINE.md`.
- [ ] **Open decision:** split `pass` into "English confirmed" and "unknown", so a pass is
      impossible on a truncated ad. This is what makes the good bucket trustworthy.

### E9. Jooble — check the description length before wiring anything — OWNER TODO

Raised by the owner 2026-08-31, along with Arbeitnow and an Apify scraper.

**Blocked, and it needs the owner to act first**: every Jooble route sits behind Cloudflare bot
protection (`jooble.org`, `us.jooble.org`, `nl.jooble.org` all 403, and the docs page never gets
past "Performing security verification"). Using their API with a registered free key is a front
door and entirely legitimate; getting past that wall is not, and was not attempted. No public
client library documents the response either - the only npm package, `@pipedream/jooble`, is a
3 KB stub with no implementation.

- [ ] Owner registers for a free API key at the Jooble partner page.
- [ ] **Then run one call and measure the median description length.** This is the whole decision,
      and it takes ten minutes:

      POST https://jooble.org/api/{KEY}
      {"keywords": "data analyst", "location": "Amsterdam"}

      Read the field carrying the advertisement body. There is an unverified recollection that it
      is called `snippet`, which would say everything - but it is unverified, so measure rather
      than assume.

- [ ] Decide on the measurement, not on the volume:
      - Median **>= 1500 chars** -> worth an adapter; it joins EURES as a screenable source.
      - Teaser-length (a few hundred, or a hard cap like Adzuna's 500 or Careerjet's 279) ->
        **do not add it.** It would pile on volume while producing exactly the untrustworthy
        "English sufficient" verdicts that `docs/SOURCES_PIPELINE.md` documents. More jobs we
        cannot screen is a step backwards, not forwards.

### E10. Arbeitnow — measured and rejected, keep on file

Free, no key, and the best text quality measured anywhere: median 6,059 characters, against
EURES at 1,955-3,191 and Adzuna at 500. It also publishes a real `remote` boolean and tags.

Wrong countries, though. Scanned 950 jobs across 8 pages: **one** touched the Netherlands or
Switzerland, and that one was a German advertisement naming "Deutschland, Osterreich, Schweiz und
Italien" as its region. Top locations were London, Berlin, Munich, Hamburg, Dusseldorf.

**The remote angle was checked separately**, since Arbeitnow is usually recommended for its remote
flag and that would make the country mismatch irrelevant. It does not rescue it: of 950 jobs, 45
are `remote: true` (5%), and 40 of those are blocked because they require German - unsurprising on
a German-market board. **Five jobs were both remote and English-sufficient**, two of them from the
same London company and one titled "Homeoffice ... (w/m/d)". A yield of roughly 0.5%.

For comparison, EURES supplies 287,000 Netherlands and Switzerland jobs at a 12-18% pass rate.

- [x] Measured twice - by country, then by the remote flag. Not added on either basis.
- [ ] Revisit only if the product ever covers Germany or the UK, where it would be a strong source.

### E12. eurojobs.com — declined, they said no explicitly

Checked 2026-08-31 at the owner's request. `robots.txt` names Anthropic's crawler directly:

    User-agent: ClaudeBot
    Disallow: /

alongside GPTBot, CCBot, Bytespider, Google-Extended, Applebot-Extended, Amazonbot and
meta-externalagent. It also carries `Content-Signal: search=yes,ai-train=no,use=reference` and an
express reservation of rights under Article 4 of EU Directive 2019/790 - the text and data mining
opt-out, which is legally operative in the EU rather than merely advisory.

There is no API and no feed; the only machine-readable surface is a sitemap, which points at a
different host entirely (`rebuild.otint.org`).

Nothing to weigh here. The site has refused this specific use in the clearest terms available to
it, and both countries are already covered by EURES with full advertisement text.

- [x] Checked; not added, and not to be revisited without written permission from the operator.

### E11. Apify EU Jobs Scraper — PARKED, owner to revisit

Offered as a tool that "circumvents anti-scraping walls for you". That is the one line this project
has held throughout and which `AGENTS.md` records: no detection evasion, no getting past anti-bot
measures. Declined on that basis rather than on capability.

Two practical points reinforce it: it is a paid middleman for data now obtained directly and free
from EURES, and the wall it would be used against is exactly the kind Jooble has put up
deliberately.

Apify itself is a legitimate platform and many of its actors only call documented public endpoints.
A specific actor of that kind is a different question and can be looked at on its own merits.

Parked by the owner on 2026-08-31 as their own item, alongside E9, rather than closed.

**What would make this buildable**, so the next session does not have to relitigate it: a specific
Apify actor that reads only documented public endpoints. That is an ordinary API client with a
billing layer in front, and there is no objection to it - send the actor and it can be wired up
like any other adapter. What will not be built is an actor whose function is getting past an
anti-bot wall, and commissioning that from a third party is the same act as doing it here.

**The practical case is weaker than the principled one anyway.** The sites behind those walls are
aggregators, and every aggregator measured so far returns teasers - Adzuna caps at 500 characters,
Careerjet at 279. The likely outcome is a paid subscription that supplies more jobs which still
cannot be screened, which is the precise failure `docs/SOURCES_PIPELINE.md` documents. EURES
already supplies 287,000 Netherlands and Switzerland jobs, with full text, free. Those sites also
syndicate from the same employers EURES carries, so the content is not unique.

- [ ] **Owner:** decide whether to pursue, and if so identify a specific actor and what it calls.
- [ ] If that actor only reads public documented endpoints, evaluate it on description length the
      same way as everything else - the measurement in E9 is the template.

## C. Product improvements, in value order

- [ ] **C1.** Build and label a representative real-ad language corpus.
- [ ] **C2.** Add pagination/server-side job filtering before the test account exceeds 1,000 jobs.
- [ ] **C3.** Expand authorized direct-employer and public ATS feeds.
- [ ] **C4.** Improve cross-source deduplication when posting dates are absent.
- [ ] **C5.** Add alerts/digests only for sources that authorize scheduled discovery.
- [ ] **C6.** Improve Netherlands coverage without LinkedIn or access-control bypasses.

## D. Completed product capabilities

- [x] Multi-user accounts and per-account ownership across user-data tables.
- [x] Session revocation, CSRF checks, security headers, and closed-by-default registration.
- [x] Admin and account settings, including deletion and password changes.
- [x] Two CVs, derived/overridden roles, five general roles, filters, dual fit scoring.
- [x] Saved/applied/dismissed states and durable dismissal tombstones.
- [x] Country/source/result filters and per-source search-run statistics.
- [x] Language corrections preserved separately from detector output.
- [x] JSON/CSV export, job deletion, CV replacement/deletion, and workspace reset.
- [x] Local-only dev/test environment split with no supported hosted environment.
