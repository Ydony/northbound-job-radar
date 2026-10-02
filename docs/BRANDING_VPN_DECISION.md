# Branding and optional-VPN decision note (F9 / T27)

Deferred decision unit for feature F9 ("Reconsider extra sources, notifications and
branding"). This note preserves two wanted possibilities — separate branding work and
optional VPN use — without delaying the current release and without moving the
no-evasion boundary. It decides nothing into implementation: each idea becomes real
work only as a separately approved implementation feature. No plugin/provider purchase
or integration follows automatically from this note.

Status: proposed. Owner decision recorded below; implementation approval is separate.

## 1. Separate branding

**Benefit.** Product identity is already settled and costs nothing to keep: on
2026-08-31 the owner renamed the product to match the registered domain
(**Ik ben een appel**, `docs/TASKS.md` B7). Required third-party attribution is already
implemented where permission terms demand it: ELA acknowledgement for EURES (#33) and
the private research acknowledgement for Adzuna (#30). Keeping branding as its own
later item means any future rename, logo, or attribution change is reviewed on its own
merits instead of riding along with source or hosting work.

**Permission / cost / privacy assessment.** Our own name and the owner's domain need no
third-party permission and cost nothing beyond the domain the owner already holds. Third-party
marks are different: Adzuna's listing-publishing permission requires a "Jobs by Adzuna"
logo at least 116 x 23 pixels, and EURES re-use requires ELA acknowledgement
(`docs/SOURCE_POLICY.md` §3–4). A rebrand is cheap in assets but expensive in churn
(interface titles, package name, outbound `User-Agent`, environment variables, docs —
B7 touched 25 files). Privacy constraint: branding changes must never leak
administrator-only source names, counts, or run history into public UI; the
public/admin isolation rule applies to logos, credits, and footers as much as to job
cards (`docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` §2).

**Owner decision.** Keep the current name, tagline, and owner-domain hosting direction:
use the owner's domain, with no ChatGPT branding or login, and introduce no new
branding without a separate approval (`docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` §1).
Adzuna's public-listing logo rule is not triggered while Adzuna stays
administrator-only; the private research acknowledgement stays as documented. Any future
rebrand, logo, or attribution change is a separately approved implementation feature
with its own permission check and `/sources` + `/privacy` update in the same change.

## 2. Optional VPN

**Benefit.** An optional, user-visible privacy layer for local administrator searches:
it keeps the owner's home IP off the restricted page-fetching sources (three JobCloud
sites plus precautionary Undutchables) that produced the 12 measured English-confirmed
leads retained under #32. Ordinary public-source search never needs it, and most
administrator work (IamExpat) explicitly needs no VPN.

**Permission / cost / privacy assessment.** A VPN changes the visible source IP; it
does not override a job site's terms and does not authorize scraping, automated login,
or application submission (`docs/VPN.md` Boundaries). The three JobCloud adapters run
knowingly against the platform terms at the owner's explicit instruction and stay
administrator-only, manually triggered, unauthenticated, fixed-delay, and capped
(`docs/SOURCE_POLICY.md` §3). Cost is zero on the supported free tiers (Windscribe Free
with NL/CH locations; Proton VPN Free with automatic exit). Privacy: the VPN provider
carries the traffic instead of the home ISP — this is IP shielding, not an anonymity
guarantee. The app never requests or stores VPN credentials; setup uses the provider's
own official client and user-visible sign-in. Free public HTTP/SOCKS proxies are
forbidden (their operators can observe or modify traffic), browser extensions do not
cover server-side requests, and split tunnelling without a full IPv4 route fails the
launcher check by design.

**Owner decision.** VPN use stays optional and local-administrator-only. The normal
search runs without it; only **Search all — VPN on** requires the enforced launcher
(`npm run dev:private`), which refuses to start without a supported active adapter
carrying a full tunnel route. Caps stay fixed: the VPN is not a reason to raise per-run
limits or chase volume. Any change — requiring VPN for more sources, adding a provider,
paying for a plan, or routing hosted collection through a tunnel — is a separately
approved implementation feature. No purchase or integration follows from this note.

## 3. No-evasion boundary (unchanged, applies to both ideas and all sources)

Neither branding nor VPN work may add, buy, or commission detection evasion:

- no randomized or human-imitating timing;
- no fingerprint spoofing;
- no headless-browser stealth plugins or browser fallback to get around a block;
- no proxy rotation, IP cycling, or public proxies;
- no retries, alternate endpoints, or browsers to get around a refusal — a block is a
  stop signal (`docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` §1, `docs/SOURCE_POLICY.md` §3,
  `docs/VPN.md` Boundaries);
- no automated source-site login or application submission;
- no scheduled/unattended fetching under this note (search stays manually triggered).

This boundary is pinned by `tests/collection-budgets.test.ts` (no evasion machinery in
the scrape route), `tests/job-adapters.test.ts` (restricted sites stay behind the VPN
mode), and `tests/admin-discovery-isolation.test.ts` (restricted sources stay
administrator-only), plus the pinning test added with this note.

## 4. What this note does not do

- It does not approve, purchase, or integrate any plugin, provider, plan, or adapter.
- It does not change runtime behavior, caps, schedules, access controls, or hosting.
  Code, `/sources`, and `/privacy` are untouched by this note because data handling is
  unchanged.
- Sibling F9 ideas (Jooble, authorized alerts/digests, parked Apify question) are
  decided in their own notes, not here.

References: `docs/VPN.md`, `docs/SOURCE_POLICY.md` §§3–4,
`docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md` §§1–2, `docs/TASKS.md` B7/E11,
`docs/ROADMAP.md` Phase 5 (authorized alerts only).
