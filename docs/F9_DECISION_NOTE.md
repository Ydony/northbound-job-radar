# F9 decision note: Jooble, Apify, authorized alerts, branding, VPN (T26)

Written 2026-10-01. Status: **deferred decision record, not an approval.**
This note preserves the five F9 ideas with a short benefit and a
permission/cost/privacy assessment each, and records that **no owner
decision has been made on any of them**. Only separately approved
implementation features may follow; no plugin/provider purchase,
account, key, or integration follows from this note automatically.

Scope of this task (T26, follows T23): **public-only paperwork.**
No accounts were created, no API keys were obtained, no collection was
run, and no adapter, schedule, or branding was added or changed. All
evidence below is restated from already-published in-repo sources and
public documentation links already recorded there — nothing was fetched
fresh for this note.

## 1. Jooble CH/NL — deferred, owner action first

- **Benefit if it works:** an official publisher API that advertises
  displaying results on third-party websites, covering CH/NL vacancies
  the current public tier (EURES, Job-Room, ATS boards) might miss.
- **Permission:** legitimate front door — a registered publisher key
  used as documented. The direct web routes sit behind bot protection
  and must not be worked around; the API key is the only route.
  Redisplay conditions in Jooble's publisher terms must be read and
  recorded before any public use (cf. `docs/SOURCE_POLICY.md` §1: ad
  text is employer-owned, so metadata + link only unless the licence
  says otherwise).
- **Cost:** free publisher key tier exists (quotas to be confirmed at
  registration); integration cost only if the yield test passes.
- **Privacy:** keyed server-side calls only; no jobseeker data goes to
  Jooble. If promoted, record retention/attribution conditions the same
  way Adzuna's were (`docs/SOURCE_POLICY.md` §3–§4).
- **Quality gate (unchanged, from `docs/TASKS.md` E9):** after the owner
  registers a key, one call measuring the median description length
  decides — median ≥ 1500 chars makes an adapter worth proposing;
  teaser-length snippets mean do not add it (more unscreenable volume
  repeats the Adzuna/Careerjet failure). No key was registered in this
  task, so the measurement is still outstanding.
- **Decision:** DEFERRED. Owner TODO: register the key and run the
  ten-minute measurement, or explicitly decline.

## 2. Apify EU Jobs Scraper — parked, owner to revisit

- **Benefit if it works:** off-the-shelf actors for vacancy
  collection without building site-specific adapters.
- **Permission:** Apify is collection software, not a grant of rights
  to source data. An actor whose function is circumventing anti-scraping
  walls is declined on the project's standing no-evasion rule
  (`AGENTS.md`, `docs/TASKS.md` E11) — commissioning evasion from a
  third party is the same act as doing it here. Buildable only: a
  specific actor that reads *documented public endpoints*, i.e. an
  ordinary API client with a billing layer in front, evaluated on
  description length like any other source.
- **Cost:** paid middleman for data largely already obtained free and
  full-text from EURES (287,000 NL/CH jobs); every aggregator measured
  so far returns teasers, so the likely outcome is paying for more jobs
  that still cannot be screened. No purchase, trial, or actor run was
  started in this task.
- **Privacy:** any future actor needs a processor check (what vacancy
  and query data transits Apify) before use.
- **Decision:** PARKED by the owner 2026-08-31 alongside E9. Revisit
  only with a named actor and what it calls.

## 3. Authorized alerts/digests — deferred until scheduled refresh exists

- **Benefit if it works:** user-configured daily/weekly digests of new,
  deduplicated, English-sufficient matches (`docs/ROADMAP.md` Phase 5).
- **Permission:** recurring discovery ONLY for sources that authorize
  scheduled collection. Restricted/admin discovery stays manually
  triggered; no schedule is installed by this note. Depends on the
  bounded public refresh (INT-06) existing first.
- **Cost:** collection budgets per refresh window plus a sending
  mechanism; measure at sample size before choosing frequency
  (`docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` §7).
- **Privacy:** email delivery needs a provider with a documented
  retention policy and processor agreement, plus DPIA/GDPR review
  (`docs/ROADMAP.md` platform requirements); quiet hours, digest size,
  and per-user consent are part of the design, not afterthoughts.
- **Decision:** DEFERRED. No alert, digest, cron, or email wiring was
  added in this task.

## 4. Branding — no new branding

- **Benefit of restraint:** the product promise is English-sufficiency
  screening, not presentation; required attributions (ELA for EURES,
  "The Adzuna API" + local-domain links for private research) already
  render where due.
- **Permission/cost/privacy:** publisher listing terms can *require*
  branding (e.g. Adzuna's 116×23 logo rule for public listings) — that
  is a compliance obligation to implement if such a source ever goes
  public, not a design choice. No ChatGPT branding or login; hosting
  uses the owner's domain when that future decision is made.
- **Decision:** NO NEW BRANDING. Keep only attributions the source
  terms require.

## 5. VPN — keep the optional local administrator launcher as-is

- **Benefit:** the enforced launcher (`docs/VPN.md`,
  `docs/ARCHITECTURE.md` §9) keeps restricted admin page-fetching off
  the owner's home address; it supported the 12 measured
  English-confirmed private leads.
- **Permission:** a VPN is an exposure reducer, NOT permission to
  automate and not a reason to raise caps — the JobCloud adapters stay
  knowingly contrary to current terms, manually triggered, capped, and
  administrator-only regardless of tunnel state.
- **Cost/privacy:** provider-supported user-visible sign-in only; no
  credentials, tunnel keys, or automation of VPN settings in the
  project. Never a public deployment path.
- **Decision:** NO CHANGE. Revisit a gated source only on the stop
  signals in `docs/SOURCE_POLICY.md` §3 (no yield, repeated failure,
  rule change, complaint/block — a block stops, never escalates).

## What this note does not do

- It creates no accounts, obtains no keys, runs no collection, and
  changes no adapter, schedule, attribution, or style.
- It approves no implementation: Jooble measurement (INT-10), any
  Apify actor evaluation, alerts (Phase 5 / C5), branding, and VPN
  changes each need a separate owner decision and task.
- Registry proof: `lib/job-adapters.ts` contains no Jooble or Apify
  adapter (only the deliberate no-entry comment in
  `lib/source-policy.ts`); pinned by `tests/f9-decision-note.test.ts`.
