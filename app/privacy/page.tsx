import { cookieNotice, dataWeHold, notCollected, PRIVACY_UPDATED_ON, privacyHeadline, privacySummary,
  visitCounting, whereDataLives, yourRights } from '@/lib/privacy-policy';

export const metadata = {
  title: 'Privacy — Ik ben een appel',
  description: 'What Ik ben een appel stores, why, how long, and the rights you have over it.',
};

export default function PrivacyPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/"><span className="brand-mark">I</span><span><b>Ik ben een appel</b><small>Privacy</small></span></a>
        <nav aria-label="Main navigation"><a href="/sources">Sources</a><a href="/">Back to the radar</a></nav>
        <span className="source-pill"><i /> Updated {PRIVACY_UPDATED_ON}</span>
      </header>

      <section className="policy-intro">
        <span className="eyebrow">Privacy and GDPR</span>
        <h1>{privacyHeadline.lead}<br /><em>{privacyHeadline.emphasis}</em></h1>
        <p>{privacySummary}</p>
      </section>

      <section className="policy-principles">
        <h2>What is never collected</h2>
        <ul>{notCollected.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>

      <section className="policy-group">
        <div className="policy-group-head">
          <h2>What is stored, and why</h2>
          <p>Each row is data held about you, the reason it exists, the lawful basis under the GDPR, and how long it stays.</p>
        </div>
        <div className="policy-list">
          {dataWeHold.map((item) => (
            <article className="policy-card intended-use" key={item.what}>
              <div className="policy-card-head"><h3>{item.what}</h3></div>
              <dl>
                <dt>Why</dt><dd>{item.why}</dd>
                <dt>Lawful basis</dt><dd>{item.legalBasis}</dd>
                <dt>Kept for</dt><dd>{item.kept}</dd>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="policy-group">
        <div className="policy-group-head">
          <h2>Cookies</h2>
          <p>{cookieNotice.summary}</p>
        </div>
        <div className="policy-list">
          {cookieNotice.detail.map((cookie) => (
            <article className="policy-card intended-use" key={cookie.name}>
              <div className="policy-card-head">
                <h3>{cookie.name}</h3>
                <span className="policy-badge intended-use">{cookie.type}</span>
              </div>
              <dl>
                <dt>Purpose</dt><dd>{cookie.purpose}</dd>
                <dt>Expires</dt><dd>{cookie.expiry}</dd>
              </dl>
            </article>
          ))}
        </div>
        <p className="policy-note">{cookieNotice.why}</p>
      </section>

      <section className="policy-group">
        <div className="policy-group-head">
          <h2>How visits are counted</h2>
          <p>There is no analytics provider, no tracking cookie, and no visitor profile.</p>
        </div>
        <ul className="plain-list">{visitCounting.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>

      <section className="policy-group">
        <div className="policy-group-head">
          <h2>Your rights</h2>
          <p>The GDPR gives you these rights. Each one is available directly in the app rather than by request.</p>
        </div>
        <div className="policy-list">
          {yourRights.map((item) => (
            <article className="policy-card intended-use" key={item.right}>
              <div className="policy-card-head"><h3>{item.right}</h3></div>
              <dl><dt>How</dt><dd>{item.how}</dd></dl>
            </article>
          ))}
        </div>
      </section>

      <section className="policy-group">
        <div className="policy-group-head">
          <h2>Where the data lives, and who can see it</h2>
        </div>
        <ul className="plain-list">
          {whereDataLives.map((line) => <li key={line}>{line}</li>)}
          <li>The full list of sources is on the <a href="/sources">sources page</a>.</li>
        </ul>
      </section>

      <footer>
        <b>Ik ben een appel</b>
        <span>No tracking · no profiling · no data sold</span>
        <a href="/sources">Where the jobs come from →</a>
      </footer>
    </main>
  );
}
