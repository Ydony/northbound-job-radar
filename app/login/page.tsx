'use client';

import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, action: mode }),
      });
      const body = await response.json() as { error?: string; claimedLegacyWorkspace?: boolean };
      if (!response.ok) throw new Error(body.error || 'Could not sign in.');
      // Full reload so the server renders the dashboard with the new session.
      window.location.href = '/';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="login-wrap">
        <div className="login-card">
          <span className="brand-mark">I</span>
          <h1>Ik Engels</h1>
          <p className="login-sub">
            {mode === 'login'
              ? 'Sign in to your job workspace.'
              : 'Create an account. The first account on a new installation becomes the administrator.'}
          </p>
          <form onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} autoComplete="username" required
                onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} required minLength={12}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                onChange={(event) => setPassword(event.target.value)} />
            </label>
            {mode === 'register' && <p className="login-hint">At least 12 characters. Length matters more than symbols.</p>}
            <button className="search-button" type="submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
            <p className="form-message" aria-live="polite">{message}</p>
          </form>
          <button className="login-switch" type="button"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setMessage(''); }}>
            {mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}
          </button>
        </div>
        <p className="login-foot">
          Your CV stays on this server and is never sent to any job site.{' '}
          <a href="/sources">Where the jobs come from →</a>
        </p>
      </section>
    </main>
  );
}
