/**
 * Features that are built and working but deliberately not in front of anyone.
 *
 * Shelving rather than deleting is a decision with a cost: the code stays, so it has to keep
 * compiling and keep being understood. It is worth paying only when the feature is genuinely
 * coming back, which is the case here — turning it on again should be a switch, not a rebuild.
 */

/**
 * CV upload and the CV-fit score.
 *
 * Shelved for the first launch on the owner's instruction: *"CV score and CV add — shelve it, but
 * we will come back to it later. It is a feature which will be developed in future."*
 *
 * The MVP does one thing, which is to say whether English is enough for a job. Matching a CV
 * against a job is a second, different product, and having it half-present made the first one
 * harder to see. Hidden from every account including administrators — this is not a permission,
 * it is a decision about what the product currently is.
 *
 * **Turning this back on is not enough on its own.** Search used to refuse to run without a CV,
 * because search terms were derived from one. That requirement is gone and roles now come from
 * the role keywords, which is a better arrangement regardless. If this is re-enabled, re-read
 * `searchTermsForProfiles`: a CV should *add* terms, never be required for any.
 *
 * What stays live behind the flag: the `cvs` table, `/api/profile`, R2 storage, `scoreFitAcrossCvs`
 * and the per-slot scores on each job. All of it still runs, and simply scores zero with no CV
 * stored, so nothing breaks and nothing needs rebuilding.
 */
export const CV_MATCHING_ENABLED = false;
