# Indeed handover — current as of 2026-09-21

## Current operator module (September 21 follow-up)

The reusable entry point is now `npm run indeed -- search --env test`, or the existing
dashboard's **Search Indeed only** button. Setup/login are one-time local operations;
neither transport research nor a readiness click is part of an everyday search. See
[INDEED_TESTING.md](INDEED_TESTING.md) for setup, exact commands, Node API and recovery.

The CLI delegates to the existing authenticated `/api/scrape` route with `sourceGroup=indeed`.
It uses the platform's saved criteria, account-scoped storage, screening, deduplication,
dismissal memory and reports. It is not a second ingestion implementation or database.
This work is isolated on `ai/indeed-acceptance-followup-20260921-180342-938897` until reviewed
and promoted. The primary checkout/server is not silently upgraded.

**Correction to the older credential section below:** provenance is known. The private
acceptance launcher read the explicitly approved JobSpy revision
`fda080a373e8226f3fd60635323f5da9af9892b1`; it was not an unexplained operator-supplied key.
The new explicit `setup --approved-jobspy` command reproduces that configuration and saves
it to the selected ignored local vars file. A routine search never downloads it again.
This does not establish provider partnership rights, indefinite validity or public-use permission.

Live CLI test against the built Worker: 25 Dutch rows, 12 previously known, 2 new jobs saved
(one pass, one review), using a persisted app session and no readiness request. The earlier
integrated test already verified both NL and CH. Fresh dev synthetic-account acceptance
passed for guessed IDs, ordinary-user denial, demotion, private/public duplicate separation,
feedback/export visibility, saved/applied/dismissed preservation and reset isolation.
The developer verifier is separate from the module and must never be a prerequisite to search.

The historical sections below describe the previous checkpoint. In particular, the statements
that provenance is unknown and `INDEED_TESTING.md` is absent are superseded by this section.

This file replaces `INDEED_WIP_HANDOVER.md` (2026-09-20), four of whose six load-bearing claims had
become false. It was the first thing anyone picked up the work would read, and it would have
sent them to fix a closed vulnerability and to set the language normalization baseline four
versions backwards — a downgrade that same document warned was dangerous. If you are reading
this to continue the work, start here and treat anything older as history.

## What is true now

**The integration is on `master`.** The commit titled "WIP … DO NOT MERGE" (`1159df5`) is an
ancestor of `master`. Nothing is waiting to be merged.

**Retrieval works, and was proved live on 2026-09-21.** Two requests returned 25 rows each;
27 advertisements were stored after filtering, 14 Swiss and 13 Dutch. No phone was involved,
which settles the phone-dependency question the acceptance list asks about: the transport
needs no device.

**The retrieved data is the best-quality of any source in this app.**

| | Indeed, 27 advertisements | For comparison |
|---|---|---|
| Description length | 2,692–8,200 chars, mean 5,115 | EURES NL arrives cut at ~2,000; Job-Room previews fall under 900 |
| Missing posting date | 0 | #88 had 193 of 193 dateless |
| Missing company | 0 | most cards elsewhere read "Company not added" |
| Truncation markers | 0 of 27 | EURES NL ads end in "..." |

Every one of the 27 ends on a real document boundary — equal-opportunity boilerplate, a
privacy statement, a reference code, a recruiter's address. **No teaser appeared in the
sample.**

## Superseded — do not act on these

These were open questions in the previous handover and are now settled. They are listed so
nobody re-opens them.

- *"Do not merge this WIP as-is."* It is merged. See above.
- *"Language normalization is version 7; this draft changes baseline 5 to 6; NEVER downgrade."*
  `NORMALIZATION_VERSION` is **10**. The rule is still right: never lower it.
- *"Check migration 18 remains free."* Runtime migrations run to **24**.
- *"P1, still NOT fixed: `app/api/feedback/route.ts` exports all corrections without filtering
  private sources, so a demoted administrator can read back Indeed rows."* **Fixed.** The
  export now joins on `j.user_id = f.user_id` and excludes administrator-only sources in SQL
  before the `LIMIT`, matching `/api/state`. There is a test for it.

## The language rule, and why it changed

`languageForIndeed` used to force `unknown` on everything the shared gate did not block. The
effect was an asymmetry nothing justified: the app trusted Indeed's text enough to **reject** a
job on it — 8 of the 27 were correctly excluded as Dutch, German or French, each with a
specific reason — while never trusting it enough to **accept** one. No Indeed job could reach
the matches list whatever it said, so the one source delivering complete advertisements was
the only one forbidden from confirming they were in English.

It now defers to the same gate as every other source. That gate already withholds a pass from
text it cannot vouch for: under `MIN_CHARS_TO_CONFIRM_ENGLISH` (900) characters, or ending in
an ellipsis, it returns `unknown` by itself — protection written for the truncated EURES ads
and applying here unchanged. Indeed adds exactly one check the shared gate has no reason to
carry: a teaser ending in a "read more" link rather than an ellipsis, tested against the tail
only, because "read more about our benefits" is ordinary copy mid-advertisement.

Verified behaviour, pinned by tests in `tests/indeed-integration.test.ts`:

| Advertisement | Verdict |
|---|---|
| Complete, English | `pass` |
| "Dutch is a plus" | `review` |
| "Dutch is required" | `blocked` |
| Ends with "Read more" | `unknown` |
| Ends with "..." | `unknown` |
| Under 900 characters | `unknown` |

`NORMALIZATION_VERSION` moved 9 → 10 so stored rows are re-screened on read.

## What still blocks this being finished

**A credential, and it is the owner's decision.** No key exists anywhere on disk — that is
deliberate, and `.env.acceptance-unused` is an intentionally empty placeholder saying so. The
live run took its values from the operator's shell. Consequences:

- `INDEED_API_KEY` and `INDEED_APP_INFO` are empty in `.dev.vars.dev` and `.dev.vars.test`, so
  both environments report `not configured` and send no requests. This is why Indeed appears
  to do nothing there.
- The live result is not reproducible without the operator supplying those values again.
- **The provenance of that credential is not recorded anywhere, and should be before anyone
  calls this complete.** Note what the transport implies: a static 64-hex key plus an
  `indeed-app-info` header against `apis.indeed.com/graphql`, working from any machine with no
  device enrolment. Whether that is a credential the project is entitled to use is a question
  for the owner, and #69 is the place to record the answer.

**The rest of the #69 acceptance list.** Not yet done: two independent normal accounts, guessed
IDs, exports, denied administrator operations, disable/disconnect, and 401/403/429 stop
behaviour simulated rather than provoked. All of it is testable with fixtures against real D1 —
**no credential needed**.

**`docs/INDEED_TESTING.md` does not exist** and the acceptance list requires it: setup,
credential renewal and disconnect, request caps, troubleshooting.

## Where the evidence lives

The 27 retrieved advertisements are in the worktree
`ajh-indeed-acceptance-followup-20260921-180342-938897`, under
`.wrangler/indeed-live/state/v3/d1/`. **Worktrees get cleaned up.** If that data matters to
you, copy it somewhere durable before it disappears — every measurement in this document came
from it, and re-obtaining it needs the credential again.
