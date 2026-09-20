import assert from 'node:assert/strict';
import test from 'node:test';
import { paceStart, resetPacing } from '../scripts/discover-boards.mjs';

/**
 * #80: the index pacer must space request *starts*.
 *
 * The old arrangement slept after each item inside each worker, so with four workers the first
 * four requests still left in the same instant and only the fifth onwards was paced. Against an
 * index that asks for no parallel threads, that opening burst is the part that matters, and the
 * --help text described a behaviour the code did not have.
 */
test('starts are spaced even when every caller arrives at once', async () => {
  resetPacing();
  const delay = 40;
  const starts: number[] = [];
  const begin = Date.now();
  // All five ask to start simultaneously, which is exactly the burst that used to slip through.
  await Promise.all(Array.from({ length: 5 }, async () => {
    await paceStart(delay);
    starts.push(Date.now() - begin);
  }));
  starts.sort((a, b) => a - b);

  for (let i = 1; i < starts.length; i += 1) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(gap >= delay * 0.6, `start ${i} was only ${gap}ms after the one before it`);
  }
  assert.ok(starts[4] >= delay * 3, 'five paced starts cannot all happen immediately');
});

test('pacing off means no artificial wait', async () => {
  resetPacing();
  const begin = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => paceStart(0)));
  assert.ok(Date.now() - begin < 40, 'a zero delay must not introduce a pause');
});
