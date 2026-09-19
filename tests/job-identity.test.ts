import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJobUrl, countryFromLocation, isNearDuplicate, jobIdentityFingerprint, sourceInfoForUrl,
  sourceJobIdFromUrl } from '../lib/job-identity';

test('canonicalizes tracking variants to the same job URL', () => {
  const first = canonicalJobUrl('https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000/?utm_source=mail#apply');
  const second = canonicalJobUrl('https://www.jobs.ch/en/vacancies/detail/00000000-0000-0000-0000-000000000000/');
  assert.equal(first, second);
});

test('derives stable source identity and country', () => {
  assert.equal(sourceJobIdFromUrl('https://www.jobup.ch/en/jobs/detail/11111111-1111-1111-1111-111111111111/'),
    '11111111-1111-1111-1111-111111111111');
  assert.deepEqual(sourceInfoForUrl('https://www.iamexpat.nl/career/jobs-netherlands/example/id'), {
    key: 'iamexpat.nl', name: 'IamExpat', country: 'netherlands',
  });
  assert.deepEqual(sourceInfoForUrl('https://undutchables.nl/vacancies/example', 'Essen, Germany'), {
    key: 'undutchables.nl', name: 'Undutchables', country: 'unknown',
  });
  assert.deepEqual(sourceInfoForUrl('https://undutchables.nl/vacancies/example', 'Amsterdam, Netherlands'), {
    key: 'undutchables.nl', name: 'Undutchables', country: 'netherlands',
  });
});

test('uses company, title, location and posting day for cross-source fingerprints', () => {
  const first = jobIdentityFingerprint({ sourceUrl: 'https://jobs.ch/example', title: 'Data Analyst', company: 'Example AG', location: 'Zürich', postedAt: '2026-08-27T08:00:00Z' });
  const second = jobIdentityFingerprint({ sourceUrl: 'https://jobup.ch/other', title: 'DATA ANALYST', company: 'Example AG', location: 'Zurich', postedAt: '2026-08-27T20:00:00Z' });
  assert.equal(first, second);
});

test('does not fingerprint jobs without a posting day', () => {
  assert.equal(jobIdentityFingerprint({
    sourceUrl: 'https://jobs.ch/example', title: 'Data Analyst', company: 'Example AG', location: 'Zürich',
  }), '');
});

test('two copies with posting dates inside the window are one job', () => {
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z' },
    { location: 'Amsterdam', postedAt: '2026-09-03T00:00:00Z' },
  ), true);
});

test('a genuine repost outside the posting window stays a separate job', () => {
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-06-01T00:00:00Z' },
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z' },
  ), false);
});

test('first-seen decides when a source publishes no posting date', () => {
  // The case this fallback exists for: several sources omit a posting date entirely, and the
  // rule used to fall straight through to "assume duplicate", merging on employer, role and
  // place alone. A long-running vacancy and its reposting months later became one card.
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', firstSeenAt: '2026-09-01T00:00:00Z' },
    { location: 'Amsterdam', firstSeenAt: '2026-09-05T00:00:00Z' },
  ), true);
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', firstSeenAt: '2026-06-01T00:00:00Z' },
    { location: 'Amsterdam', firstSeenAt: '2026-09-01T00:00:00Z' },
  ), false);
});

test('first-seen is only a fallback — a posting date on both sides still wins', () => {
  // First-seen is our record, not the employer's. Where the employer published dates, those
  // decide, even when the two copies reached this app months apart.
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z', firstSeenAt: '2026-01-01T00:00:00Z' },
    { location: 'Amsterdam', postedAt: '2026-09-02T00:00:00Z', firstSeenAt: '2026-09-02T00:00:00Z' },
  ), true);
});

test('first-seen tolerates a wider gap than a posting date, because it lags', () => {
  const tenDaysApart = { left: '2026-09-01T00:00:00Z', right: '2026-09-11T00:00:00Z' };
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: tenDaysApart.left },
    { location: 'Amsterdam', postedAt: tenDaysApart.right },
  ), false, 'ten days is outside the four-day posting window');
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', firstSeenAt: tenDaysApart.left },
    { location: 'Amsterdam', firstSeenAt: tenDaysApart.right },
  ), true, 'ten days is inside the fourteen-day first-seen window');
});

test('with no date of any kind the copies still merge, rather than showing twice', () => {
  assert.equal(isNearDuplicate({ location: 'Amsterdam' }, { location: 'Amsterdam' }), true);
});

test('an incompatible place is decisive whatever the dates say', () => {
  assert.equal(isNearDuplicate(
    { location: 'Amsterdam', postedAt: '2026-09-01T00:00:00Z' },
    { location: 'Rotterdam', postedAt: '2026-09-01T00:00:00Z' },
  ), false);
});

// Every case below is a location string seen in real employer-board postings on 2026-09-14.
test('American places with Dutch or Swiss names are not Dutch or Swiss', () => {
  assert.equal(countryFromLocation('Lake Zurich, Illinois, United States'), 'unknown');
  assert.equal(countryFromLocation('Geneva, IL'), 'unknown');
  assert.equal(countryFromLocation('Rotterdam, NY'), 'unknown');
  assert.equal(countryFromLocation('1400 Altamont Avenue Rotterdam, NY 12306'), 'unknown');
  assert.equal(countryFromLocation('4500 New Bern Ave, Raleigh, NC 27610'), 'unknown');
  assert.equal(countryFromLocation('Holland, Michigan, United States'), 'unknown');
});

test('a multi-city posting that includes a Dutch or Swiss office still counts', () => {
  // The US exclusion applies per location, not to the whole string, or every global role
  // that lists Amsterdam next to New York would vanish.
  assert.equal(countryFromLocation('Amsterdam, Netherlands; Chicago, United States; Mumbai, India'), 'netherlands');
  assert.equal(countryFromLocation('West Palm Beach OR San Francisco OR Chicago OR Zug OR Singapore'), 'switzerland');
  assert.equal(countryFromLocation('Aurora, Colorado, United States | Lake Zurich, Illinois, United States'), 'unknown',
    'two American places, one of them named Zurich, are still only American');
});

test('Dutch cities outside the original short list are recognised', () => {
  for (const city of ['Groningen', 'Den Bosch', "'s-Hertogenbosch", 'Maastricht', 'Hilversum, NH', 'Amstelveen',
    'Zwolle', 'Nijmegen', 'Arnhem', 'Tilburg', 'Almere', 'Hoofddorp']) {
    assert.equal(countryFromLocation(city), 'netherlands', city);
  }
  assert.equal(countryFromLocation('Utrecht, NL'), 'netherlands', 'a trailing NL country code is not Newfoundland here');
});

test('a comma-separated global office list keeps its Dutch or Swiss offices', () => {
  // Real format. The first version of the American exclusion threw these out whole because the
  // list also names New York, losing real Zug and Geneva roles.
  assert.equal(countryFromLocation('London, New York, Singapore, Boston, Paris, Zug, Geneva, Hong Kong, Bangalore'), 'switzerland');
  assert.equal(countryFromLocation('Houston, London, Madrid, Montreal, New York, Paris, Singapore, Zug, Dubai'), 'switzerland');
  assert.equal(countryFromLocation('Schweiz / Graubünden'), 'switzerland');
  assert.equal(countryFromLocation('Schweiz/Solothurn'), 'switzerland');
});

test('Dutch and Swiss region codes are not mistaken for American states', () => {
  // NH is Noord-Holland as well as New Hampshire, FL Flevoland as well as Florida, NE Neuchâtel as
  // well as Nebraska. A code only means "America" beside a place name both countries share.
  assert.equal(countryFromLocation('Hilversum, NH'), 'netherlands');
  assert.equal(countryFromLocation('Almere, FL'), 'netherlands');
  assert.equal(countryFromLocation('Neuchâtel, NE'), 'switzerland');
  // "Amsterdam, NH" is a common real format for Noord-Holland. There is no Amsterdam in New
  // Hampshire; the American one is in New York. Only that exact pairing is excluded.
  assert.equal(countryFromLocation('Amsterdam, NH'), 'netherlands');
  assert.equal(countryFromLocation('Amsterdam, NH | Hilversum, NH'), 'netherlands');
  assert.equal(countryFromLocation('Amsterdam, NY'), 'unknown');
  assert.equal(countryFromLocation('Geneva, NE'), 'unknown', 'Geneva, Nebraska — Geneva is not in canton Neuchâtel');
});

test('Swiss locations in their own languages are recognised', () => {
  for (const place of ['Zürich', 'Genève', 'Lugano', 'St. Gallen', 'Fribourg', 'Neuchâtel', 'Baar', 'Schweiz']) {
    assert.equal(countryFromLocation(place), 'switzerland', place);
  }
});

test('a location naming nowhere supported stays unknown rather than guessed', () => {
  for (const place of ['Remote', 'Europe', 'Berlin, Germany', 'London, United Kingdom', '']) {
    assert.equal(countryFromLocation(place), 'unknown', place || '(empty)');
  }
});
