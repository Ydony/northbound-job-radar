import assert from 'node:assert/strict';
import test from 'node:test';
import { jobSourceAdapters } from '../lib/job-adapters';
import {
  ADZUNA_ATTRIBUTION,
  ADZUNA_LOCAL_LINKS,
  ADZUNA_SOURCE_KEYS,
  ELA_ATTRIBUTION,
  EURES_SOURCE_KEYS,
  adzunaSourcesOnScreen,
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

test('Adzuna private research is acknowledged by the required name and local domains', () => {
  const storedAdzunaKeys = jobSourceAdapters
    .filter((adapter) => adapter.key.startsWith('adzuna-'))
    .flatMap((adapter) => adapter.resultSourceKeys ?? [])
    .sort();
  assert.match(ADZUNA_ATTRIBUTION, /The Adzuna API/);
  assert.deepEqual([...ADZUNA_SOURCE_KEYS].sort(), storedAdzunaKeys,
    'an Adzuna result host could be displayed without the required acknowledgement');
  assert.equal(ADZUNA_LOCAL_LINKS['adzuna.ch'], 'https://www.adzuna.ch/');
  assert.equal(ADZUNA_LOCAL_LINKS['adzuna.nl'], 'https://www.adzuna.nl/');
  assert.deepEqual(adzunaSourcesOnScreen([
    { sourceKey: 'eures-nl' },
    { sourceKey: 'adzuna.nl' },
    { sourceKey: 'adzuna.nl' },
    { sourceKey: 'adzuna.ch' },
  ]), ['adzuna.ch', 'adzuna.nl']);
  assert.deepEqual(adzunaSourcesOnScreen([{ sourceKey: 'eures-ch' }]), []);
});
