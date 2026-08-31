# How each source is processed and filtered

Measured 2026-08-31 against the 1,023 jobs in the test workspace, plus live probes of EURES and
Job-Room. Written to answer one question: **for each source, can we trust it when it says a job is
English-only?**

---

## The pipeline, in order

Every job goes through the same six stages. Only stage 2 differs by source, and that difference
turns out to decide everything else.

| # | Stage | What happens | Where |
|---|---|---|---|
| 1 | **Discover** | Query each source for role keywords + country | `lib/job-adapters.ts` |
| 2 | **Retrieve text** | Get the advertisement body — **the stage that varies** | per-source adapter |
| 3 | **Normalise** | Decode HTML entities, flatten HTML while keeping list structure | `lib/jobsch.ts` |
| 4 | **Screen language** | Phrase rules → not-English check → mention check | `lib/language-rules.ts`, `lib/analysis.ts` |
| 5 | **Score fit** | Keyword overlap against each CV | `lib/analysis.ts` |
| 6 | **Deduplicate** | Cluster key, then location + 4-day comparison | `lib/job-identity.ts` |

### Stage 4 in detail

Strictest first; the first match wins.

1. **Phrase rule matched** → `blocked`. A cue next to a language name: "fluent in German",
   "Deutsch: C2", "Dutch is mandatory". 91 cues that precede a language, 62 that follow, across 57
   spellings in 5 languages. Compiled once into 7 bounded regular expressions — 1,004 jobs screen
   in 49 ms.
2. **Language named in the job title** → `blocked`. A headline is not prose; it names what the role
   is.
3. **Advertisement is not predominantly English** → `blocked`.
4. **A local language is named at all** → `review`, even when the text calls it optional.
5. **Not enough text to tell** → `review`.
6. **Otherwise** → `pass`.

Two rules stop the phrase matcher going wrong, both forced out by real ads:

- The gap between a cue and a language **may not cross another language name**. Otherwise "German
  preferred and French fluency" matches as one span, the optional cue for German silences it, and
  French — the language actually required — is swallowed and never examined.
- The gap **may cross a colon**. "Sprachen: Deutsch: C2" is the clearest hard bar an advertisement
  has, and excluding the colon missed every one of them.

---

## Per-source results

`full%` is the share of ads long enough to screen (≥1500 characters). **`trustworthy pass`** is the
share of "English sufficient" verdicts that were based on a full advertisement rather than a
preview — the only column that really matters.

| Source | Jobs | Median chars | full% | pass | review | blocked | trustworthy pass |
|---|---|---|---|---|---|---|---|
| **EURES Switzerland** | 41,896 available | 3,191 | **95%** | 12% | 11% | 77% | **~100%** |
| **EURES Netherlands** | 245,007 available | 1,955 | **91%** | 18% | 6% | 76% | **~100%** |
| Greenhouse boards | 20 | 5,326 | 100% | 19 | 1 | 0 | **100%** |
| jobs.ch | 62 | 3,173 | 97% | 3 | 7 | 52 | **100%** |
| jobup.ch | 27 | 2,734 | 96% | 6 | 2 | 19 | **100%** |
| IamExpat | 4 | 2,512 | 100% | 1 | 0 | 3 | **100%** |
| Undutchables | 3 | 1,816 | 67% | 2 | 0 | 1 | 50% |
| Job-Room *(before full-text fetch)* | 246 | 278 | 0% | 0 | 238 | 8 | — |
| Careerjet (jobviewtrack) | 213 | 245 | 0% | 0 | 209 | 4 | — |
| **adzuna.ch** | 180 | 500 | 0% | 82 | 15 | 83 | **0 of 82** |
| **adzuna.nl** | 167 | 500 | 0% | 66 | 21 | 80 | **0 of 66** |

### Reading that table

**Adzuna is the problem.** It produced 148 "English sufficient" verdicts and **not one of them was
based on a full advertisement.** Its API caps descriptions at exactly 500 characters, and a
language requirement lives near the end of an ad, in the "Ihr Profil" section — past the cut. The
filter reported "no requirement found" because it was never shown the part that has one. That is
the single reason for opening a promising job and discovering it needs French.

**Careerjet is worse but at least honest.** Capped at 279 characters, it produced zero passes —
everything landed in review, which is the correct response to having no evidence.

**Job-Room was in the same state until this week.** Its search endpoint returns a preview, but its
detail endpoint returns the whole ad: 316 characters against 4,193 for the same job. Now fetched in
full. On a live test of 20 ads, **18 changed verdict** once the whole text was read — 12 turned out
to require German or French, 6 were confirmed English-only and released from review.

**EURES changes the picture entirely.** Full advertisements in the search response, no per-job
fetching needed, and 287,000 jobs across both countries against the 1,023 currently stored.

---

## A trap in the EURES metadata

The EURES portal shows **"Working languages: Dutch"** on Netherlands listings, and it is not a
requirement. The underlying field (`availableLanguages`) records which translations of the
advertisement exist.

Measured on 50 live Netherlands listings:

- **50 of 50** carried `["nl"]` — it is set on everything, so it distinguishes nothing.
- **22 of them (44%)** contain no Dutch requirement anywhere in the advertisement text.

One of those is a full 1,955-character ad titled *Data Analyst Operations* that never uses the word
"Dutch" at all, and screens as English-confirmed. Trusting the portal's label would have thrown it
away along with almost half the Dutch results.

The field is carried through as `adLanguages` for display and debugging, and never reaches the
language gate. `tests/eures.test.ts` exists to keep it that way.

## Access tiers

| Tier | Meaning | Sources |
|---|---|---|
| `authorized-api` | Public or licensed API, used as intended | EURES ×2, Job-Room, Adzuna ×2, Careerjet, Greenhouse/Lever/Recruitee/Ashby/Personio boards |
| `grey-area` | Public pages, no access control worked around | IamExpat |
| `restricted` | Page-fetching; administrator only, VPN required, hidden from other accounts | jobs.ch, jobup.ch, Indeed, and others |

EURES has the strongest footing of anything here: the endpoint path is literally `/public/`,
`robots.txt` does not disallow `/eures/`, and europa.eu content is **CC BY 4.0** under the
Commission's reuse decision of 12 December 2011. The portal exists so people can find work in
another member state.

---

## What this says to do next

1. **Lean on EURES.** It is free, legitimate, enormous, and — uniquely among the bulk sources —
   complete enough to screen. It also aggregates the national employment services, so it already
   covers UWV (`werk.nl`), which publishes no API of its own.
2. **Stop trusting Adzuna's passes.** Either fetch full text through its redirect link (a licensing
   question, not a technical one) or reclassify its short ads as *unknown* rather than *pass*.
   Right now 148 verdicts claim more than the evidence supports.
3. **Split `pass` into "confirmed" and "unknown".** A verdict of English-sufficient should be
   impossible on a truncated ad. This is the change that makes the good bucket trustworthy, and it
   is independent of any source work.
4. **Leave Careerjet alone.** 279-character teasers, and the API is IP-locked to a declared address
   that Cloudflare Workers cannot provide in production.

## Checked and rejected

- **`data.europa.eu`** — a catalogue of *datasets*, not job ads. The Dutch entries are CBS
  statistics counting vacancies, not the vacancies themselves.
- **`werk.nl` (UWV)** — no public API. Reached through EURES instead.
