# Board discovery via Common Crawl (`scripts/discover-boards.mjs`)

Replaces the CC BY-NC 4.0 lead list used in #56 with discovery we own, so adding
employers never depends on someone else's licence (#59, parent decision #54).

## What it does

1. Reads `https://index.commoncrawl.org/collinfo.json` and uses the newest two crawls
   (no hardcoded crawl id).
2. Queries the public Common Crawl CDX index for one URL pattern per supported board
   system (`boards.greenhouse.io/*`, `job-boards.greenhouse.io/*`, `jobs.ashbyhq.com/*`,
   `jobs.lever.co/*`, `*.recruitee.com`, `*.jobs.personio.de`, `*.teamtailor.com`, `apply.workable.com/*`) and
   extracts the company identifier (first path segment for Greenhouse/Lever/Ashby,
   subdomain for Recruitee/Personio/Teamtailor, first path segment for Workable),
   deduplicated.
3. Verifies each candidate against that employer's own public feed (same URL shapes as
   `lib/ats-feeds.ts` `feedUrl`). A board is kept only if the feed answers, holds at
   least one posting located in the Netherlands or Switzerland, and that posting carries
   at least 900 characters of text.
4. Writes survivors to `scripts/output/discovered-boards.csv` (git-ignored) with
   `platform, slug, suggested name, country, postings in NL/CH, example job URL`, and
   prints a summary: candidates per platform, verified, rejected and why.

## Usage

```bash
node scripts/discover-boards.mjs --help
node scripts/discover-boards.mjs --index-only --max-pages 1   # quick candidate check
node scripts/discover-boards.mjs --platform ashby --max-verify 20
node scripts/discover-boards.mjs --candidate greenhouse:adyen --candidate ashby:mollie
node scripts/discover-boards.mjs                               # full run
```

`--candidate platform:slug` skips the index and verifies explicit boards — useful for
smoke tests and hand-found leads. Boards already listed in `lib/ats-feeds.ts` are excluded by default
(`--include-known` keeps them). `--max-verify 0` (default) verifies every candidate;
use a small `--max-verify` for smoke tests.

## Rules the script keeps

- New files only: it never edits the employer list, never modifies anything outside
  `scripts/`, and never runs inside a search request. The CSV is leads for a human to
  verify before any employer is added.
- Polite: at most 4 requests in flight, a pause between requests, a User-Agent naming
  the tool, per-request timeouts. Public indexes and public feeds only — no logins, no
  HTML job-page scraping, no detection evasion.
- One bad board or index page never stops the run; failures are counted in the summary.

## Known limits

**Lever.** Common Crawl does not crawl `jobs.lever.co`, so Lever coverage from this
route is near zero. An empty Lever result means the index has nothing to offer, not that
no Lever boards exist — never read the output as a complete list. The script header says
the same.

**The index half is not yet proven against live data.** On 2026-09-20 every request to
`index.commoncrawl.org` returned 502 or 504, so no candidate has ever come out of the
index here. The script treats that correctly — the failures are counted as index
warnings and the run finishes — but read a zero-candidate run as "the index did not
answer" until a run has actually returned candidates. The verification half is proven:
`--candidate greenhouse:adyen` returns 64 Netherlands postings and writes the CSV.

**Workable.** Discovery covers Workable, but no live Workable board with Netherlands or
Switzerland postings has been found — every account probed on 2026-09-20 answered with
an empty `jobs` array, which is why `lib/ats-feeds.ts` still lists no Workable employer.
Its parse branch mirrors the app parser covered by `tests/ats-feeds.test.ts` and is
checked against the same synthetic shape, not against a live board.
