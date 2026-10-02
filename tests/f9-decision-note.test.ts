import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { jobSourceAdapters } from '../lib/job-adapters';
import type { AggregatorCredentials } from '../lib/job-aggregators';

const NOTE_URL = new URL('../docs/F9_DECISION_NOTE.md', import.meta.url);

/**
 * T26 — the F9 decision note is paperwork only: no accounts, keys,
 * collection, adapters, schedules, or branding. These checks pin that:
 * the note covers all five ideas as deferred/parked with the owner
 * decision outstanding, and the registry still has no Jooble/Apify
 * adapter to show for it.
 */
test('the F9 decision note covers all five ideas with no decision made', async () => {
  const note = await readFile(NOTE_URL, 'utf8');
  for (const idea of ['Jooble', 'Apify', 'alerts', 'Branding', 'VPN']) {
    assert.match(note, new RegExp(idea, 'i'), `the note must assess ${idea}`);
  }
  assert.match(note, /DEFERRED|PARKED/, 'every idea must be deferred or parked, not approved');
  assert.match(note, /no owner\s+decision has been made/i);
  assert.match(note, /No accounts were created, no API keys were obtained, no collection was\s+run/i);
  assert.match(note, /No purchase/i, 'no provider purchase may follow automatically');
});

test('no Jooble or Apify adapter was added alongside the note', () => {
  const added = jobSourceAdapters.filter((adapter) => /jooble|apify/i.test(adapter.key));
  assert.deepEqual(added.map((adapter) => adapter.key), [],
    'T26 adds a decision note, not an integration');
});

test('no Jooble or Apify credentials were added to the aggregator surface', async () => {
  const source = await readFile(new URL('../lib/job-aggregators.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /jooble|apify/i,
    'no key field may appear before the owner registers one');
  const credentials: AggregatorCredentials = {};
  assert.deepEqual(Object.keys(credentials), []);
});
