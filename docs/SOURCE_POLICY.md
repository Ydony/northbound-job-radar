# Source policy: what may be shown publicly, and what is administrator-only

Verified 2026-09-07 by fetching each source's own published terms, not by inference. This is the
authoritative split. Where this document and an older one disagree, this one is current — see
§6 for the specific corrections.

It supersedes the EURES row in `PUBLIC_ADMIN_INTEGRATION_PLAN.md`, which was written on a reading
of "EURES partner" that the source pages do not support. The plan's *caution* about EURES was
sound; its stated reason was not, and the real reason is different and more useful.

---

## 1. The rule that decides everything

Two separate questions, and conflating them is how this gets wrong:

| | Question | Governed by |
|---|---|---|
| **Access** | May we *read* this source at all? | robots.txt, terms of use, API licence, whether an access control is being worked around |
| **Redisplay** | May we *republish what we read* to the public? | Who owns the text — and job advertisement text is written by the **employer**, not by the source |

A source can be perfectly legal to read and still not be ours to republish. That is the single most
important thing in this document, and it applies to every public source, not just EURES.

**The consequence, and it is a design rule, not a caveat:**

> The public tier shows **facts and our own work** — job title, employer, place, date, source name,
> our language verdict and our own extracted requirement bullets — plus a link to the original
> advertisement. It does **not** republish the employer's full advertisement text.

The full text is still fetched and still screened. It is used server-side to decide the language
verdict, then it is not the public tier's to hand out. Administrators, working on their own
private data, are unaffected.

This is not a compromise forced on us. A person deciding whether to apply needs the title, the
employer, the place, and whether English is enough — which is the entire product. The full text is
one click away on a page the employer chose to publish it on.

---

## 2. Public sources

| Source | Basis | Conditions that must be implemented |
|---|---|---|
| **EURES CH/NL** | Public endpoint (`/public/` in the path), `robots.txt` does not disallow `/eures/`, and the EURES legal notice states plainly: *"Re-use is authorised, provided that ELA is acknowledged as the source of the material."* | **Attribution to the European Labour Authority (ELA) is mandatory** and is currently not implemented — see §4. Metadata + link only, per §1. |
| **Job-Room (arbeit.swiss)** | Official Swiss public employment service. Unauthenticated public search and detail API, no key. Owner-assumed permission recorded separately. | Metadata + link only. Keep the per-advertisement detail fetch paced and capped as it is now. |
| **Employer ATS boards** (Greenhouse, Lever, Ashby, Recruitee, Personio) | Endpoints the platforms publish specifically so aggregators can consume them. | Metadata + link only. The employer publishes the board; the text is still theirs. |

### Why EURES is public here and admin-only in the older plan

The plan asserted that *"specific vacancy terms restrict extraction to recognized partners."*
I could not find that restriction. Checked directly:

- `eures.europa.eu/legal-notice_en` — no vacancy-specific terms at all; the reuse sentence quoted
  above is the whole of it.
- `how-become-eures-partner-member_en` — "EURES partner" and "EURES member" are statuses for
  **employment-services organisations** that transmit vacancies into the portal and advise
  jobseekers. It is a membership scheme for institutions, not an access tier for data.
- The EURES portal footer — legal notice, privacy, cookies, accessibility. No separate vacancy or
  API terms document exists.

So the barrier the plan described is not there. The barrier that *is* there is the one in §1, and
it comes from the Commission's own reuse policy: the CC BY 4.0 licence covers **content owned by
the EU**, and states that *"you may be required to clear additional rights if a specific content
… includes third-party works"* and that to reproduce content not owned by the EU *"you may need to
seek permission directly from the rightholders."* An employer's advertisement is a third-party work
sitting inside an EU-operated portal. Reading it is fine. Republishing it wholesale is not covered.

---

## 3. Administrator-only sources

Not offered to ordinary accounts, enforced server-side in both the jobs read path and the search
path. `adminOnly` is deliberately separate from `access: 'restricted'`: the first is about who may
use a source, the second additionally requires the VPN launcher.

| Source | Why |
|---|---|
| **Adzuna CH/NL** | **Decision 2026-09-09 (#30): retained for administrator measurement, removed from the public tier.** Its current API terms permit publishing listings and personal research, with default limits of 25 requests/minute and 250/day. Adverts displayed under the listing-publishing permission require “Jobs by Adzuna” branding at least 116 × 23 pixels; research publication must name “The Adzuna API” and link to the relevant local domain. The standard search response caps descriptions at 500 characters and has produced 351 stored jobs with zero English-confirmed results. Adzuna advertises full job details as a separate data service, while its API terms require queries to be directed through Adzuna and treat attempts to contact third-party content providers as a breach. Therefore the app does not fetch full text through `redirect_url`. Ordinary accounts do not search Adzuna and cannot receive its existing `adzuna.ch` / `adzuna.nl` jobs or run rows. Administrators retain it in the conversion report, with a private research acknowledgement and local-domain links. No stored detector verdict is rewritten by this change. [Current API terms](https://developer.adzuna.com/docs/terms_of_service) · [API offering](https://developer.adzuna.com/) |
| **Careerjet CH/NL** | Licensed to one declared IP address. Workable for the owner, not offerable as a feature. Also produces 279-character teasers, so it cannot support a `pass` regardless. |
| **IamExpat** | Read from public pages rather than an API. No access control is worked around, but there is no published permission either — `grey-area` is the honest label. |
| **jobs.ch, jobup.ch, JobScout24, Undutchables** | Terms prohibit automated access. Page-fetching, VPN-gated, hard caps, administrator only. Do not raise the caps to hit a volume target. |
| **Indeed CH/NL** | Returns HTTP 403 and prohibits automated access without written permission. Assigning it to admin does not make it usable. |
| **Nationale Vacaturebank** | HTTP 403. |
| **I amsterdam** | A city guide, not a vacancy feed. |
| **eurojobs.com** | **Refuses us by name.** `robots.txt` carries `User-agent: ClaudeBot / Disallow: /` alongside GPTBot and CCBot, plus `Content-Signal: ai-train=no` and an express Article 4 reservation under EU Directive 2019/790. Not to be revisited without written permission from the operator. |

Administrator-only source names, counts, run records and links must not appear in any public
response — including for jobs stored before a source was reclassified. This is already enforced and
verified end to end with a real second account; keep it that way.

---

## 4. What must be built before anything is public

- [x] **ELA attribution for EURES.** Done 2026-09-08 (#33). The credit renders under the job list
      when the list contains EURES jobs, and `/sources` carries a "Required attribution" section.
      `lib/attribution.ts` holds the wording and the source keys, with a test that fails if a
      EURES adapter is ever added that the rule does not cover.
- [x] **Verify Adzuna's current attribution wording.** Done 2026-09-09 (#30). The standard API's
      teasers cannot support the language evidence gate, and permission to copy full text through
      third-party redirect targets is not supplied. Adzuna is therefore administrator-only. Its
      private research view names “The Adzuna API” and links to the relevant Swiss/Dutch domain;
      public users never receive an Adzuna advert, so the public-listing logo rule is not triggered.
- [x] **Stop returning full descriptions to the public tier.** Done 2026-09-08 (#34). `JobRecord`
      no longer carries `description`; `descriptionLength`, `requirements` and `matchesCriteria`
      replace it, and keyword matching moved server-side, which resolved B4 as predicted.
      `tests/job-payload.test.ts` serialises a real row through `jobFromRow` and asserts a phrase
      unique to the advertisement appears nowhere in the result.
- [x] **`/sources`** states the split and the attribution. Done 2026-09-08 (#33) — it also gained a
      EURES entry, which it had never had despite EURES being the largest source of usable jobs.
- [x] **`/privacy`** re-read and corrected 2026-09-08. It was telling a stranger their CV is stored
      and read to score jobs, months after CV matching was shelved, and listing location and
      filters as search settings that no longer exist. The CV disclosures are now gated on
      `CV_MATCHING_ENABLED` rather than deleted, so they return with the feature.
      `tests/privacy-policy.test.ts` enforces it.

---

## 5. Sources with no verdict yet

Do not enable these until someone has read their terms and recorded the answer here.

| Source | Status |
|---|---|
| **FreeHire** | Proposed first new integration. Its terms are ambiguous on public redisplay: they prohibit *"scraping beyond our documented API"* — which permits documented API use — but say nothing about redistributing results to end users. Ask them directly before launch. |
| **Jooble** | Advertises publisher use on third-party sites, needs a key. Measure description completeness first: if it returns snippets like Adzuna and Careerjet, it adds `unknown` rows rather than usable jobs. |
| **UWV / werk.nl** | Permission assumed by the owner; no retrieval interface exists. Assumed permission does not supply an endpoint. |
| **OpenPostings** | No licence found in the repository. Reference only. |

---

## 6. Corrections to older documents

These were checked individually against the code and the live sources.

| Document | Claim | Status |
|---|---|---|
| `SOURCES_PIPELINE.md`, `lib/eures.ts` | EURES content is CC BY 4.0 | **Incomplete rather than wrong.** True for EU-owned content; it does not extend to employer advertisement text. Corrected in place. |
| `PUBLIC_ADMIN_INTEGRATION_PLAN.md` | EURES restricted to recognized partners | **Not supported by the cited sources.** Superseded by §2. |
| `ARCHITECTURE.md` | Job-Room is unavailable | **Stale.** It is a working full-text source and has been since 31 August. |
| `ARCHITECTURE.md` | Four `drizzle/*.sql` migrations describe the schema | **Stale.** Drizzle was removed entirely; `schemaStatements` plus `runtimeMigrations` is the only schema description. |
| `MVP.md`, `ACCEPTANCE_TEST.md` | Rate limiting resets with the process | **Stale.** Durable since 1 September, verified across a worker restart. `MVP.md` contradicted itself — one table said done, another still listed it open. |
