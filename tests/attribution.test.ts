import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { jobSourceAdapters } from '../lib/job-adapters';
import { sourcePolicies } from '../lib/source-policies';
import {
  ADZUNA_ATTRIBUTION,
  ADZUNA_LOCAL_LINKS,
  ADZUNA_SOURCE_KEYS,
  ELA_ATTRIBUTION,
  ELA_ATTRIBUTION_LINK,
  EURES_SOURCE_KEYS,
  adzunaSourcesOnScreen,
  isEuresJob,
  needsElaAttribution,
  sourcesPageAttributionKeys,
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

test('the /sources required-attribution section shows ELA to everyone and Adzuna only to admins', () => {
  assert.deepEqual(sourcesPageAttributionKeys(false), ['ela']);
  assert.deepEqual(sourcesPageAttributionKeys(true), ['ela', 'adzuna']);
});

test('synthetic fixtures: what the helpers say to show is exactly what the UI renders', () => {
  // EURES on screen -> the footer credit renders with the ELA name and legal-notice link.
  const withEures = [{ sourceKey: 'eures-ch' }, { sourceKey: 'job-room.ch' }];
  assert.equal(needsElaAttribution(withEures), true);
  assert.match(ELA_ATTRIBUTION, /European Labour Authority \(ELA\)/);
  assert.equal(ELA_ATTRIBUTION_LINK, 'https://eures.europa.eu/legal-notice_en');

  // No EURES on screen -> no footer credit.
  assert.equal(needsElaAttribution([{ sourceKey: 'job-room.ch' }]), false);

  // Adzuna on screen -> the private-view acknowledgement renders with the required
  // name and a link to each local domain actually on screen.
  const mixed = [{ sourceKey: 'eures-nl' }, { sourceKey: 'adzuna.nl' }];
  assert.deepEqual(adzunaSourcesOnScreen(mixed), ['adzuna.nl']);
  assert.match(ADZUNA_ATTRIBUTION, /The Adzuna API/);
  for (const key of adzunaSourcesOnScreen(mixed)) {
    assert.match(
      ADZUNA_LOCAL_LINKS[key as keyof typeof ADZUNA_LOCAL_LINKS],
      /^https:\/\/www\.adzuna\.(ch|nl)\/$/,
    );
  }
});

test('the EURES source policy names the ELA credit and links the legal notice', () => {
  const eures = sourcePolicies.find((policy) => policy.name.startsWith('EURES'));
  assert.ok(eures, 'EURES policy entry is missing');
  assert.match(`${eures!.theirRules} ${eures!.ourPosition}`, /European Labour Authority/);
  assert.match(`${eures!.theirRules} ${eures!.ourPosition}`, /acknowledged as the source/);
  assert.equal(eures!.link, 'https://eures.europa.eu/legal-notice_en');
});

test('the Adzuna source policy names the required acknowledgement and terms', () => {
  const adzuna = sourcePolicies.find((policy) => policy.name.startsWith('Adzuna'));
  assert.ok(adzuna, 'Adzuna policy entry is missing');
  assert.equal(adzuna!.adminOnly, true);
  assert.match(`${adzuna!.theirRules} ${adzuna!.ourPosition}`, /The Adzuna API/);
  assert.match(`${adzuna!.theirRules} ${adzuna!.ourPosition}`, /Swiss and Dutch|local site/i);
  assert.equal(adzuna!.link, 'https://developer.adzuna.com/docs/terms_of_service');
});

test('every EURES adapter tells the operator reuse is conditional on the ELA credit', () => {
  for (const adapter of jobSourceAdapters.filter((a) => a.key.startsWith('eures'))) {
    assert.match(
      adapter.availabilityMessage ?? '',
      /European Labour Authority/,
      `${adapter.key} does not tell the operator about the ELA condition`,
    );
  }
});

test('both pages are wired to render the required attributions', () => {
  const sourcesPage = readFileSync(new URL('../app/sources/page.tsx', import.meta.url), 'utf8');
  assert.match(sourcesPage, /ELA_ATTRIBUTION/);
  assert.match(sourcesPage, /ELA_ATTRIBUTION_LINK/);
  assert.match(sourcesPage, /ADZUNA_ATTRIBUTION/);
  assert.match(sourcesPage, /ADZUNA_LOCAL_LINKS/);
  assert.match(sourcesPage, /sourcesPageAttributionKeys/);
  // Adzuna stays administrator-only on /sources: the block renders only behind the role gate.
  assert.match(sourcesPage, /attributionKeys\.includes\('adzuna'\)/);

  const radar = readFileSync(new URL('../app/job-radar.tsx', import.meta.url), 'utf8');
  assert.match(radar, /needsElaAttribution/);
  assert.match(radar, /ELA_ATTRIBUTION/);
  assert.match(radar, /ELA_ATTRIBUTION_LINK/);
  assert.match(radar, /adzunaSourcesOnScreen/);
  assert.match(radar, /ADZUNA_ATTRIBUTION/);
  assert.match(radar, /ADZUNA_LOCAL_LINKS/);
});
