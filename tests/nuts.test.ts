import assert from 'node:assert/strict';
import test from 'node:test';
import { nutsRegionName, nutsRegionNames, readableLocation } from '../lib/nuts';

test('resolves the codes EURES actually publishes', () => {
  // Both taken from live EURES responses.
  assert.equal(nutsRegionName('NL32B'), 'Groot-Amsterdam');
  assert.equal(nutsRegionName('CH031'), 'Basel-Stadt');
});

test('walks up to the parent region when a code is unknown', () => {
  // Eurostat retires codes at each annual revision while postings carry on using the old ones.
  // "Noord-Holland" is a far better answer than "NL32Z".
  assert.equal(nutsRegionName('NL32Z'), 'Noord-Holland');
  assert.equal(nutsRegionName('CH03X'), 'Nordwestschweiz');
  assert.equal(nutsRegionName('ZZ999'), '');
});

test('covers both countries and nothing else', () => {
  const codes = Object.keys(nutsRegionNames);
  assert.equal(codes.length, 92);
  assert.ok(codes.every((code) => code.startsWith('NL') || code.startsWith('CH')));
});

test('makes a stored location readable without mangling free text', () => {
  assert.equal(readableLocation('NL32B NL'), 'Groot-Amsterdam');
  assert.equal(readableLocation('CH031 CH'), 'Basel-Stadt');
  // Every other source gives free text, which must survive untouched.
  assert.equal(readableLocation('Pfaeffikon · Schweiz'), 'Pfaeffikon Schweiz');
  assert.equal(readableLocation('Zürich'), 'Zürich');
  assert.equal(readableLocation('Amsterdam'), 'Amsterdam');
  assert.equal(readableLocation(''), '');
});
