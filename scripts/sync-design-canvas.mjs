#!/usr/bin/env node
/**
 * Mirror the design canvas into the repository.
 *
 * The canvas lives in a private Claude artifact that nobody else can open and that nothing
 * in this repository can point at, so `docs/design/canvas/` holds a standalone copy. The
 * artifact's frames are `.dc.html`: ordinary HTML wrapped in an `<x-dc>` element, with two
 * script tags the artifact runtime supplies. Neither script exists here, so this strips them
 * and leaves plain HTML that opens in any browser with no build step.
 *
 * Usage:
 *   node scripts/sync-design-canvas.mjs <dir-holding-the-.dc.html-frames>
 *
 * It rewrites every frame it is given and regenerates `index.html` from `canvas.json`, which
 * carries the board order and each board's title and size. Frames present in the repository
 * but absent from the source are left alone and reported, because deleting a frame is a
 * decision, not a sync step.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const OUT_DIR = resolve(import.meta.dirname, '..', 'docs', 'design', 'canvas');

/** Remove the artifact runtime's two script tags; everything else is already plain HTML. */
function toStandalone(source) {
  return source
    .replace(/^[ \t]*<script src="\.\/support\.js"><\/script>\r?\n/m, '')
    .replace(/[ \t]*<script type="text\/x-dc"[\s\S]*?<\/script>\r?\n/m, '');
}

function indexPage(boards, order) {
  const cards = order.map(file => {
    const board = boards[file] ?? {};
    const name = file.replace(/\.dc\.html$/, '.html');
    const size = board.w && board.h ? `${board.w} &times; ${board.h}` : '';
    return `    <li>
      <a href="./${name}">${board.title ?? name}</a>
      <span>${name}${size ? ` &middot; ${size}` : ''}</span>
    </li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The reviewed design</title>
<style>
body { margin: 0; padding: 48px 32px; font-family: system-ui, sans-serif; background: #fbfaf6; color: #18221c; }
main { max-width: 72ch; margin: 0 auto; }
h1 { font-size: 32px; font-weight: 500; letter-spacing: -0.02em; margin: 0 0 8px; }
p { font-size: 14px; line-height: 1.55; color: #4d574f; }
ul { list-style: none; margin: 32px 0 0; padding: 0; }
li { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 14px 0; border-bottom: 1px solid #e3e5d9; }
a { color: #134736; font-size: 17px; font-weight: 500; }
span { font-size: 12px; color: #5d6660; white-space: nowrap; }
</style>
</head>
<body>
<main>
  <h1>The reviewed design</h1>
  <p>Every frame renders standalone &mdash; plain HTML, two Google fonts, no build step and no
  server. They are pictures: nothing is wired up and the advertisements in them are synthetic.
  Where a frame and a task on the board disagree, the task is authoritative.</p>
  <ul>
${cards}
  </ul>
</main>
</body>
</html>
`;
}

const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error('Usage: node scripts/sync-design-canvas.mjs <dir-holding-the-.dc.html-frames>');
  process.exit(1);
}

const source = resolve(sourceDir);
const files = (await readdir(source)).filter(name => name.endsWith('.dc.html'));
if (!files.length) {
  console.error(`No .dc.html frames in ${source}`);
  process.exit(1);
}

for (const file of files) {
  const out = join(OUT_DIR, file.replace(/\.dc\.html$/, '.html'));
  await writeFile(out, toStandalone(await readFile(join(source, file), 'utf8')), 'utf8');
  console.log(`  ${basename(out)}`);
}

const canvas = JSON.parse(await readFile(join(source, 'canvas.json'), 'utf8'));
const order = (canvas.order ?? []).filter(file => files.includes(file));
await writeFile(join(OUT_DIR, 'index.html'), indexPage(canvas.boards ?? {}, order), 'utf8');
console.log('  index.html');

const stale = (await readdir(OUT_DIR))
  .filter(name => name.endsWith('.html') && name !== 'index.html')
  .filter(name => !files.includes(name.replace(/\.html$/, '.dc.html')));
if (stale.length) {
  console.log(`\nIn the repository but not in the canvas, left untouched: ${stale.join(', ')}`);
}
console.log(`\n${files.length} frame(s) mirrored to docs/design/canvas/`);
