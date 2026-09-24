/**
 * Required source attribution.
 *
 * Two sources carry a required-attribution condition in docs/SOURCE_POLICY.md:
 *
 * - EURES: reuse is authorised provided ELA is acknowledged as the source. EURES
 *   supplies the large majority of the jobs this app can confirm as English, so
 *   the credit is not a courtesy — it is the basis on which those jobs may be
 *   shown at all. Shown to everyone: on `/sources` under "Required attribution"
 *   and under the job list whenever EURES jobs are on screen.
 * - Adzuna: published research must name "The Adzuna API" and link to the
 *   relevant local domain. Adzuna is administrator-only, so this acknowledgement
 *   is shown only in the owner's private result view and in the administrator's
 *   `/sources` "Required attribution" section; public users never receive
 *   Adzuna rows and must not learn the source exists.
 *
 * The credit and the source keys live here rather than in the page so there is one place to
 * change if a source's terms change, and so the rule can be tested. Page-wiring tests in
 * tests/attribution.test.ts assert both pages actually render these strings.
 */
import type { JobRecord } from './types';

/** Adapter keys whose jobs come from the EURES portal. Must match `lib/job-adapters.ts`. */
export const EURES_SOURCE_KEYS = ['eures-ch', 'eures-nl'] as const;

/** Adzuna jobs are stored under the local site host, not the adapter's country key. */
export const ADZUNA_SOURCE_KEYS = ['adzuna.ch', 'adzuna.nl'] as const;

/**
 * Adzuna's personal-research terms require this name and a link to the relevant local domain
 * wherever vacancy data is published. Adzuna is administrator-only, so this acknowledgement is
 * shown only in the owner's private result view and the administrator's `/sources`
 * "Required attribution" section; public users never receive Adzuna rows.
 */
export const ADZUNA_ATTRIBUTION = 'Vacancy data from The Adzuna API.';
export const ADZUNA_LOCAL_LINKS = {
  'adzuna.ch': 'https://www.adzuna.ch/',
  'adzuna.nl': 'https://www.adzuna.nl/',
} as const;

/**
 * Names the European Labour Authority specifically. "the EU" or "europa.eu" would not satisfy
 * the condition, which asks for ELA by name.
 */
export const ELA_ATTRIBUTION =
  'EURES vacancies are reused with the permission of the European Labour Authority (ELA), '
  + 'acknowledged as the source of that material.';

export const ELA_ATTRIBUTION_LINK = 'https://eures.europa.eu/legal-notice_en';

export function isEuresJob(job: Pick<JobRecord, 'sourceKey'>) {
  return (EURES_SOURCE_KEYS as readonly string[]).includes(job.sourceKey);
}

/** True when the given jobs include at least one the credit must be shown for. */
export function needsElaAttribution(jobs: readonly Pick<JobRecord, 'sourceKey'>[]) {
  return jobs.some(isEuresJob);
}

export function adzunaSourcesOnScreen(jobs: readonly Pick<JobRecord, 'sourceKey'>[]) {
  const present = new Set(jobs.map((job) => job.sourceKey));
  return ADZUNA_SOURCE_KEYS.filter((key) => present.has(key));
}

/**
 * Which attribution blocks the `/sources` "Required attribution" section shows.
 *
 * ELA is public (EURES is a public source) so it renders for everyone. Adzuna is
 * administrator-only: ordinary accounts must not learn the source exists, matching
 * `sourcePoliciesForRole` and the search/jobs APIs, so it renders only for admins.
 */
export function sourcesPageAttributionKeys(isAdmin: boolean): Array<'ela' | 'adzuna'> {
  return isAdmin ? ['ela', 'adzuna'] : ['ela'];
}
