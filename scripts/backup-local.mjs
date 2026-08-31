#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const environment = process.argv[2];
if (environment !== 'dev' && environment !== 'test') {
  throw new Error('Usage: node scripts/backup-local.mjs <dev|test>');
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(projectRoot, '.wrangler', environment, 'state');
const port = environment === 'test' ? 3001 : 3000;

async function portIsOpen(targetPort) {
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: targetPort });
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(true);
    });
    const closed = () => {
      socket.destroy();
      resolvePort(false);
    };
    socket.once('error', closed);
    socket.once('timeout', closed);
  });
}

async function fileInventory(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({
          path: relative(root, absolute).replaceAll('\\', '/'),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

if (await portIsOpen(port)) {
  throw new Error(`Stop the ${environment} server on port ${port} before taking a backup.`);
}
await stat(source).catch(() => {
  throw new Error(`No ${environment} state exists at ${source}.`);
});

const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const backupRoot = join(projectRoot, 'local-backups', environment, timestamp);
const stateDestination = join(backupRoot, 'state');
await mkdir(backupRoot, { recursive: true });
await cp(source, stateDestination, { recursive: true, errorOnExist: true });
const files = await fileInventory(stateDestination);
const manifest = {
  format: 1,
  environment,
  createdAt: new Date().toISOString(),
  source: relative(projectRoot, source).replaceAll('\\', '/'),
  files,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
};
await writeFile(join(backupRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

/**
 * Retention. A backup is only useful if taking one is cheap enough to do routinely, which means old
 * copies have to be cleared or they grow without bound - the test state is about 4 MB each time.
 * Keeps the newest few and removes the rest. Only ever prunes this environment's own folder, and
 * never the backup just written.
 */
const KEEP = 10;
const environmentRoot = join(projectRoot, 'local-backups', environment);
const existing = (await readdir(environmentRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .reverse();
const pruned = [];
for (const name of existing.slice(KEEP)) {
  if (name === timestamp) continue;
  await rm(join(environmentRoot, name), { recursive: true, force: true });
  pruned.push(name);
}

console.log(JSON.stringify({
  created: relative(projectRoot, backupRoot).replaceAll('\\', '/'),
  files: files.length,
  totalBytes: manifest.totalBytes,
  kept: Math.min(existing.length, KEEP),
  pruned: pruned.length,
}, null, 2));
