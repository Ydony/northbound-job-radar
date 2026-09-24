'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState('');
  // Turnstile bot protection (#171) renders only for registration. The sitekey is public; the
  // resulting token is verified server-side before any account is created.
  const [sitekey, setSitekey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileError, setTurnstileError] = useState('');
  const widgetHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== 'register') return;
    let cancelled = false;
    fetch('/api/turnstile')
      .then((response) => response.json())
      .then((body: unknown) => {
        if (cancelled) return;
        const served = (body as { sitekey?: unknown } | null)?.sitekey;
        if (typeof served === 'string' && served.length > 0) setSitekey(served);
        else setTurnstileError('The bot check could not load. Reload and try again.');
      })
      .catch(() => {
        if (!cancelled) setTurnstileError('The bot check could not load. Reload and try again.');
      });
    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'register' || sitekey === '' || !widgetHost.current) return;
    let cancelled = false;
    let widgetId: string | null = null;
    const started = Date.now();
    // The loader script is emitted server-side with the request nonce (see app/login/layout.tsx);
    // poll briefly for it rather than assuming it already ran.
    const timer = setInterval(() => {
      if (cancelled) return;
      if (window.turnstile && widgetHost.current && widgetId === null) {
        clearInterval(timer);
        widgetId = window.turnstile.render(widgetHost.current, {
          sitekey,
          callback: (token) => { if (!cancelled) setTurnstileToken(token); },
          'expired-callback': () => { if (!cancelled) setTurnstileToken(''); },
          'error-callback': () => {
            if (!cancelled) {
              setTurnstileToken('');
              setTurnstileError('The bot check failed to load. Reload and try again.');
            }
          },
        });
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        if (!cancelled && widgetId === null) {
          setTurnstileError('The bot check could not load. Reload and try again.');
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (widgetId !== null && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // The widget is already gone; nothing to clean up.
        }
      }
    };
  }, [mode, sitekey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'register' && turnstileError === '' && (sitekey === '' || turnstileToken === '')) {
      setMessage('Wait for the bot check to finish, then try again.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          action: mode,
          turnstileToken: mode === 'register' ? turnstileToken : undefined,
        }),
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

  const turnstilePending = mode === 'register' && turnstileError === ''
    && (sitekey === '' || turnstileToken === '');

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
              : 'Create an account. Your saved jobs and search settings are kept privately for you and are not visible to other users.'}
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
            {mode === 'register' && <>
              <p className="login-hint">At least 12 characters. Length matters more than symbols.</p>
              <div ref={widgetHost} />
              {turnstileError !== '' && <p className="form-message" aria-live="polite">{turnstileError}</p>}
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
            <button className="ink-submit" type="submit" disabled={busy || (mode === 'register' && (!accepted || turnstilePending))}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
            <p className="form-message" aria-live="polite">{message}</p>
          </form>
          <button className="login-switch" type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setMessage('');
              setSitekey('');
              setTurnstileToken('');
              setTurnstileError('');
            }}>
            {mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}
          </button>
        </div>
        <p className="login-foot">
          Your searches and saved jobs stay on this server and are never sent to any job site.{' '}
          <a href="/sources">Where the jobs come from →</a>
        </p>
      </section>
    </main>
  );
}
