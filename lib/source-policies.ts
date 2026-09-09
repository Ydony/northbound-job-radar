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
    name: 'Company career boards (Greenhouse, Lever, Recruitee, Ashby, Personio)',
    group: 'Authorized APIs',
    stance: 'intended-use',
    collected: 'Public job postings from 61 named employers: title, company, location, description, posting date.',
    theirRules: 'These platforms publish an open, unauthenticated job-board endpoint for each customer precisely so job boards and aggregators can read their vacancies.',
    ourPosition: 'This is the endpoint doing the job it exists for. No key, no login, no rate-limit conflict.',
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
    ourPosition: 'The standard teaser is too short to confirm that English alone is enough, so Adzuna is retained only as an administrator coverage measure. Ordinary accounts neither search it nor receive its stored jobs or run rows. The app does not follow redirect links to copy third-party full text, changes no saved verdicts, and acknowledges The Adzuna API with links to the Swiss and Dutch sites in the private result view.',
    link: 'https://developer.adzuna.com/docs/terms_of_service',
  },
  {
    name: 'Careerjet (Switzerland and Netherlands)',
    group: 'Authorized APIs',
    stance: 'unresolved',
    adminOnly: true,
    collected: 'Search results for the saved role keywords: title, company, location, teaser description, link.',
    theirRules: 'Careerjet issues a publisher API key bound to one registered website, enforced through the Referer header, and requires the calling IP to be declared in the partner account.',
    ourPosition: 'The API is used with a real key inside its rate limit, but the key is registered to a placeholder domain rather than a site we own, so this use sits outside the registered scope. Unresolved.',
    link: 'https://www.careerjet.com/partners/api/',
  },
  {
    name: 'Job-Room / arbeit.swiss',
    group: 'Authorized APIs',
    stance: 'unresolved',
    collected: 'Public Swiss vacancy records: title, employer, location, description, posting date, and the employer-declared language requirements.',
    theirRules: 'The official Swiss public employment service. Its own front end calls an unauthenticated public JSON search API. robots.txt disallows the /job-search/ page route under a comment reading "Do not crawl Job Adverts"; the API path itself is not listed.',
    ourPosition: 'The API path is not disallowed, and this is public-sector data published for job seekers, but that comment states an intent this use does not honour. Materially cleaner than scraping a commercial board, and still not an explicit permission.',
    link: 'https://www.job-room.ch/robots.txt',
  },
  {
    name: 'jobs.ch',
    group: 'Restricted sites',
    stance: 'against-terms',
    collected: 'Search-result pages and job detail pages, read as HTML. The schema.org JobPosting block on each detail page is parsed.',
    theirRules: 'JobCloud\'s terms prohibit crawlers, scrapers, bots, scripting and other automation. robots.txt additionally disallows the job detail pages specifically - the exact pages this reads.',
    ourPosition: 'Knowingly against both the terms and robots.txt, at the operator\'s explicit instruction. Manually triggered only, capped per run, unauthenticated, with a fixed delay between requests and no attempt to disguise the traffic.',
    link: 'https://www.jobs.ch/en/terms/',
  },
  {
    name: 'jobup.ch and JobScout24',
    group: 'Restricted sites',
    stance: 'against-terms',
    collected: 'Search-result pages and job detail pages, read as HTML.',
    theirRules: 'Both are JobCloud properties, so the same terms prohibiting automation apply. Unlike jobs.ch, neither robots.txt disallows the detail pages this reads.',
    ourPosition: 'Against the platform terms, though without the additional robots.txt conflict that applies to jobs.ch. Same caps and delays.',
    link: 'https://www.jobs.ch/en/terms/',
  },
  {
    name: 'IamExpat',
    group: 'Open public pages',
    stance: 'unresolved',
    adminOnly: true,
    collected: 'The public Netherlands job listing index and the linked job pages.',
    theirRules: 'robots.txt disallows /job/, /jobProvider/ and /jobs-iframe/, and sets Crawl-delay: 1. The /career/jobs-netherlands/ paths this reads are not disallowed.',
    ourPosition: 'The paths read are outside the disallow list and the 1.2s delay respects the stated crawl-delay. Their general site terms have not been reviewed, so this is not a clean permission.',
    link: 'https://www.iamexpat.nl/robots.txt',
  },
  {
    name: 'Undutchables',
    group: 'Restricted sites',
    stance: 'against-terms',
    collected: 'The public vacancy listing index and linked vacancy pages.',
    theirRules: 'robots.txt could not be read: the site answers automated requests for it with HTTP 403, which indicates active blocking of non-browser traffic.',
    ourPosition: 'Fetching pages from a site that actively blocks automated requests. The weakest position of any source in use; a candidate for removal.',
  },
  {
    name: 'Indeed (Switzerland and Netherlands)',
    group: 'Not used',
    stance: 'not-used',
    collected: 'Nothing.',
    theirRules: 'Indeed prohibits automated access without written permission and returns HTTP 403 to it.',
    ourPosition: 'Not searched. Listed in the app as blocked so an empty result is never mistaken for "no jobs found".',
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
];

/** The transparency page must not name private discovery sources to an ordinary account. */
export function sourcePoliciesForRole(isAdmin: boolean) {
  return isAdmin ? sourcePolicies : sourcePolicies.filter((policy) =>
    !policy.adminOnly && policy.group !== 'Restricted sites');
}

export const collectionPrinciples = [
  'Only public job advertisements are read. No account is ever logged into, and no page behind a login or access control is fetched.',
  'No personal data about other people is collected. Employer contact details that appear inside an advertisement are stored only as part of that advertisement text.',
  'Your CV never leaves this machine. It is not sent to any job site, aggregator or third-party model.',
  'No detection evasion of any kind: no randomised or human-imitating timing, no fingerprint spoofing, no stealth browser plugins, no proxy or IP rotation.',
  'Page-fetched sources run only when explicitly triggered, are capped per run, and wait between requests.',
  'Everything collected stays in a local database on this machine and can be exported or deleted at any time.',
];
