import assert from 'node:assert/strict';
import test from 'node:test';
import { jobSourceAdapters } from '../lib/job-adapters';
import {
  ELA_ATTRIBUTION,
  EURES_SOURCE_KEYS,
  isEuresJob,
  needsElaAttribution,
} from '../lib/attribution';

test('every EURES adapter key is covered by the attribution rule', () => {
  const euresAdapters = jobSourceAdapters
    .filter((adapter) => adapter.key.startsWith('eures'))
    .map((adapter) => adapter.key);
  assert.ok(euresAdapters.length > 0, 'expected at least one EURES adapter');
  for (const key of euresAdapters) {
    assert.ok(
      (EURES_SOURCE_KEYS as readonly string[]).includes(key),
      `${key} is a EURES adapter but is not in EURES_SOURCE_KEYS, so its jobs would be shown uncredited`,
    );
  }
});

test('the credit names the European Labour Authority, not the EU generally', () => {
  assert.match(ELA_ATTRIBUTION, /European Labour Authority/);
  assert.match(ELA_ATTRIBUTION, /\bELA\b/);
});

test('attribution is required as soon as one EURES job is on screen', () => {
  assert.equal(isEuresJob({ sourceKey: 'eures-nl' }), true);
  assert.equal(isEuresJob({ sourceKey: 'adzuna.nl' }), false);
  assert.equal(needsElaAttribution([{ sourceKey: 'adzuna.nl' }]), false);
  assert.equal(
    needsElaAttribution([{ sourceKey: 'adzuna.nl' }, { sourceKey: 'eures-ch' }]),
    true,
  );
  assert.equal(needsElaAttribution([]), false);
});
