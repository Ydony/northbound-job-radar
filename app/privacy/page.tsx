import { cookieNotice, dataWeHold, notCollected, PRIVACY_UPDATED_ON, visitCounting, yourRights } from '@/lib/privacy-policy';

export const metadata = {
  title: 'Privacy — Ik Engels',
  description: 'What Ik Engels stores, why, how long, and the rights you have over it.',
};

export default function PrivacyPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/"><span className="brand-mark">I</span><span><b>Ik Engels</b><small>Privacy</small></span></a>
        <nav aria-label="Main navigation"><a href="/sources">Sources</a><a href="/">Back to the radar</a></nav>
        <span className="source-pill"><i /> Updated {PRIVACY_UPDATED_ON}</span>
      </header>

      <section className="policy-intro">
        <span className="eyebrow">Privacy and GDPR</span>
        <h1>Your CV stays<br /><em>yours.</em></h1>
        <p>
          This page describes exactly what is stored, why, how long it is kept, and what you can do
          about it. It is written from what the software actually does rather than from a template.
          If you only read one line: your CV is never sent to any job site, aggregator, or AI service,
          and nothing about you is sold or shared.
        </p>
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
          <li>Data is stored in Cloudflare D1 (database) and R2 (your CV file). Cloudflare acts as a processor and is the only third party involved in hosting.</li>
          <li>Administrators of this installation can see that an account exists, its email address, and how many jobs and CVs it holds. They cannot read your CV text or your job list.</li>
          <li>Job searches send only your role keywords and location to the job sources listed on the <a href="/sources">sources page</a>. They never receive your CV, your email, or anything identifying you.</li>
          <li>There is no automated decision-making that produces legal or similarly significant effects. The language and fit scores are suggestions for you to review, and you can correct any of them.</li>
        </ul>
      </section>

      <footer>
        <b>Ik Engels</b>
        <span>No tracking · no profiling · no data sold</span>
        <a href="/sources">Where the jobs come from →</a>
      </footer>
    </main>
  );
}
