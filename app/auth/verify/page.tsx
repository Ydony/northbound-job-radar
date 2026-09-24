'use client';

import { useEffect, useState } from 'react';

function tokenFromSearch() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

/** Landing page for the emailed verification link. The token is single-use: confirm once, then sign in. */
export default function VerifyPage() {
  const [token] = useState(tokenFromSearch);
  const [message, setMessage] = useState(token ? 'Confirming your address…' : 'This link is invalid or has expired.');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error || 'This link is invalid or has expired.');
        window.location.href = '/';
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'This link is invalid or has expired.');
      });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <main className="shell">
      <section className="login-wrap">
        <div className="login-card">
          <span className="brand-mark">I</span>
          <h1>Ik ben een appel</h1>
          <p className="login-sub" aria-live="polite">{message}</p>
          <a className="login-switch" href="/login">Back to sign in</a>
        </div>
      </section>
    </main>
  );
}
