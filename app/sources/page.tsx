import Link from 'next/link';
import { atsCompanies } from '@/lib/ats-feeds';
import { collectionPrinciples, POLICIES_VERIFIED_ON, sourcePolicies, stanceLabel } from '@/lib/source-policies';

export const metadata = {
  title: 'Where the jobs come from — Ik Engels',
  description: 'Every site this app reads, what it collects, and how that sits against each site\'s own rules.',
};

const groups = ['Authorized APIs', 'Page-fetched sites', 'Not used'] as const;

const groupBlurb: Record<(typeof groups)[number], string> = {
  'Authorized APIs': 'Official or keyed interfaces, used the way they are published. These run in the default search and need no VPN.',
  'Page-fetched sites': 'Public web pages read as HTML. These run only under the explicit "Search all" action, and the position on each one is stated plainly below.',
  'Not used': 'Sources deliberately left alone, and why. They appear in the app marked blocked or unavailable so an empty result is never mistaken for "no jobs found".',
};

export default function SourcesPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">I</span><span><b>Ik Engels</b><small>Where the jobs come from</small></span></Link>
        <nav aria-label="Main navigation"><Link href="/">Back to the radar</Link></nav>
        <span className="source-pill"><i /> Checked {POLICIES_VERIFIED_ON}</span>
      </header>

      <section className="policy-intro">
        <span className="eyebrow">Transparency</span>
        <h1>Where the jobs<br /><em>come from.</em></h1>
        <p>
          This app gathers public job advertisements from the sources below. This page records what is
          taken from each one and how that sits against that site&apos;s own published rules — including
          the places where it does not comply. Everything here was checked against the live robots.txt
          or terms on {POLICIES_VERIFIED_ON}. Sites change their rules without notice, so treat this as
          a record of that date rather than a standing guarantee.
        </p>
      </section>

      <section className="policy-principles">
        <h2>How collection is limited</h2>
        <ul>{collectionPrinciples.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>

      {groups.map((group) => (
        <section className="policy-group" key={group}>
          <div className="policy-group-head">
            <h2>{group}</h2>
            <p>{groupBlurb[group]}</p>
          </div>
          <div className="policy-list">
            {sourcePolicies.filter((policy) => policy.group === group).map((policy) => (
              <article className={`policy-card ${policy.stance}`} key={policy.name}>
                <div className="policy-card-head">
                  <h3>{policy.name}</h3>
                  <span className={`policy-badge ${policy.stance}`}>{stanceLabel[policy.stance]}</span>
                </div>
                <dl>
                  <dt>What is collected</dt><dd>{policy.collected}</dd>
                  <dt>What their rules say</dt><dd>{policy.theirRules}</dd>
                  <dt>Where this app stands</dt><dd>{policy.ourPosition}</dd>
                </dl>
                {policy.link && <a href={policy.link} target="_blank" rel="noreferrer">Their published rules ↗</a>}
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className="policy-group">
        <div className="policy-group-head">
          <h2>Company career boards read</h2>
          <p>
            The {atsCompanies.length} employers whose public job boards are read directly. Each publishes
            an open endpoint intended for job boards and aggregators to consume.
          </p>
        </div>
        <ul className="company-grid">
          {[...atsCompanies].sort((a, b) => a.name.localeCompare(b.name)).map((company) => (
            <li key={`${company.platform}:${company.slug}`}>
              <b>{company.name}</b>
              <span>{company.platform}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer>
        <b>Ik Engels</b>
        <span>Public advertisements only · no logins · no detection evasion</span>
        <Link href="/">Back to the radar</Link>
      </footer>
    </main>
  );
}
