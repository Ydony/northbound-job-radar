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

  // Total elapsed, not the gap between each pair.
  //
  // Per-pair gaps were the first version and they were flaky: five callers resume concurrently,
  // so the timestamp each records can drift relative to the others under load, compressing an
  // observed gap without the pacer having done anything wrong. It passed alone and failed in a
  // 334-test run, which is the worst kind of test - it teaches you to ignore a red suite.
  //
  // The invariant that actually matters is that N paced starts cannot all happen at once, and
  // total elapsed time measures exactly that while being immune to per-callback jitter.
  const elapsed = starts[starts.length - 1];
  const floor = delay * (starts.length - 1) * 0.6;
  assert.ok(elapsed >= floor,
    `five paced starts took ${elapsed}ms, which is less than the ${floor}ms the spacing requires`);
});

test('pacing off means no artificial wait', async () => {
  resetPacing();
  const begin = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => paceStart(0)));
  assert.ok(Date.now() - begin < 40, 'a zero delay must not introduce a pause');
});
