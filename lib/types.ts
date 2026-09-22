import type { LanguageStatus } from './analysis';
import type { WorkplaceType } from './workplace';
import type { JobExcerpt } from './excerpt';
import type { ExtractedRequirements } from './requirements';

export type CvSlot = 'a' | 'b';
export type WorkplaceMode = 'any' | 'remote' | 'hybrid' | 'onsite';
export type Seniority = 'any' | 'internship' | 'entry' | 'mid' | 'senior' | 'lead';
export type ContractType = 'any' | 'permanent' | 'temporary' | 'contract' | 'internship';
export type JobCountry = 'switzerland' | 'netherlands' | 'unknown';
export type ApplicationStatus = 'not_applied' | 'applied';
export type VisibilityStatus = 'active' | 'dismissed';

export interface CvProfile {
  slot: CvSlot;
  cvFileName: string;
  hasCvText: boolean;
  derivedRole: string;
  updatedAt: string;
}

export interface SearchCriteria {
  roleOverrideA: string;
  roleOverrideB: string;
  roleKeywords: string[];
  location: string;
  workplace: WorkplaceMode;
  seniority: Seniority;
  contractType: ContractType;
  requiredKeywords: string[];
  excludedKeywords: string[];
  /** Which countries a search contacts sources for. Both default to on. */
  searchNetherlands: boolean;
  searchSwitzerland: boolean;
  updatedAt: string;
}

/**
 * IND-Next 1: Indeed-only place and distance, per account. Kilometres are the
 * stored and user-facing unit; collection converts to provider miles. Present
 * only for administrators; ordinary accounts never receive it (see /api/state).
 */
export interface IndeedSettings {
  nlLocation: string;
  nlRadiusKm: number;
  chLocation: string;
  chRadiusKm: number;
  updatedAt: string;
}

export type LanguageFeedbackVerdict = '' | 'correct' | 'incorrect';

export interface JobRecord {
  id: string;
  sourceUrl: string;
  canonicalUrl: string;
  sourceKey: string;
  sourceName: string;
  sourceJobId: string;
  country: JobCountry;
  title: string;
  company: string;
  location: string;
  /**
   * The employer's advertisement text is deliberately absent from this type.
   *
   * Reading a source and republishing what it holds are two different permissions
   * (docs/SOURCE_POLICY.md §1). The advertisement is written by the employer, not by the source
   * and not by us, so it is fetched, screened server-side, and stops there. What reaches a client
   * is facts about the job plus our own work on it — the verdict, the extracted requirements, and
   * whether it matches the saved criteria — and a link to the page the employer chose to publish.
   *
   * These three fields exist so nothing in the interface needs the text back.
   */
  /** Characters of advertisement the source published. Distinguishes a teaser from a full ad. */
  descriptionLength: number;
  /** Our own extraction, not the employer's prose. Null when the ad states none under a heading. */
  requirements: ExtractedRequirements | null;
  /**
   * One short line saying what the employer asks for, so the card answers "can I do this job?".
   * Capped at MAX_EXCERPT_CHARS; `source` says how confident it is. Null when the ad says nothing
   * usable, which is shown as nothing rather than as a guess.
   */
  excerpt: JobExcerpt | null;
  /** Evaluated server-side against the saved criteria, because the client no longer has the text. */
  matchesCriteria: boolean;
  languageStatus: LanguageStatus;
  languageSummary: string;
  languageSignals: string[];
  languageFeedback: LanguageFeedbackVerdict;
  correctedLanguageStatus: LanguageStatus | '';
  languageFeedbackReason: string;
  languageFeedbackUpdatedAt: string;
  fitScoreA: number;
  fitScoreB: number;
  bestCvSlot: CvSlot | '';
  matchedKeywords: string[];
  missingKeywords: string[];
  identityFingerprint: string;
  /** Id of the job shown in this one's place when the same posting was found on another board. */
  duplicateOf: string;
  /** How many other boards carry this same posting. Set on the job that is actually displayed. */
  duplicateCount?: number;
  /** Names of the boards those copies came from, for the "also on" line. */
  duplicateSources?: string[];
  isSaved: boolean;
  applicationStatus: ApplicationStatus;
  visibilityStatus: VisibilityStatus;
  workplaceType: WorkplaceType;
  postedAt: string;
  /**
   * Publication end date (YYYY-MM-DD) when the source published one (#97). Empty means no
   * expiry was published, not that the advertisement expired. Compared against today on the
   * card; the row is never deleted or hidden because of it.
   */
  expiresAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

// 'skipped' is the person's own choice not to search a country, which is not a fault and must
// not be counted as one. 'disabled' already means the source itself is off; conflating the two
// would make Search statistics report a deliberate setting as something that went wrong.
export type SourceRunStatus = 'complete' | 'partial' | 'failed' | 'blocked' | 'disabled'
  | 'unavailable' | 'skipped';

export interface SearchRunSource {
  sourceKey: string;
  sourceName: string;
  country: JobCountry;
  status: SourceRunStatus;
  rolesSearched: string[];
  foundCount: number;
  knownCount: number;
  newCount: number;
  importedCount: number;
  /**
   * New jobs from this run that were matches at search time: first-time unique
   * additions that were English-confirmed (detector verdict, before any later
   * user correction) and met the saved criteria then. NULL means unknown —
   * rows written before migration 25, or sources that never completed, carry
   * no number and must render as unknown rather than as a false zero (#124).
   */
  matchedCount: number | null;
  duplicateCount: number;
  skippedCount: number;
  message: string;
}

export interface CollectionSourceTotal {
  sourceKey: string;
  sourceName: string;
  country: JobCountry;
  /** Retained rows attributed to this source (first-kept source wins). */
  total: number;
}

export interface CollectionTotals {
  /**
   * Unique jobs retained in this account across every search (prior plus new),
   * including saved/applied/dismissed rows. Deliberately deleted or reset rows
   * are gone and are not counted. Never a sum of per-run found counts (#124).
   */
  total: number;
  bySource: CollectionSourceTotal[];
}

export interface SearchRun {
  id: string;
  status: 'complete' | 'partial' | 'failed';
  startedAt: string;
  completedAt: string;
  sources: SearchRunSource[];
}

export interface AccountSummary {
  email: string;
  role: 'admin' | 'user';
}

export interface AppState {
  /** Total jobs owned, which may exceed the number returned; see jobLimit. */
  totalJobs?: number;
  /** Jobs the saved keywords keep, across every page. Counts converge to this as pages load. */
  matchingJobs?: number;
  /**
   * Account-scoped retained collection for the #124 totals, from the server —
   * never derived from loaded pages. Missing on older responses; callers must
   * fall back to totalJobs rather than to a page length.
   */
  collectionTotals?: CollectionTotals;
  /** Copies folded into the jobs on screen, on the loaded pages. Accumulate across pages. */
  hiddenDuplicates?: number;
  jobLimit?: number;
  /** Keyset cursor for the next page of /api/state, or null/undefined when this page is the end. */
  nextCursor?: string | null;
  account: AccountSummary | null;
  /** Source keys an ordinary account never sees. Non-empty only for an administrator, who
   *  can see them anyway - it exists so the "view as user" preview hides the same rows the
   *  server already withholds from everyone else. */
  adminOnlySources?: string[];
  profiles: CvProfile[];
  jobs: JobRecord[];
  criteria: SearchCriteria;
  /**
   * Indeed-only place and distance (#113). Present for administrators only;
   * ordinary accounts never receive it, by direct API or by guessing another
   * account's row, because every read is scoped to the session user and gated
   * on role. Missing on older responses; callers must fall back to defaults.
   */
  indeedSettings?: IndeedSettings;
  searchRuns: SearchRun[];
}
