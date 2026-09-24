'use client';

import { useState, type FormEvent } from 'react';

type Mode = 'login' | 'register' | 'forgot';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setNeedsVerification(false);
    try {
      if (mode === 'forgot') {
        const response = await fetch('/api/auth/password-reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error || 'Could not request a reset.');
        // Deliberately the same either way: the endpoint never says whether the address exists.
        setMessage('If that address is registered, a reset link is on its way. It works once and expires in 1 hour.');
        setBusy(false);
        return;
      }
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, action: mode }),
      });
      const body = await response.json() as {
        error?: string; claimedLegacyWorkspace?: boolean; verificationRequired?: boolean;
        verificationEmailSent?: boolean; needsVerification?: boolean;
      };
      if (!response.ok) {
        if (body.needsVerification) setNeedsVerification(true);
        throw new Error(body.error || 'Could not sign in.');
      }
      if (body.verificationRequired) {
        setMessage(body.verificationEmailSent
          ? 'Account created. Check your email for a verification link, then sign in.'
          : 'Account created but the verification email could not be sent. Contact the installation owner for help signing in.');
        setBusy(false);
        return;
      }
      // Full reload so the server renders the dashboard with the new session.
      window.location.href = '/';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not resend the email.');
      setMessage('If that address is registered and unconfirmed, a new link is on its way.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not resend the email.');
    }
    setBusy(false);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setMessage('');
    setNeedsVerification(false);
  }

  return (
    <main className="shell">
      <section className="login-wrap">
        <div className="login-card">
          <span className="brand-mark">I</span>
          <h1>Ik ben een appel</h1>
          <p className="login-tagline">An English job-search filter for people who do not speak Dutch.</p>
          <p className="login-sub">
            {mode === 'login'
              ? 'Sign in to your job workspace.'
              : mode === 'register'
                ? 'Create an account. Your saved jobs and search settings are kept privately for you and are not visible to other users.'
                : 'Enter your address and a reset link will be sent if it is registered.'}
          </p>
          <form onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} autoComplete="username" required
                onChange={(event) => setEmail(event.target.value)} />
            </label>
            {mode !== 'forgot' && <label className="field">
              <span>Password</span>
              <input type="password" value={password} required minLength={12}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                onChange={(event) => setPassword(event.target.value)} />
            </label>}
            {mode === 'register' && <>
              <p className="login-hint">At least 12 characters. Length matters more than symbols. You will confirm this address by email before signing in.</p>
              <label className="consent">
                <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
                <span>
                  I understand that anything I put into this service is at my own risk. It is
                  provided as is, with no warranty and no liability for any loss, disclosure or
                  misuse of the data I choose to share, including in the event of a security
                  breach. I have read the{' '}
                  <a href="/privacy" target="_blank" rel="noreferrer">privacy notice</a>.
                </span>
              </label>
            </>}
            <button className="ink-submit" type="submit" disabled={busy || (mode === 'register' && !accepted)}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}
            </button>
            <p className="form-message" aria-live="polite">{message}</p>
          </form>
          {needsVerification && <button className="login-switch" type="button" onClick={resendVerification} disabled={busy}>
            Resend the verification email
          </button>}
          <button className="login-switch" type="button"
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}
          </button>
          {mode !== 'forgot' && <button className="login-switch" type="button" onClick={() => switchMode('forgot')}>
            Forgot your password?
          </button>}
        </div>
        <p className="login-foot">
          Your searches and saved jobs stay on this server and are never sent to any job site.{' '}
          <a href="/sources">Where the jobs come from →</a>
        </p>
      </section>
    </main>
  );
}
