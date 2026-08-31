import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLanguage } from '../lib/analysis';
import { euresJobToParsedJob } from '../lib/eures';
import { stripHtml } from '../lib/jobsch';

// A real-shaped EURES record: the portal shows "Working languages: Dutch" for this, and the
// advertisement never once asks for Dutch.
const dutchFlaggedEnglishJob = {
  id: 'abc123',
  title: 'Data Analyst Operations',
  description: [
    '<p>We are looking for a data analyst to join our operations team in Amsterdam.</p>',
    '<ul><li>Analyse operational data and build reporting</li>',
    '<li>Work with stakeholders across the business</li>',
    '<li>Experience with SQL and Power BI</li></ul>',
    '<p>You will report to the head of operations. The working language of the team is English,',
    'and all documentation and meetings are in English. We offer a permanent contract, flexible',
    'hours and a training budget. Applications are reviewed weekly and we respond to every',
    'candidate within ten working days. Our customers are international businesses and the role',
    'involves regular contact with them across several countries in Europe and beyond.</p>',
    // Long enough to clear MIN_CHARS_TO_CONFIRM_ENGLISH. A shorter fixture returns `unknown`,
    // which is correct behaviour but would test the length gate rather than the point at issue.
    '<p>The operations team owns the reporting that the business runs on, from daily dashboards',
    'through to the monthly review pack. You will own a portion of that directly and be expected',
    'to improve it rather than only maintain it. We care more about clear thinking and careful',
    'work than about any particular tool, and we will support you in learning whatever the role',
    'turns out to need. The company has grown steadily for eight years and the team has grown',
    'with it, so there is room to take on more responsibility as you go.</p>',
  ].join(' '),
  creationDate: 1786800601812,
  employer: { name: 'Example BV' },
  locationMap: { NL: ['NL32B'] },
  availableLanguages: ['nl'],
};

test('carries the advertisement language through without letting it decide anything', () => {
  const parsed = euresJobToParsedJob(dutchFlaggedEnglishJob, 'Netherlands');
  assert.ok(parsed);
  // Kept for display and debugging...
  assert.deepEqual(parsed.adLanguages, ['nl']);

  // ...but the verdict comes from the advertisement, which never asks for Dutch. Trusting the
  // portal's "Working languages: Dutch" instead would discard 44% of the Netherlands results,
  // measured against 50 live listings - including full-length ads that are genuine matches.
  const verdict = analyzeLanguage(stripHtml(parsed.descriptionHtml), parsed.title);
  assert.equal(verdict.status, 'pass');
});

test('maps the EURES record onto the shared job shape', () => {
  const parsed = euresJobToParsedJob(dutchFlaggedEnglishJob, 'Netherlands');
  assert.ok(parsed);
  assert.equal(parsed.title, 'Data Analyst Operations');
  assert.equal(parsed.company, 'Example BV');
  // The NUTS code is resolved to its name at ingest: NL32B is Groot-Amsterdam. Stored raw it
  // would surface as "NL32B" on the card and in the location facet, which helps nobody.
  assert.equal(parsed.location, 'Groot-Amsterdam');
  assert.match(parsed.sourceUrl, /europa\.eu\/eures\/portal\/jv-se\/jv-details\/abc123/);
  assert.equal(parsed.postedAt.slice(0, 4), '2026');
});

test('refuses a record with no usable advertisement', () => {
  assert.equal(euresJobToParsedJob({ id: 'x', title: '', description: 'body' }, 'Netherlands'), null);
  assert.equal(euresJobToParsedJob({ id: 'x', title: 'Role', description: '' }, 'Netherlands'), null);
});
