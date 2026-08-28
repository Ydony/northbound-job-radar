import assert from 'node:assert/strict';
import test from 'node:test';
import { dayKey, visitMarker } from '../lib/analytics';

test('the same visitor gets one stable marker within a day', async () => {
  const day = dayKey(new Date('2026-08-28T09:00:00Z'));
  const first = await visitMarker(day, '203.0.113.5', 'Firefox', 'secret');
  const second = await visitMarker(day, '203.0.113.5', 'Firefox', 'secret');
  assert.equal(first, second, 'the same person must not be counted twice in a day');
});

test('markers cannot be linked across days', async () => {
  const monday = await visitMarker(dayKey(new Date('2026-08-28T09:00:00Z')), '203.0.113.5', 'Firefox', 'secret');
  const tuesday = await visitMarker(dayKey(new Date('2026-08-29T09:00:00Z')), '203.0.113.5', 'Firefox', 'secret');
  // This is the property that makes the counter non-trackable: the same person on two days is
  // indistinguishable from two different people.
  assert.notEqual(monday, tuesday);
});

test('different visitors on the same day get different markers', async () => {
  const day = dayKey(new Date('2026-08-28T09:00:00Z'));
  const a = await visitMarker(day, '203.0.113.5', 'Firefox', 'secret');
  const b = await visitMarker(day, '198.51.100.9', 'Firefox', 'secret');
  assert.notEqual(a, b);
});

test('a marker reveals neither the address nor the browser', async () => {
  const day = dayKey(new Date('2026-08-28T09:00:00Z'));
  const marker = await visitMarker(day, '203.0.113.5', 'Mozilla/5.0 Firefox', 'secret');
  assert.doesNotMatch(marker, /203|113|Firefox|Mozilla/);
  assert.match(marker, /^[0-9a-f]{16}$/, 'truncated hex keeps it ambiguous between visitors');
});

test('the marker depends on the server secret, so it is not reproducible by outsiders', async () => {
  const day = dayKey(new Date('2026-08-28T09:00:00Z'));
  const mine = await visitMarker(day, '203.0.113.5', 'Firefox', 'secret');
  const theirs = await visitMarker(day, '203.0.113.5', 'Firefox', 'another-secret');
  assert.notEqual(mine, theirs);
});

test('day keys are plain calendar days', () => {
  assert.equal(dayKey(new Date('2026-08-28T23:59:00Z')), '2026-08-28');
});
