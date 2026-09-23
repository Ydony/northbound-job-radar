'use client';
import { useState } from 'react';
import { INDEED_RUNNING_BUDGET, type IndeedCoverageSummary, type IndeedStatus } from '@/lib/indeed/collection';
import { sourceRunStatusLabel } from '@/lib/dashboard';
import type { IndeedSettings, SearchRunSource } from '@/lib/types';

const labels: Record<string, string> = {
  disabled: 'Disabled in local configuration', denied: 'Experiment not approved in local configuration',
  not_configured: 'Connection credentials are missing or invalid',
  refused: 'Paused after refusal or an unexpected response — operator review required',
  cooldown: 'Cooling down before another search', busy: 'Another Indeed search is running',
  ready: 'Configured; no successful search recorded yet', connected: 'A previous search connected successfully',
  unavailable: 'Collection state unavailable',
};

type AdminOverview = IndeedStatus & { coverage?: IndeedCoverageSummary[] };

export interface IndeedPanelData {
  /** First two saved role queries — the only ones Indeed ever receives. */
  roles: string[];
  netherlands: boolean;
  switzerland: boolean;
  /** The administrator's saved settings; null while the state is loading. */
  settings: IndeedSettings | null;
  /** Indeed sources from the latest run, in report order. */
  runSources: SearchRunSource[];
  runStartedAt: string | null;
}

function formatDate(value: string): string {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'unknown' : parsed.toLocaleString();
}

export default function IndeedStatusPanel({ search, busy, searchDisabled, roles, netherlands, switzerland,
  settings, runSources, runStartedAt }: { search: () => void; busy: boolean; searchDisabled?: boolean } & IndeedPanelData) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({ nlLocation: '', nlRadiusKm: '', chLocation: '', chRadiusKm: '' });
  const [draftReady, setDraftReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [draftTouched, setDraftTouched] = useState(false);
  const [prevSettings, setPrevSettings] = useState<IndeedSettings | null>(null);

  // The saved settings arrive with the state load; seed the form from them
  // during render (never in an effect), then leave the administrator's edits
  // alone on every later render.
  if (settings !== prevSettings) {
    setPrevSettings(settings);
    if (settings && !draftTouched) {
      setDraft({
        nlLocation: settings.nlLocation, nlRadiusKm: String(settings.nlRadiusKm),
        chLocation: settings.chLocation, chRadiusKm: String(settings.chRadiusKm),
      });
      setDraftReady(true);
    }
  }

  function editDraft(patch: Partial<typeof draft>) {
    setDraftTouched(true);
    setDraft({ ...draft, ...patch });
  }

  async function check() {
    setChecking(true); setError('');
    try {
      const response = await fetch('/api/admin/indeed');
      if (!response.ok) throw new Error('Readiness unavailable. Check the local-only configuration and your administrator session.');
      setOverview(await response.json() as AdminOverview);
    } catch { setError('Readiness unavailable. Check local configuration and your administrator session.'); }
    finally { setChecking(false); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setFeedback('');
    try {
      const body = {
        nlLocation: draft.nlLocation, nlRadiusKm: Number(draft.nlRadiusKm),
        chLocation: draft.chLocation, chRadiusKm: Number(draft.chRadiusKm),
      };
      const response = await fetch('/api/admin/indeed/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json() as { settings?: IndeedSettings; error?: string };
      if (!response.ok) throw new Error(payload.error || 'Settings were not saved.');
      setDraft({
        nlLocation: payload.settings!.nlLocation, nlRadiusKm: String(payload.settings!.nlRadiusKm),
        chLocation: payload.settings!.chLocation, chRadiusKm: String(payload.settings!.chRadiusKm),
      });
      setFeedback('Saved. The next search uses these places and distances.');
    } catch (saveError) {
      setFeedback(saveError instanceof Error ? saveError.message : 'Settings were not saved.');
    } finally { setSaving(false); }
  }

  const coverage = overview?.coverage ?? [];
  return <div className="health-panel">
    <div className="health-head"><b>Indeed · local administrator experiment</b>
      <button type="button" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check readiness'}</button></div>
    <p role="status">{error || (overview ? labels[overview.state] ?? 'Unavailable' : 'Search directly after local setup. The server checks access and connection configuration automatically.')}
      {overview?.retryAfterSeconds ? ` Try again in ${overview.retryAfterSeconds} seconds.` : ''}</p>
    {overview?.lastSuccess && <p>Last successful connection: {formatDate(overview.lastSuccess)}</p>}

    <p>Searching as {roles.length ? roles.map((role) => `“${role}”`).join(' and ') : 'no saved roles yet — save role keywords first'}
      {roles.length ? ' (the first two saved roles; Indeed never receives the other three)' : ''}.
      Refresh looks back at recent postings only — at most {INDEED_RUNNING_BUDGET.perQueryMaxRows} returned
      rows per role per country and {INDEED_RUNNING_BUDGET.totalMaxRows} in total, a cap, never a
      target it fills with older results. Previously collected jobs and their
      saved, applied and dismissed states remain.</p>

    <form onSubmit={save}>
      <fieldset>
        <legend>Indeed places and distances</legend>
        {!netherlands && !switzerland && <p>No country is selected in Search settings, so there is nowhere to search.</p>}
        {netherlands && <>
          <label htmlFor="indeed-nl-place">Netherlands place</label>
          <input id="indeed-nl-place" value={draft.nlLocation} disabled={!draftReady || saving}
            onChange={(event) => editDraft({ nlLocation: event.target.value })} placeholder="Amsterdam, Netherlands" />
          <label htmlFor="indeed-nl-radius">Netherlands distance (km)</label>
          <input id="indeed-nl-radius" type="number" min={0} max={800} step={1} value={draft.nlRadiusKm} disabled={!draftReady || saving}
            onChange={(event) => editDraft({ nlRadiusKm: event.target.value })} />
        </>}
        {switzerland && <>
          <label htmlFor="indeed-ch-place">Switzerland place</label>
          <input id="indeed-ch-place" value={draft.chLocation} disabled={!draftReady || saving}
            onChange={(event) => editDraft({ chLocation: event.target.value })} placeholder="Switzerland" />
          <label htmlFor="indeed-ch-radius">Switzerland distance (km)</label>
          <input id="indeed-ch-radius" type="number" min={0} max={800} step={1} value={draft.chRadiusKm} disabled={!draftReady || saving}
            onChange={(event) => editDraft({ chRadiusKm: event.target.value })} />
        </>}
        {!draftReady && <p>Loading saved settings…</p>}
        <button className="jobs-button" type="submit" disabled={saving || !draftReady}>{saving ? 'Saving…' : 'Save Indeed settings'}</button>
        {feedback && <p role="status">{feedback}</p>}
      </fieldset>
    </form>

    <div>
      <b>Latest Indeed run{runStartedAt ? ` · ${formatDate(runStartedAt)}` : ''}</b>
      {runSources.length === 0 && <p>No Indeed search has run in this account yet.</p>}
      {runSources.map((source) => <div key={`${source.sourceKey}-${source.country}`}>
        <b>{source.sourceName}</b> <span>{sourceRunStatusLabel(source.status)}</span>
        <span> · returned {source.foundCount} · new {source.newCount} · known {source.knownCount} · matched {source.matchedCount ?? 'unknown'}</span>
        {source.message && <p>{source.message}</p>}
      </div>)}
    </div>

    <div>
      <b>Coverage</b>
      {!overview && <p>Check readiness to see per-query coverage.</p>}
      {overview && coverage.length === 0 && <p>No check yet — the first search looks back seven days.</p>}
      {coverage.map((entry) => <p key={`${entry.country}-${entry.role}`}>
        “{entry.role}” · {entry.country === 'NL' ? 'Netherlands' : 'Switzerland'} · {entry.location} · {entry.radiusMiles} mi
        {entry.status === 'complete' && entry.coveredThroughMs > 0
          ? ` · covered through ${formatDate(new Date(entry.coveredThroughMs).toISOString())}; the next refresh continues from there`
          : ' · incomplete — the next refresh retries the same window'}
        {entry.lastSuccess && ` · last success ${formatDate(entry.lastSuccess)}`}
      </p>)}
    </div>

    {/* UX-6f: a bare button renders the 16px browser default (off the type ladder)
        at 24px tall (under the 44px tap floor). Search actions use the shared
        pill so this one does too. The parent ignores repeat clicks while busy,
        and the disabled state below covers the round trip. */}
    <button className="jobs-button" type="button" disabled={busy || searchDisabled} onClick={search}>Search Indeed only</button>
  </div>;
}
