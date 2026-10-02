/**
 * Transparency record for every source the app can read, plus the ones it deliberately does not.
 *
 * Each entry states what is collected, what the site's own published rules say, and an honest
 * assessment of where this app stands against them - including where it does not comply. Claims
 * here were checked against the live robots.txt or terms on `verifiedOn`; re-check before relying
 * on them, because sites change their rules without notice.
 */
export type PolicyStance = 'intended-use' | 'permitted' | 'unresolved' | 'against-terms' | 'not-used';

export interface SourcePolicy {
  name: string;
  group: 'Authorized APIs' | 'Open public pages' | 'Restricted sites' | 'Not used';
  stance: PolicyStance;
  /** Withhold this source's existence from ordinary accounts, matching the search and jobs APIs. */
  adminOnly?: boolean;
  collected: string;
  theirRules: string;
  ourPosition: string;
  link?: string;
}

export const POLICIES_VERIFIED_ON = '2026-08-28';

export const stanceLabel: Record<PolicyStance, string> = {
  'intended-use': 'Used as intended',
  permitted: 'Permitted with a key',
  unresolved: 'Open question',
  'against-terms': 'Against their terms',
  'not-used': 'Not used',
};

export const sourcePolicies: SourcePolicy[] = [
  {
    name: 'Company career boards (Greenhouse, Lever, Ashby, Recruitee, Personio)',
    group: 'Authorized APIs',
    stance: 'intended-use',
    collected: 'Public job postings from 282 verified employer boards across Greenhouse, Lever, Ashby, Recruitee and Personio: title, company, location, description, posting date. Each board was checked live before listing: it answered, held at least one Netherlands/Switzerland posting, and that posting was long enough (900+ characters) for the language gate to judge. The adapter additionally supports Teamtailor and Workable feeds, but no verified board currently uses them.',
    theirRules: 'These five platforms publish an open, unauthenticated job-board endpoint for each customer precisely so job boards and aggregators can read their vacancies. The adapter also reads Teamtailor, which documents a syndication feed on every career site it hosts, and Workable, which publishes the same kind of feed for each account it hosts — both are tested and supported, with no verified board currently configured on either.',
    ourPosition: 'This is the endpoint doing the job it exists for. No key, no login, no rate-limit conflict. Reading and republishing stay separate questions: the advertisement text is the employer’s, so it is screened server-side and never republished — you get the facts, our verdict, and a link. Teamtailor and Workable are adapter-supported but unused: zero of the 282 verified boards uses them. Workday is excluded: its endpoint is the careers page’s own data call, not a feed published for aggregators.',
    link: 'https://developers.greenhouse.io/job-board.html',
  },
  {
    name: 'EURES (Switzerland and Netherlands)',
    group: 'Authorized APIs',
    stance: 'intended-use',
    collected: 'Search results from the public EURES job-search endpoint: title, employer, place, posting date, link, and the advertisement text, which is read to decide the language verdict.',
    theirRules: "The endpoint is published under `/public/` and robots.txt does not disallow `/eures/`. The EURES legal notice states the condition in one sentence: “Re-use is authorised, provided that ELA is acknowledged as the source of the material.” The Commission’s CC BY 4.0 policy covers EU-owned content and says explicitly that reproducing third-party works inside it may need permission from the rightholder.",
    ourPosition: 'Used as published, and the European Labour Authority is credited wherever EURES vacancies appear. The advertisement text belongs to the employer rather than to the EU, so it is read to screen the language and is not republished — you get the facts, our verdict, and a link to the employer’s own page.',
    link: 'https://eures.europa.eu/legal-notice_en',
  },
  {
    name: 'Adzuna (Switzerland and Netherlands)',
    group: 'Authorized APIs',
    stance: 'permitted',
    adminOnly: true,
    collected: 'Search results for the saved role keywords: title, company, location, teaser description, salary range, link.',
    theirRules: 'Rechecked 2026-09-09. The API terms permit publishing Adzuna listings and personal research, with free limits of 25 requests per minute and 250 per day. Adverts displayed under the listing-publishing permission must carry “Jobs by Adzuna” branding; published research must name “The Adzuna API” and link to the relevant local site. The standard search API supplies teasers. Adzuna advertises full job details as a separate data service, and its terms require API queries to stay with Adzuna rather than third-party content providers.',
    ourPosition: 'The standard teaser is too short to confirm that English alone is enough, so Adzuna is retained only as an administrator coverage measure. Ordinary accounts neither search it nor receive its stored jobs or run rows. The app does not follow redirect links to copy third-party full text, changes no saved verdicts, and acknowledges The Adzuna API with links to the Swiss and Dutch sites in the private result view. On the hosted server it runs only with the API key configured, and reports unavailable without it.',
    link: 'https://developer.adzuna.com/docs/terms_of_service',
  },
  {
    name: 'Careerjet (Switzerland and Netherlands)',
    group: 'Authorized APIs',
    stance: 'unresolved',
    adminOnly: true,
    collected: 'Search results for the saved role keywords: title, company, location, teaser description, link.',
    theirRules: 'Careerjet issues a unique API key for each publisher website. Its current API documentation requires the real end-user IP and user agent on every query, and its examples require a Referer containing the page that triggered the request.',
    ourPosition: 'Retained for local administrators only as a discovery aid. It is disabled unless the key, registered site, Referer and real user details are correctly configured, and its credentials must stay unset in hosted environments, where the search reports it blocked. The current placeholder registration remains unresolved, so this is not a public feature or evidence that English is sufficient.',
    link: 'https://www.careerjet.com/partners/api/',
  },
  {
    name: 'Job-Room / arbeit.swiss',
    group: 'Authorized APIs',
    stance: 'unresolved',
    collected: 'Public Swiss vacancy records: title, employer, location, description, posting date, and the employer-declared language requirements.',
    theirRules: 'The official Swiss public employment service. Its own front end calls an unauthenticated public JSON search API. robots.txt disallows the /job-search/ page route under a comment reading "Do not crawl Job Adverts"; the API path itself is not listed.',
    ourPosition: 'The API path is not disallowed, and this is public-sector data published for job seekers, but that comment states an intent this use does not honour. Materially cleaner than scraping a commercial board, and still not an explicit permission: permission is an explicit owner assumption (INT-08, #167), recorded separately from evidence — an assumption is not a permission. Validated for public traffic (INT-08, #167): each search reads at most 6 pages of 100 previews per role keyword, stopping at the first short page, then re-reads at most 200 short previews in full at a fixed 400ms interval; searches are rate-limited per account. A 2026-09-24 probe from a non-local network was answered with a block page, so the adapter stops on any block rather than retrying.',
    link: 'https://www.job-room.ch/robots.txt',
  },
  {
    name: 'FreeHire (Switzerland and Netherlands)',
    group: 'Authorized APIs',
    stance: 'intended-use',
    collected: 'Full-description search results for the saved role keywords, restricted to seven reviewed employer-board upstreams (Greenhouse, Lever, Ashby, Recruitee, Personio, Teamtailor, Workable): title, company, location, description, posting date, link.',
    theirRules: 'Checked 2026-09-24. The terms permit documented API use and prohibit scraping beyond it; robots.txt and llms.txt point agents at exactly this full-description endpoint and ask for an identifying User-Agent. No display, caching or attribution conditions are stated; the advertisement text is aggregated from third parties. The terms say nothing about redistributing results to end users — that question is unresolved (#166).',
    ourPosition: 'Used as documented: unauthenticated, paced and capped, with an identifying User-Agent. Only the seven ATS platforms reviewed in §2 as published aggregator feeds are accepted; re-served aggregators (EURES, Adzuna, WhatJobs) and unreviewed boards are excluded by an explicit allowlist. Advertisement text is screened server-side and not republished — you get the facts, our verdict, and a link. Redistribution gate: direct confirmation of redistribution is still outstanding and must be asked for before launch (#166); until then this source is not counted as launched public coverage.',
    link: 'https://freehire.me/docs/api',
  },
  {
    name: 'jobs.ch',
    group: 'Restricted sites',
    stance: 'against-terms',
    collected: 'Search-result pages and job detail pages, read as HTML. The schema.org JobPosting block on each detail page is parsed.',
    theirRules: 'JobCloud\'s terms prohibit crawlers, scrapers, bots, scripting and other automation. robots.txt additionally disallows the job detail pages specifically - the exact pages this reads.',
    ourPosition: 'Retained for local administrators because its full advertisements have produced three English-confirmed jobs. Knowingly against both the terms and robots.txt, at the operator\'s explicit instruction. Manually triggered only, VPN-gated, capped per run, unauthenticated, with a fixed delay and no attempt to disguise the traffic. On a hosted installation this source is unavailable: the VPN launcher is local-only.',
    link: 'https://www.jobs.ch/en/terms/',
  },
  {
    name: 'jobup.ch and JobScout24',
    group: 'Restricted sites',
    stance: 'against-terms',
    collected: 'Search-result pages and job detail pages, read as HTML.',
    theirRules: 'Both are JobCloud properties, so the same terms prohibiting automation apply. Unlike jobs.ch, neither robots.txt disallows the detail pages this reads.',
    ourPosition: 'Retained for local administrators: jobup.ch has produced six English-confirmed jobs, while JobScout24 remains a low-cost probationary source sharing the same adapter family. Against the platform terms, though without the additional robots.txt conflict that applies to jobs.ch. Same VPN gate, caps and delays. On a hosted installation both are unavailable: the VPN launcher is local-only.',
    link: 'https://www.jobs.ch/en/terms/',
  },
  {
    name: 'IamExpat',
    group: 'Open public pages',
    stance: 'unresolved',
    adminOnly: true,
    collected: 'The public Netherlands job listing index and the linked job pages.',
    theirRules: 'robots.txt disallows /job/, /jobProvider/ and /jobs-iframe/, and sets Crawl-delay: 1. The /career/jobs-netherlands/ paths this reads are not disallowed.',
    ourPosition: 'Retained for local administrators after producing one English-confirmed job. No VPN is required: the paths read are outside the disallow list and the 1.2s delay respects the stated crawl-delay. Their general site terms have not been reviewed, so this is not a clean permission or a public feature. Blocked on the hosted server pending a terms review: local no-VPN is not hosted clearance.',
    link: 'https://www.iamexpat.nl/robots.txt',
  },
  {
    name: 'Undutchables',
    group: 'Restricted sites',
    stance: 'unresolved',
    collected: 'The public vacancy listing index and linked vacancy pages.',
    theirRules: 'Rechecked 2026-09-09: robots.txt allows the plain /vacancies listing and detail paths used here, but disallows query-string vacancy searches. No published API or explicit reuse permission was found. The site has previously returned HTTP 403 to automated requests.',
    ourPosition: 'Retained for local administrators after producing two English-confirmed jobs from three stored advertisements. The adapter uses only the plain listing and details, remains VPN-gated because of the prior blocking, and must stop rather than work around a future block. On a hosted installation it is unavailable: the VPN launcher is local-only.',
    link: 'https://undutchables.nl/robots.txt',
  },
  {
    name: 'Indeed (Switzerland and Netherlands)',
    group: 'Restricted sites',
    stance: 'unresolved',
    adminOnly: true,
    collected: 'When explicitly enabled for a local administrator: role searches, job title, employer, location, posting date and description from the experimental API connection.',
    theirRules: 'The owner reports permission for this local assessment. This has not been independently verified as partner access or public redistribution permission.',
    ourPosition: 'Disabled by default; local administrators only, and blocked on the hosted server until a source-specific hosted decision is made — the local experiment is never silently generalized. The owner made VPN optional for this experiment on 2026-09-20. The specifically approved mobile-header profile uses verified HTTPS without personal OAuth or phone cookies. Four requests maximum per run across both countries, fixed delays, persistent cooldown and stop-on-refusal. Completeness remains unverified, so results do not automatically qualify as English sufficient. Ordinary users cannot search or receive these records.',
  },
  {
    name: 'Nationale Vacaturebank',
    group: 'Not used',
    stance: 'not-used',
    collected: 'Nothing.',
    theirRules: 'Automated access returns HTTP 403 and no authorized feed is configured.',
    ourPosition: 'Not searched.',
  },
  {
    name: 'werk.nl / UWV',
    group: 'Not used',
    stance: 'not-used',
    collected: 'Nothing.',
    theirRules: 'The Dutch public employment service publishes only aggregated open data and has no vacancy API. Its vacancy search sits behind a single sign-on gateway.',
    ourPosition: 'Not used. Getting past the sign-on gateway would mean circumventing an access control, which this project does not do.',
  },
  {
    name: 'LinkedIn',
    group: 'Not used',
    stance: 'not-used',
    collected: 'Nothing.',
    theirRules: 'Prohibits automated collection.',
    ourPosition: 'No adapter exists.',
  },
  {
    name: 'werkzoeken.nl, magnet.me, youngcapital.nl, jobbird.com',
    group: 'Not used',
    stance: 'not-used',
    collected: 'Nothing.',
    theirRules: 'magnet.me and youngcapital.nl carry a blanket robots.txt disallow. werkzoeken.nl sits behind a bot challenge. jobbird.com renders results client-side.',
    ourPosition: 'Not used. Defeating a bot challenge would be detection evasion, which this project does not do under any circumstances.',
  },
  {
    name: 'Jooble (Switzerland and Netherlands)',
    group: 'Not used',
    stance: 'unresolved',
    collected: 'Nothing.',
    theirRules: 'Jooble advertises a REST API for website publishers; a key is required and the returned description quality is unmeasured here.',
    ourPosition: 'Gated: obtain a publisher key and confirm full-text quality, paging, coverage and terms before adding (INT-10). If it returns snippets like Adzuna and Careerjet it adds unknown rows rather than usable jobs. Not enabled.',
    link: 'https://jooble.org/api/about',
  },
  {
    name: 'UWV / werk.nl',
    group: 'Not used',
    stance: 'unresolved',
    collected: 'Nothing.',
    theirRules: 'The Dutch public employment service publishes only aggregated open data; its vacancy search sits behind a single sign-on gateway. Permission is owner-assumed, which does not supply an endpoint.',
    ourPosition: 'Gated: technically unavailable until the owner or provider supplies usable retrieval documentation, schema and any credentials (INT-09). Do not invent an API or count this as enabled. Getting past the sign-on gateway would mean circumventing an access control, which this project does not do.',
  },
  {
    name: 'OpenPostings',
    group: 'Not used',
    stance: 'unresolved',
    collected: 'Nothing.',
    theirRules: 'A public repository advertising 110,000+ companies globally, not that many NL/CH adverts; no explicit repository licence was found in the review.',
    ourPosition: 'Gated: reference only. Obtain code/dataset reuse permission before copying either; do not integrate the whole local Node/SQLite app. No dependable NL/CH yield estimate.',
    link: 'https://github.com/Masterjx9/OpenPostings',
  },
  {
    name: 'eurojobs.com',
    group: 'Not used',
    stance: 'not-used',
    collected: 'Nothing.',
    theirRules: 'Refuses automated use by name: robots.txt carries a dedicated disallow alongside GPTBot and CCBot, plus an AI-training opt-out and an express Article 4 reservation under EU Directive 2019/790.',
    ourPosition: 'Not used. Not to be revisited without written permission from the operator.',
  },
];

/** The transparency page must not name private discovery sources to an ordinary account. */
export function sourcePoliciesForRole(isAdmin: boolean) {
  return isAdmin ? sourcePolicies : sourcePolicies.filter((policy) =>
    !policy.adminOnly && policy.group !== 'Restricted sites');
}

export type SourceGroup = SourcePolicy['group'];

/**
 * Group blurbs for `/sources`, split by viewer.
 *
 * Ordinary accounts see only the sources their own searches use, so their copy must never
 * mention administrator-only entries — naming them would disclose that such entries exist in
 * exactly the groups where page-fetched sources sit. The administrator-only sentences are
 * shown to administrators only.
 */
export function sourceGroupBlurb(group: SourceGroup, isAdmin: boolean): string {
  if (group === 'Authorized APIs') {
    if (isAdmin) {
      return 'Official or keyed interfaces, used the way they are published. Public entries run in the default search and need no VPN; entries marked administrator-only are withheld from ordinary accounts.';
    }
    return 'Official or keyed interfaces, used the way they are published. These run in the default search and need no VPN.';
  }
  if (group === 'Open public pages') {
    if (isAdmin) {
      return 'Public pages whose robots.txt does not disallow what is read here, and whose terms say nothing about automated access. Not an explicit permission, but nothing forbids it, and any stated crawl-delay is honoured. Administrator-only entries in this group are not searched for ordinary accounts.';
    }
    return 'Public pages whose robots.txt does not disallow what is read here, and whose terms say nothing about automated access. Not an explicit permission, but nothing forbids it, and any stated crawl-delay is honoured. These run in your searches.';
  }
  if (group === 'Restricted sites') {
    return 'Administrator-only sources with access restrictions or unresolved permission. Page-fetching sites require the VPN-checked launcher. On a hosted installation these sources stay unavailable — the VPN launcher is local-only — and any hosted-blocked source reports itself blocked with its reason rather than running. The separately approved local Indeed experiment has optional VPN routing and stays local-only; see its entry.';
  }
  return 'Sources deliberately left alone, and why. They appear in the app marked blocked or unavailable so an empty result is never mistaken for "no jobs found".';
}

export const collectionPrinciples = [
  'Only public job advertisements are read. No account is ever logged into, and no page behind a login or access control is fetched.',
  'No personal data about other people is collected. Employer contact details that appear inside an advertisement are stored only as part of that advertisement text.',
  'Account credentials and saved advertisements are not sent to job sites or third-party models.',
  'Verification and password-reset emails are sent through the configured email provider; job sites never receive your email address.',
  'No detection evasion of any kind: no randomised or human-imitating timing, no fingerprint spoofing, no stealth browser plugins, no proxy or IP rotation.',
  'Page-fetched sources run only when explicitly triggered, are capped per run, and wait between requests.',
  'A source that refuses access is left alone for the rest of the run: the refusal is reported, and nothing retries it, routes around it, or disguises the traffic.',
  'Eligible public sources are additionally re-read by a bounded scheduled refresh — at most once per refresh window behind per-source locks — rather than once per visitor: an expired catalogue queues a single shared refresh, rate-limit cooldowns and access pauses persist across restarts, and administrator-only sources are never part of that path.',
  'Everything collected stays in a local database on this machine and can be exported or deleted at any time.',
];
