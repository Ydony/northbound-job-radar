'use client';
import { useState } from 'react';
import type { IndeedStatus } from '@/lib/indeed/collection';

const labels: Record<string, string> = {
  disabled: 'Disabled in local configuration', denied: 'Experiment not approved in local configuration',
  not_configured: 'Connection credentials are missing or invalid',
  refused: 'Paused after refusal or an unexpected response — operator review required',
  cooldown: 'Cooling down before another search', busy: 'Another Indeed search is running',
  ready: 'Configured; no successful search recorded yet', connected: 'A previous search connected successfully',
  unavailable: 'Collection state unavailable',
};
export default function IndeedStatusPanel({ search, busy }: { search: () => void; busy: boolean }) {
  const [status, setStatus] = useState<IndeedStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  async function check() {
    setChecking(true); setError('');
    try {
      const response = await fetch('/api/admin/indeed');
      if (!response.ok) throw new Error('Readiness unavailable. Check the local-only configuration and your administrator session.');
      setStatus(await response.json() as IndeedStatus);
    } catch { setError('Readiness unavailable. Check local configuration and your administrator session.'); }
    finally { setChecking(false); }
  }
  return <div className="health-panel">
    <div className="health-head"><b>Indeed · local administrator experiment</b>
      <button type="button" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check readiness'}</button></div>
    <p role="status">{error || (status ? labels[status.state] ?? 'Unavailable' : 'Search directly after local setup. The server checks access and connection configuration automatically.')}
      {status?.retryAfterSeconds ? ` Try again in ${status.retryAfterSeconds} seconds.` : ''}</p>
    {status?.lastSuccess && <p>Last successful connection: {new Date(status.lastSuccess).toLocaleString()}</p>}
    <p>Searches the selected countries using the first two role keywords. At most four requests and 100 returned rows in total. Jobs are screened with the shared English-language filter; results and counts appear in the existing list and source report.</p>
    {/* UX-6f: a bare button renders the 16px browser default (off the type ladder)
        at 24px tall (under the 44px tap floor). Search actions use the shared
        pill so this one does too. */}
    <button className="jobs-button" type="button" disabled={busy} onClick={search}>Search Indeed only</button>
  </div>;
}
