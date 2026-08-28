'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

interface Account { email: string; role: 'admin' | 'user' }

export default function SettingsPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteMessage, setDeleteMessage] = useState('');

  useEffect(() => {
    fetch('/api/account')
      .then(async (response) => {
        if (response.status === 401) { window.location.href = '/login'; return; }
        const body = await response.json() as { account?: Account };
        if (body.account) { setAccount(body.account); setNewEmail(body.account.email); }
      })
      .catch(() => setMessage('Could not load your account.'));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const payload: Record<string, string> = { currentPassword };
      if (account && newEmail && newEmail !== account.email) payload.newEmail = newEmail;
      if (newPassword) payload.newPassword = newPassword;
      if (!payload.newEmail && !payload.newPassword) throw new Error('Change your email or password first.');
      const response = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not save.');
      setMessage('Saved. Your session has been refreshed.');
      setCurrentPassword('');
      setNewPassword('');
      if (payload.newEmail) setAccount({ ...account!, email: payload.newEmail });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(event: FormEvent) {
    event.preventDefault();
    setDeleteMessage('');
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE', currentPassword }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not delete the account.');
      window.location.href = '/login';
    } catch (error) {
      setDeleteMessage(error instanceof Error ? error.message : 'Could not delete the account.');
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">I</span><span><b>Ik Engels</b><small>Settings</small></span></Link>
        <nav aria-label="Main navigation">
          <Link href="/">Back to the radar</Link>
          {account?.role === 'admin' && <Link href="/admin">Admin</Link>}
        </nav>
        <span className="source-pill"><i /> {account ? account.email : 'Loading…'}</span>
      </header>

      <section className="policy-intro">
        <span className="eyebrow">Your account</span>
        <h1>Settings</h1>
        <p>
          Change how you sign in, or remove your account and everything in it. Your CVs, saved jobs
          and search criteria stay exactly as they are when you change your email or password.
        </p>
      </section>

      <section className="settings-grid">
        <form className="settings-card" onSubmit={save}>
          <h2>Email and password</h2>
          <p className="settings-hint">Your current password is required for either change.</p>
          <label className="field"><span>Email</span>
            <input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} required />
          </label>
          <label className="field"><span>New password (leave blank to keep)</span>
            <input type="password" value={newPassword} minLength={12} autoComplete="new-password"
              onChange={(event) => setNewPassword(event.target.value)} />
          </label>
          <label className="field"><span>Current password</span>
            <input type="password" value={currentPassword} required autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)} />
          </label>
          <button className="search-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          <p className="form-message" aria-live="polite">{message}</p>
        </form>

        <form className="settings-card danger" onSubmit={deleteAccount}>
          <h2>Delete this account</h2>
          <p className="settings-hint">
            Removes your account, both CVs and the stored files, every saved job, and all search
            settings. This is immediate and cannot be undone.
          </p>
          <label className="field"><span>Type DELETE to confirm</span>
            <input value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder="DELETE" />
          </label>
          <p className="settings-hint">Your current password above is also required.</p>
          <button className="delete-button wide" type="submit" disabled={deleteConfirm !== 'DELETE' || !currentPassword}>
            Delete my account permanently
          </button>
          <p className="form-message" aria-live="polite">{deleteMessage}</p>
        </form>
      </section>

      <footer>
        <b>Ik Engels</b>
        <span>Your CV is never sent to a job site</span>
        <Link href="/privacy">Privacy</Link>
      </footer>
    </main>
  );
}
