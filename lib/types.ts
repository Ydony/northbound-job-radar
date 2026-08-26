import type { LanguageStatus } from './analysis';

export type CvSlot = 'a' | 'b';
export type WorkplaceMode = 'any' | 'remote' | 'hybrid' | 'onsite';
export type Seniority = 'any' | 'internship' | 'entry' | 'mid' | 'senior' | 'lead';
export type ContractType = 'any' | 'permanent' | 'temporary' | 'contract' | 'internship';

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
  location: string;
  workplace: WorkplaceMode;
  seniority: Seniority;
  contractType: ContractType;
  requiredKeywords: string[];
  excludedKeywords: string[];
  updatedAt: string;
}

export type JobStatus = 'new' | 'saved' | 'applied' | 'ignored';

export interface JobRecord {
  id: string;
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  description: string;
  languageStatus: LanguageStatus;
  languageSummary: string;
  languageSignals: string[];
  fitScoreA: number;
  fitScoreB: number;
  bestCvSlot: CvSlot | '';
  matchedKeywords: string[];
  missingKeywords: string[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppState {
  profiles: CvProfile[];
  jobs: JobRecord[];
  criteria: SearchCriteria;
}
