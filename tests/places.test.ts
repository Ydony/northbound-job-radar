import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlace } from '../lib/places';

test('merges the spellings sources use for one city', () => {
  // Each of these counted as its own entry in the place filter until now.
  assert.equal(normalizePlace('Zürich 8000 ZH').place, 'Zürich');
  assert.equal(normalizePlace('Amsterdam, Noord-Holland').place, 'Amsterdam');
  assert.equal(normalizePlace('Amsterdam Noord-Holland').place, 'Amsterdam');
  assert.equal(normalizePlace('Den Haag Zuid-Holland').place, 'Den Haag');
  assert.equal(normalizePlace('Lausanne 1015 VD').place, 'Lausanne');
});

test('drops a trailing country, because the card prints the country itself', () => {
  // The job card renders place and country next to each other, so a source that writes
  // "Amsterdam, Netherlands" produced "Amsterdam, Netherlands \u00b7 Netherlands". The same
  // value groups the city filter, so one city appeared as two entries.
  assert.equal(normalizePlace('Amsterdam, Netherlands').place, 'Amsterdam');
  assert.equal(normalizePlace('Zurich, Switzerland').place, 'Zurich');
  assert.equal(normalizePlace('Wallis, Switzerland').place, 'Wallis');
  // The country is written in its own language as often as in English.
  assert.equal(normalizePlace('Bern, Schweiz').place, 'Bern');
  assert.equal(normalizePlace('Gen\u00e8ve, Suisse').place, 'Gen\u00e8ve');
  assert.equal(normalizePlace('Rotterdam, Nederland').place, 'Rotterdam');
  // A location that is only a country still means the whole country, not an empty place.
  for (const only of ['Netherlands', 'Switzerland', 'Nederland', 'Schweiz']) {
    const { place, countryWide } = normalizePlace(only);
    assert.equal(countryWide, true, `${only} should read as country-wide`);
    assert.ok(place.length > 0, `${only} should keep a place`);
  }
});

test('never rewrites a name Eurostat publishes', () => {
  // Several NUTS names end in a province, so treating that province as a removable suffix turned
  // "Kop van Noord-Holland" into "Kop van" and "Overig Groningen" into "Overig".
  for (const name of ['Kop van Noord-Holland', 'Overig Groningen', 'Zuidoost-Noord-Brabant',
    'Groot-Amsterdam', 'Zuid-Limburg']) {
    assert.equal(normalizePlace(name).place, name, `${name} must survive untouched`);
  }
});

test('marks a country as country-wide rather than offering it as a city', () => {
  // 101 stored jobs give only a country. Listing "Schweiz" beside Utrecht implies a precision the
  // advertisement never had.
  for (const [input, expected] of [['Schweiz', 'Switzerland'], ['Nederland', 'Netherlands'],
    ['Suisse', 'Switzerland'], ['Netherlands', 'Netherlands']] as const) {
    const result = normalizePlace(input);
    assert.equal(result.place, expected);
    assert.equal(result.countryWide, true, `${input} should be country-wide`);
  }
  assert.equal(normalizePlace('Utrecht').countryWide, false);
});

test('leaves anything it cannot positively identify alone', () => {
  // Merging two genuinely different places is worse than leaving a duplicate, so a suffix that is
  // not a known province or postal code is kept.
  assert.equal(normalizePlace('Bern / Berne').place, 'Bern / Berne');
  assert.equal(normalizePlace('Somewhere Unmapped').place, 'Somewhere Unmapped');
  assert.equal(normalizePlace('Utrecht').place, 'Utrecht');
  assert.equal(normalizePlace('  ').place, '');
});
