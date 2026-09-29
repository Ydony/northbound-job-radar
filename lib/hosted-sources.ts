/**
 * Hosted readiness assessment for administrator-only sources (F4, T13).
 *
 * One row per administrator-side adapter key in `lib/job-adapters.ts`, giving the hosted
 * decision the owner reviews before launch: `supported`, `configuration-needed`, or `blocked`
 * with the exact reason. This is an assessment, not an enablement: nothing here changes which
 * sources run on the host, and the scope gate between T12/T13 and T14 stays closed until the
 * owner reviews the matrix in `docs/HOSTED_SOURCE_ASSESSMENT.md`.
 *
 * Secrecy rule: this file names environment VARIABLES, never their values. No key, token,
 * IP address, or credential content belongs here; `tests/hosted-source-assessment.test.ts`
 * trips if anything shaped like a secret value ever lands in the matrix.
 */

export type HostedDecision = 'supported' | 'configuration-needed' | 'blocked';

export interface HostedSourceAssessment {
  /** Adapter `key` in `lib/job-adapters.ts`. */
  key: string;
  /** Hosted verdict for the owner review gate. */
  decision: HostedDecision;
  /** Exact reason: what the upstream requires and why the decision follows. */
  reason: string;
  /** Environment variable NAMES (never values) this source reads. */
  credentialNames: string[];
  /** Site registration, Referer, IP, or user-agent constraints the upstream imposes. */
  siteOrIpRequirements: string;
}

export const HOSTED_SOURCE_ASSESSMENTS: readonly HostedSourceAssessment[] = [
  {
    key: 'adzuna-ch',
    decision: 'configuration-needed',
    reason: 'Keyed API with no site or IP binding: any egress IP works within the provider limits '
      + '(25 requests/minute, 250/day). Hosted use needs ADZUNA_APP_ID and ADZUNA_APP_KEY set '
      + 'explicitly; without them the source reports unavailable and is never silently treated as '
      + 'searched. The standard API returns short teasers that cannot confirm English, so it stays '
      + 'an administrator measurement source even when configured.',
    credentialNames: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    siteOrIpRequirements: 'None: no registered site, Referer, declared IP, or per-request user-IP requirement.',
  },
  {
    key: 'adzuna-nl',
    decision: 'configuration-needed',
    reason: 'Keyed API with no site or IP binding: any egress IP works within the provider limits. '
      + 'Hosted use needs ADZUNA_APP_ID and ADZUNA_APP_KEY set explicitly; without them the source '
      + 'reports unavailable and is never silently treated as searched. The standard API returns short '
      + 'teasers that cannot confirm English, so it stays an administrator measurement source even when '
      + 'configured.',
    credentialNames: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    siteOrIpRequirements: 'None: no registered site, Referer, declared IP, or per-request user-IP requirement.',
  },
  {
    key: 'careerjet-ch',
    decision: 'blocked',
    reason: 'Blocked for hosted use: Careerjet binds each publisher key to one registered site and '
      + 'requires the real end-user IP, user agent, and originating-page Referer on every query, '
      + 'plus any IP declaration on the publisher account; the current registration is unresolved. '
      + 'A server egress IP (especially for phone-triggered runs) cannot stand in for the '
      + 'per-request real-user IP. Leave CAREERJET_API_KEY, CAREERJET_REFERER, and CAREERJET_USER_IP '
      + 'unset in every hosted environment; local administrator discovery only.',
    credentialNames: ['CAREERJET_API_KEY', 'CAREERJET_REFERER', 'CAREERJET_USER_IP'],
    siteOrIpRequirements: 'One registered publisher site per key; Referer must be a triggering page on that '
      + 'site; every query must carry the real end-user IP and user agent; account-level declared-IP '
      + 'constraint applies. Dynamic addresses do not satisfy this.',
  },
  {
    key: 'careerjet-nl',
    decision: 'blocked',
    reason: 'Blocked for hosted use: Careerjet binds each publisher key to one registered site and '
      + 'requires the real end-user IP, user agent, and originating-page Referer on every query; the '
      + 'current registration is unresolved. A server egress IP cannot stand in for the per-request '
      + 'real-user IP. Leave CAREERJET_API_KEY, CAREERJET_REFERER, and CAREERJET_USER_IP unset in every '
      + 'hosted environment; local administrator discovery only.',
    credentialNames: ['CAREERJET_API_KEY', 'CAREERJET_REFERER', 'CAREERJET_USER_IP'],
    siteOrIpRequirements: 'One registered publisher site per key; Referer must be a triggering page on that '
      + 'site; every query must carry the real end-user IP and user agent; account-level declared-IP '
      + 'constraint applies. Dynamic addresses do not satisfy this.',
  },
  {
    key: 'jobs.ch',
    decision: 'blocked',
    reason: 'Blocked for hosted use: JobCloud terms prohibit automation and robots.txt additionally '
      + 'disallows the job-detail pages read. Retained for local administrators behind a verified VPN '
      + 'at the owner explicit instruction only; a hosted datacenter egress increases exposure without '
      + 'creating permission. Written JobCloud permission or an authorized feed is required first.',
    credentialNames: [],
    siteOrIpRequirements: 'No key exists; the constraint is the VPN-only local boundary, which a host cannot satisfy.',
  },
  {
    key: 'jobup.ch',
    decision: 'blocked',
    reason: 'Blocked for hosted use: JobCloud property sharing the same automation prohibition as jobs.ch. '
      + 'Local administrator plus verified VPN only; written permission required before any hosted use.',
    credentialNames: [],
    siteOrIpRequirements: 'No key exists; the constraint is the VPN-only local boundary, which a host cannot satisfy.',
  },
  {
    key: 'jobscout24.ch',
    decision: 'blocked',
    reason: 'Blocked for hosted use: JobCloud property kept on probation under the same terms prohibition '
      + 'and VPN boundary as jobup.ch. Written permission required before any hosted use.',
    credentialNames: [],
    siteOrIpRequirements: 'No key exists; the constraint is the VPN-only local boundary, which a host cannot satisfy.',
  },
  {
    key: 'iamexpat.nl',
    decision: 'blocked',
    reason: 'Blocked for hosted use pending a terms review: the career paths read sit outside the '
      + 'robots.txt disallow list and the published crawl delay is honoured, but there is no explicit '
      + 'permission and the general site terms are unreviewed. Retained for local administrators only; '
      + 'no VPN is required locally, which is not the same as hosted clearance.',
    credentialNames: [],
    siteOrIpRequirements: 'No key or IP binding; the constraint is the missing explicit permission.',
  },
  {
    key: 'undutchables.nl',
    decision: 'blocked',
    reason: 'Blocked for hosted use: the site previously returned HTTP 403 to automation, so the adapter '
      + 'stays behind the precautionary VPN gate and must stop on any block rather than work around it. '
      + 'Hosted datacenter egress is the traffic most likely to be blocked again.',
    credentialNames: [],
    siteOrIpRequirements: 'No key exists; the constraint is the precautionary VPN gate after prior blocking.',
  },
  {
    key: 'indeed-ch',
    decision: 'blocked',
    reason: 'Blocked for hosted use: the local experimental exception (loopback request, administrator '
      + 'account, explicitly approved identity, enabled flag, valid credential shape) covers one '
      + 'administrator assessing Indeed locally under owner-reported authorisation that is unverified '
      + 'here. It establishes no public redistribution licence and must never be generalized to the '
      + 'host. A source-specific owner decision is required before any hosted implementation.',
    credentialNames: ['INDEED_ENABLED', 'INDEED_LOCAL_ONLY', 'INDEED_APP_IDENTITY_APPROVED',
      'INDEED_API_KEY', 'INDEED_USER_AGENT', 'INDEED_APP_INFO'],
    siteOrIpRequirements: 'Local loopback execution only (INDEED_LOCAL_ONLY plus a localhost/127.0.0.1/[::1] '
      + 'request origin); administrator account; explicitly approved identity. None of these is satisfiable '
      + 'from hosted production, by design.',
  },
  {
    key: 'indeed-nl',
    decision: 'blocked',
    reason: 'Blocked for hosted use: the local experimental exception (loopback request, administrator '
      + 'account, explicitly approved identity, enabled flag, valid credential shape) covers one '
      + 'administrator assessing Indeed locally under owner-reported authorisation that is unverified '
      + 'here. It establishes no public redistribution licence and must never be generalized to the '
      + 'host. A source-specific owner decision is required before any hosted implementation.',
    credentialNames: ['INDEED_ENABLED', 'INDEED_LOCAL_ONLY', 'INDEED_APP_IDENTITY_APPROVED',
      'INDEED_API_KEY', 'INDEED_USER_AGENT', 'INDEED_APP_INFO'],
    siteOrIpRequirements: 'Local loopback execution only (INDEED_LOCAL_ONLY plus a localhost/127.0.0.1/[::1] '
      + 'request origin); administrator account; explicitly approved identity. None of these is satisfiable '
      + 'from hosted production, by design.',
  },
  {
    key: 'nationalevacaturebank.nl',
    decision: 'blocked',
    reason: 'Blocked: automated access returned HTTP 403 and no authorized feed is configured. There is '
      + 'nothing to configure on the host until an authorized route exists.',
    credentialNames: [],
    siteOrIpRequirements: 'No authorized feed; HTTP 403 to automation.',
  },
  {
    key: 'iamsterdam.com',
    decision: 'blocked',
    reason: 'Blocked: a city guide, not a vacancy feed. Never a collection source on any environment.',
    credentialNames: [],
    siteOrIpRequirements: 'Not applicable: not a feed.',
  },
];

/** The hosted assessment for an adapter key, or `undefined` when the key has none. */
export function hostedAssessmentFor(adapterKey: string): HostedSourceAssessment | undefined {
  return HOSTED_SOURCE_ASSESSMENTS.find((entry) => entry.key === adapterKey);
}
