// Reusable Node interface to the application's local, account-scoped Indeed search.
// Does not call Indeed directly or bypass the server's admission controls.
export function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a loopback HTTP origin, for example http://127.0.0.1:3001');
  }
  return url.origin;
}

export function decodeSearch(text) {
  // Never turn a truncated stream or progress-only response into a successful empty search.
  const lines = text.trim().split('\n').filter(Boolean);
  const events = lines.map(line => JSON.parse(line));
  const result = events.at(-1);
  if (!result || result.type === 'progress' || !result.run || !Array.isArray(result.added)
    || !Array.isArray(result.run.sources)) throw new Error('Incomplete search response; inspect run history before retrying.');
  return result;
}

export function createIndeedOperator({ baseUrl, cookie = '', fetcher = fetch }) {
  const origin = localOrigin(baseUrl);
  if (cookie && !/^[^\s;=]+=[^\s;]+$/.test(cookie)) throw new Error('Invalid saved session');
  async function call(path, method = 'GET', body) {
    let response;
    try {
      response = await fetcher(origin + path, { method, redirect: 'error',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    } catch { throw new Error('Local app unavailable or request interrupted. Check the server and run history before retrying.'); }
    if (!response.ok) {
      const errors = { 401: 'Session expired; run Indeed login again.', 403: 'Local administrator access required.',
        429: 'Request rate limited. Wait before retrying.' };
      throw new Error(errors[response.status] ?? `Local app returned HTTP ${response.status}. Check settings and server health.`);
    }
    return response;
  }
  return {
    async login(email, password) {
      const response = await call('/api/auth', 'POST', { action: 'login', email, password });
      const data = await response.json();
      if (data.role !== 'admin') throw new Error('An administrator account is required.');
      const session = response.headers.get('set-cookie')?.split(';')[0];
      if (!session) throw new Error('The app did not issue a session.');
      cookie = session;
      return { origin, cookie };
    },
    async status() { return (await call('/api/admin/indeed')).json(); },
    async search() {
      const response = await call('/api/scrape', 'POST', { mode: 'authorized', sourceGroup: 'indeed' });
      const result = decodeSearch(await response.text());
      if (result.run.sources.some(source => !['indeed-ch', 'indeed-nl'].includes(source.sourceKey))) {
        throw new Error('Unexpected source in Indeed-only response');
      }
      return { ...result, ok: result.run.sources.some(source => ['complete', 'partial'].includes(source.status)) };
    },
    async logout() { await call('/api/auth', 'DELETE'); cookie = ''; },
  };
}

export const APPROVED_PROFILE_REVISION = 'fda080a373e8226f3fd60635323f5da9af9892b1';
export async function approvedProfile(fetcher = fetch) {
  const response = await fetcher(`https://raw.githubusercontent.com/speedyapply/JobSpy/${APPROVED_PROFILE_REVISION}/jobspy/indeed/constant.py`,
    { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Pinned configuration source unavailable; existing configuration unchanged.');
  const source = await response.text();
  if (source.length > 100000) throw new Error('Unexpected configuration source size');
  return validateProfile({
    INDEED_API_KEY: /"indeed-api-key"\s*:\s*"([a-fA-F0-9]{64})"/.exec(source)?.[1],
    INDEED_USER_AGENT: /"user-agent"\s*:\s*"([^"\r\n]{1,500})"/.exec(source)?.[1],
    INDEED_APP_INFO: /"indeed-app-info"\s*:\s*"([^"\r\n]{1,250})"/.exec(source)?.[1],
  });
}
export function validateProfile(profile) {
  if (!profile || !/^[a-fA-F0-9]{64}$/.test(profile.INDEED_API_KEY ?? '')
    || !/^[\x20-\x7e]{1,500}$/.test(profile.INDEED_USER_AGENT ?? '')
    || !/^[\x20-\x7e]{1,250}$/.test(profile.INDEED_APP_INFO ?? '')) throw new Error('Missing or invalid Indeed profile');
  return Object.fromEntries(['INDEED_API_KEY', 'INDEED_USER_AGENT', 'INDEED_APP_INFO'].map(key => [key, profile[key]]));
}
export function configuredVars(existing, profile) {
  const values = { ...validateProfile(profile), INDEED_ENABLED: 'true', INDEED_LOCAL_ONLY: 'true', INDEED_APP_IDENTITY_APPROVED: 'true' };
  const kept = existing.split(/\r?\n/).filter(line => !Object.keys(values).some(key => new RegExp(`^\\s*${key}\\s*=`).test(line)));
  return `${kept.join('\n').trimEnd()}\n${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`;
}
