'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface AdminUser {
  id: string; email: string; role: 'admin' | 'user'; status: 'active' | 'disabled';
  createdAt: string; lastSeenAt: string; jobCount: number; cvCount: number;
}
interface Overview {
  users: AdminUser[];
  visits: { day: string; totalVisits: number; uniqueVisitors: number }[];
  totals: { users: number; admins: number; jobs: number };
  signupsOpen: boolean;
}

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');

  const [reloadToken, setReloadToken] = useState(0);
  const load = () => setReloadToken((token) => token + 1);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin')
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 401) { window.location.href = '/login'; return; }
        if (response.status === 403) { setMessage('Administrator access required.'); return; }
        setData(await response.json() as Overview);
      })
      .catch(() => { if (!cancelled) setMessage('Could not load the overview.'); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  async function act(userId: string, action: string, extra: Record<string, string> = {}) {
    setBusy(userId);
    setMessage('');
    try {
      const response = await fetch('/api/admin', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, action, ...extra }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'That action failed.');
      load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That action failed.');
    } finally {
      setBusy('');
    }
  }

  async function removeUser(user: AdminUser) {
    const typed = window.prompt(`Delete ${user.email} and everything they own? Type DELETE to confirm.`);
    if (typed !== 'DELETE') return;
    setBusy(user.id);
    try {
      const response = await fetch('/api/admin', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: user.id, confirm: 'DELETE' }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not delete that account.');
      load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete that account.');
    } finally {
      setBusy('');
    }
  }

  async function resetPassword(user: AdminUser) {
    // There is no mail sender, so a reset is a new password handed over directly. The recipient
    // can change it themselves from Settings afterwards.
    const next = window.prompt(`Set a new password for ${user.email} (at least 12 characters).`);
    if (!next) return;
    await act(user.id, 'set-password', { newPassword: next });
    setMessage(`Password updated for ${user.email}. Share it with them directly; they can change it in Settings.`);
  }

  const peak = Math.max(1, ...(data?.visits ?? []).map((day) => day.totalVisits));

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">I</span><span><b>Ik Engels</b><small>System manager</small></span></Link>
        <nav aria-label="Main navigation"><Link href="/">Radar</Link><Link href="/settings">Settings</Link></nav>
        <span className="source-pill"><i /> {data ? `${data.totals.users} accounts` : 'Loading…'}</span>
      </header>

      <section className="policy-intro">
        <span className="eyebrow">Administrator</span>
        <h1>System manager</h1>
        <p>
          Accounts, and how much the site is used. Account holders&apos; CV text and job lists are not
          readable from here by design — only counts are shown.
        </p>
        <p className="form-message" aria-live="polite">{message}</p>
      </section>

      {data && <>
        <section className="policy-group">
          <div className="policy-group-head">
            <h2>Visits</h2>
            <p>
              Daily totals and distinct visitors. No cookie, no IP stored, and the de-duplication
              marker changes every day so visits cannot be linked across days.
            </p>
          </div>
          {!data.visits.length && <p className="settings-hint">No visits recorded yet.</p>}
          <div className="visit-chart">
            {[...data.visits].reverse().map((day) => (
              <div className="visit-bar" key={day.day} title={`${day.day}: ${day.totalVisits} visits, ${day.uniqueVisitors} unique`}>
                <span className="visit-total" style={{ height: `${(day.totalVisits / peak) * 100}%` }} />
                <span className="visit-unique" style={{ height: `${(day.uniqueVisitors / peak) * 100}%` }} />
                <small>{day.day.slice(5)}</small>
              </div>
            ))}
          </div>
          <p className="settings-hint">Solid bar: total visits. Inner bar: distinct visitors.</p>
        </section>

        <section className="policy-group">
          <div className="policy-group-head">
            <h2>Accounts</h2>
            <p>
              {data.totals.users} account{data.totals.users === 1 ? '' : 's'}, {data.totals.admins} administrator
              {data.totals.admins === 1 ? '' : 's'}, {data.totals.jobs} jobs stored in total.
              Registration is currently <b>{data.signupsOpen ? 'open to anyone' : 'closed'}</b>
              {data.signupsOpen ? ' — set ALLOW_SIGNUPS=false to close it.' : '.'}
            </p>
          </div>
          <div className="admin-table">
            {data.users.map((user) => (
              <article className={`admin-row ${user.status}`} key={user.id}>
                <div className="admin-who">
                  <b>{user.email}</b>
                  <span>
                    {user.role === 'admin' ? 'Administrator' : 'User'} · {user.status}
                    {' · '}{user.jobCount} jobs · {user.cvCount} CVs
                  </span>
                </div>
                <div className="admin-actions">
                  {user.status === 'active'
                    ? <button type="button" disabled={busy === user.id} onClick={() => act(user.id, 'disable')}>Disable</button>
                    : <button type="button" disabled={busy === user.id} onClick={() => act(user.id, 'enable')}>Enable</button>}
                  {user.role === 'admin'
                    ? <button type="button" disabled={busy === user.id} onClick={() => act(user.id, 'demote')}>Make user</button>
                    : <button type="button" disabled={busy === user.id} onClick={() => act(user.id, 'promote')}>Make admin</button>}
                  <button type="button" disabled={busy === user.id} onClick={() => resetPassword(user)}>Reset password</button>
                  <button type="button" className="danger" disabled={busy === user.id} onClick={() => removeUser(user)}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </>}

      <footer>
        <b>Ik Engels</b>
        <span>Counts only · no access to anyone&apos;s CV or job list</span>
        <Link href="/privacy">Privacy</Link>
      </footer>
    </main>
  );
}
