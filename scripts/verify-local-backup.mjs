#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backupRoot = resolve(process.argv[2] ?? '');
const allowedRoot = resolve(projectRoot, 'local-backups');
if (!backupRoot.startsWith(`${allowedRoot}${sep}`)) {
  throw new Error('Choose a backup directory inside this project\'s local-backups folder.');
}

const manifest = JSON.parse(await readFile(join(backupRoot, 'manifest.json'), 'utf8'));
if (manifest.format !== 1 || !Array.isArray(manifest.files)) {
  throw new Error('Unsupported or malformed backup manifest.');
}

const restoreRoot = resolve(projectRoot, '.wrangler', `backup-restore-check-${process.pid}`);
const allowedRestoreRoot = resolve(projectRoot, '.wrangler');
if (!restoreRoot.startsWith(`${allowedRestoreRoot}${sep}`)) {
  throw new Error('The restore-check path escaped the local Wrangler directory.');
}

try {
  await mkdir(restoreRoot, { recursive: false });
  await cp(join(backupRoot, 'state'), join(restoreRoot, 'state'), {
    recursive: true,
    errorOnExist: true,
  });
  for (const expected of manifest.files) {
    const restoredPath = resolve(restoreRoot, 'state', expected.path);
    const stateRoot = resolve(restoreRoot, 'state');
    if (!restoredPath.startsWith(`${stateRoot}${sep}`)) throw new Error('Unsafe path in backup manifest.');
    const details = await stat(restoredPath);
    const digest = createHash('sha256').update(await readFile(restoredPath)).digest('hex');
    if (details.size !== expected.bytes || digest !== expected.sha256) {
      throw new Error(`Restore verification failed for ${expected.path}.`);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    environment: manifest.environment,
    createdAt: manifest.createdAt,
    files: manifest.files.length,
    totalBytes: manifest.totalBytes,
  }, null, 2));
} finally {
  await rm(restoreRoot, { recursive: true, force: true });
}
