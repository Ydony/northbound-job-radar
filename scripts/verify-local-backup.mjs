#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backupRoot = resolve(process.argv[2] ?? '');
const allowedRoot = resolve(projectRoot, 'local-backups');
if (!backupRoot.startsWith(`${allowedRoot}${sep}`)) {
  throw new Error('Choose a backup directory inside this project\'s local-backups folder.');
}

const manifest = JSON.parse(await readFile(join(backupRoot, 'manifest.json'), 'utf8'));
/**
 * Format 1 is a `.wrangler/<env>/state` directory from the archived Cloudflare pair; those
 * backups still exist on disk and stay verifiable by hash. Format 2 is a single checkpointed
 * SQLite file, and gets the stronger check below.
 */
if (manifest.format !== 1 && manifest.format !== 2) {
  throw new Error(`Unsupported backup manifest format ${manifest.format}.`);
}
if (!Array.isArray(manifest.files)) {
  throw new Error('Malformed backup manifest: no file list.');
}

const restoreRoot = resolve(projectRoot, '.local', `backup-restore-check-${process.pid}`);
const allowedRestoreRoot = resolve(projectRoot, '.local');
if (!restoreRoot.startsWith(`${allowedRestoreRoot}${sep}`)) {
  throw new Error('The restore-check path escaped the local state directory.');
}
await mkdir(allowedRestoreRoot, { recursive: true });

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
  /**
   * Hashes prove the bytes survived the round trip; they say nothing about whether the result is
   * a usable database. For a format-2 backup, open the restored copy and require the schema
   * version and row counts the manifest recorded at creation time. This is the check that would
   * catch a copy taken without a WAL checkpoint, which hashes cannot see.
   */
  let restored = null;
  if (manifest.format === 2) {
    const databasePath = resolve(restoreRoot, 'state', manifest.database ?? 'app.sqlite');
    const database = new DatabaseSync(databasePath);
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
      if (integrity !== 'ok') throw new Error(`The restored database fails integrity_check (${integrity}).`);
      const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all().map((row) => row.version);
      const schemaVersion = versions.at(-1) ?? null;
      if (manifest.schemaVersion != null && schemaVersion !== manifest.schemaVersion) {
        throw new Error(`The restored database reports schema version ${schemaVersion}, the manifest ${manifest.schemaVersion}.`);
      }
      const rowCounts = {};
      for (const table of Object.keys(manifest.rowCounts ?? {})) {
        rowCounts[table] = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
        if (rowCounts[table] !== manifest.rowCounts[table]) {
          throw new Error(`The restored database has ${rowCounts[table]} ${table} rows, the manifest ${manifest.rowCounts[table]}.`);
        }
      }
      restored = { integrity, schemaVersion, migrations: versions.length, rowCounts };
    } finally {
      database.close();
    }
  }

  console.log(JSON.stringify({
    ok: true,
    format: manifest.format,
    environment: manifest.environment,
    createdAt: manifest.createdAt,
    files: manifest.files.length,
    totalBytes: manifest.totalBytes,
    restored,
  }, null, 2));
} finally {
  await rm(restoreRoot, { recursive: true, force: true });
}
