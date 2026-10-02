import { aggregatorCredentials } from '@/db/runtime';
import { noStoreJson, rateLimit, requireSession } from '@/lib/guard';
import { searchAdzuna, searchCareerjet } from '@/lib/job-aggregators';

export interface SourceHealth {
  key: string;
  name: string;
  status: 'ok' | 'failing' | 'not_configured';
  detail: string;
}

export interface HealthReport {
  publicIp: string;
  declaredIp: string;
  ipMatches: boolean;
  /**
   * Whether Careerjet actually answered. This, not the IP comparison, is what says the integration
   * works: declaredIp is only the value configured locally, so a mismatch means the local note is
   * stale, which is worth fixing but is not an outage.
   */
  careerjetWorking: boolean;
  /**
   * Whether Careerjet has credentials at all (#191). Without this the interface cannot tell
   * "configured and refusing" from "never set up", and it reported the second as the first:
   * an unconfigured install was told Careerjet was not answering AND that its IP had changed,
   * while the list two lines below correctly said "Not configured". Missing credentials are a
   * neutral state, not an outage, and never evidence about an IP address.
   */
  careerjetConfigured: boolean;
  checkedAt: string;
  sources: SourceHealth[];
}

/** Careerjet rejects calls from an IP that is not declared in the partner account, and home IPs are dynamic, so the live value is worth surfacing. */
async function currentPublicIp() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    if (!response.ok) return '';
    return (await response.json() as { ip?: string }).ip ?? '';
  } catch {
    return '';
  }
}

async function probe(key: string, name: string, configured: boolean, run: () => Promise<unknown[]>): Promise<SourceHealth> {
  if (!configured) return { key, name, status: 'not_configured', detail: 'No credentials set.' };
  try {
    const results = await run();
    return { key, name, status: 'ok', detail: `Returned ${results.length} listing${results.length === 1 ? '' : 's'}.` };
  } catch (error) {
    return { key, name, status: 'failing', detail: error instanceof Error ? error.message : 'Request failed.' };
  }
}

export async function GET(request: Request) {
  // Administrator only, and enforced here rather than in the interface. This returns the server's
  // public IP address - which on a local install is the owner's home address - the IP declared to
  // Careerjet, and the name and status of every keyed integration including Careerjet itself,
  // which P6 otherwise hides from ordinary accounts entirely. Hiding the panel was never enough:
  // the endpoint answered anyone who was signed in.
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  // Each check spends a real Adzuna and Careerjet request, so it is capped per account.
  const limited = rateLimit(`health:${session.user.id}`, 5, 10 * 60_000);
  if (limited) return limited;
  const credentials = aggregatorCredentials();
  const [publicIp, ...sources] = await Promise.all([
    currentPublicIp(),
    probe('careerjet', 'Careerjet', Boolean(credentials.careerjetApiKey),
      () => searchCareerjet(['data'], '', 'netherlands', credentials, 1)),
    probe('adzuna', 'Adzuna', Boolean(credentials.adzunaAppId && credentials.adzunaAppKey),
      () => searchAdzuna(['data'], '', 'netherlands', credentials, 1)),
  ]);

  const declaredIp = credentials.careerjetUserIp ?? '';
  const report: HealthReport = {
    publicIp,
    declaredIp,
    ipMatches: Boolean(publicIp && declaredIp && publicIp === declaredIp),
    careerjetWorking: sources.some((source) => source.key === 'careerjet' && source.status === 'ok'),
    careerjetConfigured: sources.some((source) => source.key === 'careerjet' && source.status !== 'not_configured'),
    checkedAt: new Date().toISOString(),
    sources,
  };
  return noStoreJson(report);
}
