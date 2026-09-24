'use client';

import { useState, type FormEvent } from 'react';

function tokenFromSearch() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

/** Landing page for the emailed reset link. The token is single-use and expires in 1 hour. */
export default function ResetPage() {
  const [token] = useState(tokenFromSearch);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not set a new password.');
      setMessage('Your password is set. Sign in with it below.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not set a new password.');
    }
    setBusy(false);
  }

  return (
    <main className="shell">
      <section className="login-wrap">
        <div className="login-card">
          <span className="brand-mark">I</span>
          <h1>Ik ben een appel</h1>
          <p className="login-sub">Choose a new password. At least 12 characters — length matters more than symbols.</p>
          {token ? (
            <form onSubmit={submit}>
              <label className="field">
                <span>New password</span>
                <input type="password" value={password} required minLength={12} autoComplete="new-password"
                  onChange={(event) => setPassword(event.target.value)} />
              </label>
              <button className="ink-submit" type="submit" disabled={busy}>
                {busy ? 'Working…' : 'Set new password'}
              </button>
              <p className="form-message" aria-live="polite">{message}</p>
            </form>
          ) : (
            <p className="form-message" aria-live="polite">This link is invalid or has expired.</p>
          )}
          <a className="login-switch" href="/login">Back to sign in</a>
        </div>
      </section>
    </main>
  );
}
