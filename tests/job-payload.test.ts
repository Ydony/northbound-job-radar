import assert from 'node:assert/strict';
import test from 'node:test';
import { jobFromRow } from '../lib/server-data';
import { defaultSearchCriteria } from '../lib/criteria';
import type { SearchCriteria } from '../lib/types';

/**
 * What may leave the server, checked against the mapper's actual output rather than by reading it.
 *
 * `docs/SOURCE_POLICY.md` §1 separates two permissions the app used to conflate: reading a source
 * is governed by its robots.txt, terms and licence, and every public source is settled there.
 * Republishing what was read is governed by who wrote it — and a job advertisement is written by
 * the employer, not by the source and not by us. So the text is fetched, screened, and stops.
 *
 * These tests serialise a real row through `jobFromRow` and assert the employer's words are not
 * in the result, in any field. A type-level guard would not catch a field added later that
 * happens to carry the text.
 */

const AD_TEXT = [
  'We are looking for a data governance analyst to own our reporting stack.',
  'Requirements',
  '- Five years with SAP and Power BI',
  '- Comfortable presenting to senior stakeholders',
  '- Willing to travel to Zurich monthly',
  '',
  'We offer a permanent contract and a generous training budget.',
].join('\n');

/** A distinctive phrase that exists nowhere except the advertisement. */
const GIVEAWAY = 'generous training budget';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    source_url: 'https://example.test/jobs/1',
    canonical_url: 'https://example.test/jobs/1',
    source_key: 'eures-nl',
    source_name: 'EURES Netherlands',
    source_job_id: '1',
    country: 'netherlands' as const,
    title: 'Data Governance Analyst',
    company: 'Example BV',
    location: 'Amsterdam',
    description: AD_TEXT,
    language_status: 'pass' as const,
    language_summary: 'English advertisement with no local-language requirement detected.',
    language_signals: '[]',
    workplace_type: 'unknown' as const,
    identity_fingerprint: 'fp',
    cluster_key: 'ck',
    duplicate_of: '',
    is_saved: 0,
    application_status: 'not_applied' as const,
    visibility_status: 'active' as const,
    posted_at: '2026-09-01T00:00:00Z',
    expires_at: '',
    first_seen_at: '2026-09-01T00:00:00Z',
    last_seen_at: '2026-09-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

const criteria = (over: Partial<SearchCriteria> = {}): SearchCriteria =>
  ({ ...defaultSearchCriteria, ...over });

test('the employer advertisement text appears nowhere in what a client receives', () => {
  const payload = JSON.stringify(jobFromRow(row(), criteria()));
  assert.ok(!payload.includes(GIVEAWAY),
    'the advertisement text reached the client payload — see docs/SOURCE_POLICY.md §1');
  assert.ok(!payload.includes('We are looking for a data governance analyst'),
    'the advertisement opening reached the client payload');
});

test('what replaces it is a fact and our own work', () => {
  const job = jobFromRow(row(), criteria());
  // A fact about the advertisement, not the advertisement: enough to tell a teaser from a full ad.
  assert.equal(job.descriptionLength, AD_TEXT.trim().length);
  // Our extraction. The bullets are the employer's words, which is the one thing §1 permits us to
  // show — a short, attributed quotation of the requirements, next to a link to the original.
  assert.ok(job.requirements, 'requirements were not extracted from an ad that states them');
  assert.match(job.requirements!.heading, /requirement/i);
  assert.ok(job.requirements!.items.length >= 2);
});

test('criteria are decided server-side, where the text still exists', () => {
  // "power bi" appears only in the advertisement body, never in the title or location — so a
  // client without the text could not have computed this, and a wrong answer here means the
  // filtering silently stopped working rather than visibly breaking.
  assert.equal(jobFromRow(row(), criteria({ requiredKeywords: ['power bi'] })).matchesCriteria, true);
  assert.equal(jobFromRow(row(), criteria({ requiredKeywords: ['kubernetes'] })).matchesCriteria, false);
  assert.equal(jobFromRow(row(), criteria({ excludedKeywords: ['sap'] })).matchesCriteria, false);
});

test('a job mapped without criteria matches, rather than vanishing', () => {
  // Callers that have no criteria to hand must not accidentally filter everything out.
  assert.equal(jobFromRow(row()).matchesCriteria, true);
});

test('a teaser reports its true length so the card can say why it has no requirements', () => {
  const teaser = 'Join our team in Amsterdam. Apply now.';
  const job = jobFromRow(row({ description: teaser }), criteria());
  assert.equal(job.descriptionLength, teaser.length);
  assert.equal(job.requirements, null);
});
