/**
 * Check `app/globals.css` against the reviewed design.
 *
 * The design was settled on a canvas and saved to `docs/design/canvas/`. Those frames are
 * pictures: they prove nothing about the app. This checks the parts of the agreement that are
 * mechanically checkable, so "it matches the design" stops being an opinion.
 *
 * It deliberately does NOT try to check layout or hierarchy. Those need eyes on a running
 * server, which is what `docs/design/canvas/index.html` is for — nothing tests
 * `app/job-radar.tsx`, so lint, typecheck, tests and build all pass on a page that renders
 * wrongly.
 *
 *   node scripts/check-design.mjs
 *
 * Exits non-zero and names every failure. Run it before saying a UX-6 task is done.
 */
import { readFileSync } from 'node:fs';

const css = readFileSync('app/globals.css', 'utf8');
const failures = [];
const passes = [];

function check(label, ok, detail) {
  (ok ? passes : failures).push(detail ? `${label} — ${detail}` : label);
}

// Colour. Every value was measured against the cream ground; the ratio is why it is that
// value and not a nearby one, so the ratio travels with it.
const TOKENS = [
  ['--text-secondary', '#4d574f', '7.20 on cream; replaces --muted #657169 at 4.88'],
  ['--text-tertiary', '#5d6660', '5.69 on cream'],
  ['--signal-good', '#3f7f54', '4.60; was #4f9967 at 3.30'],
  ['--signal-attention', '#c25239', '4.41; was #df6d55 at 3.11'],
  ['--signal-neutral', '#78817a', '3.85; was #9aa09a at 2.56, which failed'],
];
for (const [name, value, why] of TOKENS) {
  const declared = new RegExp(`${name}\\s*:\\s*${value}`, 'i').test(css);
  check(`token ${name}: ${value}`, declared, declared ? why : `not declared — ${why}`);
}

// The old single supporting tone should be gone, not merely supplemented.
const mutedUses = (css.match(/var\(--muted\)/g) || []).length;
check('--muted retired', mutedUses === 0,
  mutedUses ? `still used ${mutedUses}x; it measured 4.88 and carried most of the page` : 'no uses left');

// Type. Five rungs and nothing else, with 12 as the floor.
const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
const LADDER = new Set([12, 14, 17, 24, 32]);
const offLadder = [...new Set(sizes.filter((n) => !LADDER.has(n)))].sort((a, b) => a - b);
check('type ladder 12/14/17/24/32', offLadder.length === 0,
  offLadder.length ? `off the ladder: ${offLadder.join(', ')}` : `${sizes.length} declarations, all on it`);

const belowFloor = [...new Set(sizes.filter((n) => n < 12))].sort((a, b) => a - b);
check('nothing below 12px', belowFloor.length === 0,
  belowFloor.length ? `found ${belowFloor.join(', ')}` : 'floor holds');

// Structure. These are the specific things the review asked for.
const filterRule = /\.filters button\s*\{[^}]*border-bottom:\s*1px/i.test(css);
check('no rule under each filter row', !filterRule,
  filterRule ? 'a border-bottom is still on .filters button — seven lines down the page' : 'removed');

const cardBoxed = /\.job-card\s*\{[^}]*border:\s*1px solid/i.test(css);
check('no box around the job card', !cardBoxed,
  cardBoxed ? 'the card still has a full 1px border; only the status edge should remain' : 'edge only');

// A bare 1fr floors at min-content, so one long word in an advertisement decides how wide the
// page is. Five separate blowouts on this page came from exactly that.
const bareFr = [...css.matchAll(/grid-template-columns:\s*([^;}]*)/g)]
  .map((m) => m[1].trim())
  .filter((value) => /(^|[\s,(])1fr/.test(value) && !value.includes('minmax'));
check('no bare 1fr on text columns', bareFr.length === 0,
  bareFr.length ? `${bareFr.length} found, e.g. "${bareFr[0].slice(0, 48)}"` : 'all use minmax(0, 1fr)');

for (const line of passes) console.log(`  ok    ${line}`);
for (const line of failures) console.log(`  FAIL  ${line}`);

console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nThe frames in docs/design/canvas/ show what these add up to.');
  console.log('Open docs/design/canvas/index.html beside the running app at 1400px and 375px.');
  process.exit(1);
}
