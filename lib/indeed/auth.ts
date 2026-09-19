import type { IndeedAccess, IndeedCountry, IndeedCredentials } from './contracts';

export type IndeedReadiness = 'ready' | 'disabled' | 'denied' | 'not_configured';

export function indeedReadiness(access: IndeedAccess, credentials?: IndeedCredentials): IndeedReadiness {
  if (typeof window !== 'undefined') return 'denied';
  if (!access.enabled) return 'disabled';
  if (!access.localExecution || !access.administrator || !access.appIdentityExperimentApproved) return 'denied';
  if (!credentials || !/^[a-f0-9]{64}$/i.test(credentials.apiKey)
    || !/^[\x20-\x7e]{1,500}$/.test(credentials.userAgent)
    || !/^[\x20-\x7e]{1,250}$/.test(credentials.appInfo)) return 'not_configured';
  return 'ready';
}

/** Backend-only. Credentials are supplied explicitly; no bundled key or phone token. */
export function indeedHeaders(credentials: IndeedCredentials, country: IndeedCountry): Record<string, string> {
  return {
    'content-type': 'application/json', accept: 'application/json',
    'indeed-api-key': credentials.apiKey, 'user-agent': credentials.userAgent,
    'indeed-app-info': credentials.appInfo, 'indeed-co': country,
    'indeed-locale': 'en-US', 'accept-language': 'en-US,en;q=0.9',
  };
}
