import type { LanguageStatus } from './analysis';
import type { WorkplaceType } from './workplace';

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
  description: string;
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
  isSaved: boolean;
  applicationStatus: ApplicationStatus;
  visibilityStatus: VisibilityStatus;
  workplaceType: WorkplaceType;
  postedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export type SourceRunStatus = 'complete' | 'partial' | 'failed' | 'blocked' | 'disabled' | 'unavailable';

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
  duplicateCount: number;
  skippedCount: number;
  message: string;
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
  account: AccountSummary | null;
  profiles: CvProfile[];
  jobs: JobRecord[];
  criteria: SearchCriteria;
  searchRuns: SearchRun[];
}
