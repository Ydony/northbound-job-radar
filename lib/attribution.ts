/**
 * Required source attribution.
 *
 * EURES permission to reuse is conditional, and the condition is one sentence in its legal
 * notice: "Re-use is authorised, provided that ELA is acknowledged as the source of the
 * material." EURES supplies the large majority of the jobs this app can confirm as English, so
 * the credit is not a courtesy — it is the basis on which those jobs may be shown at all.
 *
 * The credit and the source keys live here rather than in the page so there is one place to
 * change if a source's terms change, and so the rule can be tested. Nothing tests the pages.
 */
import type { JobRecord } from './types';

/** Adapter keys whose jobs come from the EURES portal. Must match `lib/job-adapters.ts`. */
export const EURES_SOURCE_KEYS = ['eures-ch', 'eures-nl'] as const;

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
