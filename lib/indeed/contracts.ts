/** Version 1: experimental transport contract, not a public-source entitlement. */
export type IndeedCountry = 'NL' | 'CH';

export interface IndeedCredentials {
  apiKey: string;
  userAgent: string;
  appInfo: string;
}

/** All flags must come from trusted server configuration/session, never request JSON. */
export interface IndeedAccess {
  enabled: boolean;
  localExecution: boolean;
  administrator: boolean;
  appIdentityExperimentApproved: boolean;
}

export interface IndeedSearchInput {
  country: IndeedCountry;
  keywords: string;
  location: string;
  radiusMiles?: number;
  /** Provider-side dateOnIndeed lookback; an approximate prefilter, never an exact posting boundary. */
  hoursOld?: number;
  sort?: 'RELEVANCE' | 'DATE';
  pageSize?: number;
  maxRequests?: number;
  maxJobs?: number;
  signal?: AbortSignal;
}

/** Transport validation only. #66 owns normalization, safe links and language eligibility. */
export interface IndeedRecord {
  key: string;
  title: string;
  employer: string;
  city: string;
  country: IndeedCountry | 'unknown';
  postedAtMs: number | null;
  descriptionHtml: string;
  descriptionEvidence: 'api-description-field';
  /** Length alone cannot establish that an advertisement is complete. */
  completeness: 'unknown';
}

export type IndeedStopReason = 'end_of_results' | 'budget_exhausted' | 'repeated_cursor'
  | 'disabled' | 'denied' | 'not_configured' | 'invalid_input' | 'busy'
  | 'access_refused' | 'rate_limited' | 'redirect_refused' | 'upstream_error'
  | 'invalid_response' | 'response_too_large' | 'timeout' | 'cancelled' | 'network_error';

export interface IndeedSearchResult {
  contractVersion: 1;
  outcome: 'complete' | 'partial' | 'failed' | 'unavailable';
  reason: IndeedStopReason;
  jobs: IndeedRecord[];
  requestsMade: number;
  responseRows: number;
  duplicateRows: number;
  rejectedRows: number;
  hasMore: boolean | null;
  retryAfterSeconds?: number;
}
