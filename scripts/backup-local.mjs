#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const environment = process.argv[2];
if (environment !== 'dev' && environment !== 'test') {
  throw new Error('Usage: node scripts/backup-local.mjs <dev|test>');
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Dev and test run on Node + SQLite (owner decision, 2026-09-27), one database file per
 * environment under `.local/`. This script used to copy `.wrangler/<env>/state`, the archived
 * Cloudflare pair's D1/R2 directory, which no longer exists on a current checkout - so
 * `npm run backup:dev` threw "No dev state exists" and the local backup path documented in
 * docs/ENVIRONMENTS.md had not worked since the move.
 */
const source = join(projectRoot, '.local', `${environment}.sqlite`);
const port = environment === 'test' ? 3001 : 3000;
const BACKUP_DB_NAME = 'app.sqlite';

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

/**
 * Reads the schema version and row counts a restored copy must reproduce. Opening the file is
 * itself the first check: a database the backup tooling cannot open is not a backup.
 */
function describe(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all().map((row) => row.version);
    const rowCounts = {};
    for (const table of ['users', 'vacancies', 'vacancy_sources', 'user_vacancy_state']) {
      rowCounts[table] = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
    }
    return { integrity, schemaVersion: versions.at(-1) ?? null, migrations: versions.length, rowCounts };
  } finally {
    database.close();
  }
}

/**
 * Early warning only. The server's port can be overridden (`PORT` in scripts/run-local.mjs), so
 * a closed probe does NOT prove nothing is writing; the backup below is therefore taken with
 * SQLite's online backup API, which snapshots consistently while a writer is active, instead of
 * relying on this check for correctness.
 */
if (await portIsOpen(port)) {
  throw new Error(`Stop the ${environment} server on port ${port} before taking a backup.`);
}
await stat(source).catch(() => {
  throw new Error(
    `No ${environment} database exists at ${source}. Start it once with `
    + `\`npm run ${environment === 'test' ? 'test:local' : 'dev'}\` to create it.`,
  );
});

const live = describe(source);
if (live.integrity !== 'ok') {
  throw new Error(`The ${environment} database fails integrity_check (${live.integrity}); not backing up a corrupt file.`);
}

const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const backupRoot = join(projectRoot, 'local-backups', environment, timestamp);
const stateDestination = join(backupRoot, 'state');
const backupDatabase = join(stateDestination, BACKUP_DB_NAME);

let files;
let manifest;
try {
  await mkdir(stateDestination, { recursive: true });

  /**
   * SQLite's online backup copies a transactionally consistent snapshot, including anything still
   * in the WAL, and stays correct if a writer is active. A plain file copy would not: it can
   * miss the WAL (the truncated-restore failure scripts/verify-sqlite-restore.mjs exists to catch)
   * or tear across a write. In production this role is played by `litestream replicate`.
   */
  const sourceDatabase = new DatabaseSync(source);
  try {
    await backup(sourceDatabase, backupDatabase);
  } finally {
    sourceDatabase.close();
  }

  /**
   * Detect a failed backup now, not at restore time: the copy must open, pass integrity_check and
   * carry the live schema version. Row counts are recorded from the copy rather than compared to
   * the live file, because a snapshot taken while a writer is active legitimately differs from a
   * count sampled a moment earlier; the copy's own counts are what a restore must reproduce, and
   * `npm run backup:verify` checks exactly those.
   */
  const copied = describe(backupDatabase);
  if (copied.integrity !== 'ok') {
    throw new Error(`The backup copy fails integrity_check (${copied.integrity}).`);
  }
  if (copied.schemaVersion !== live.schemaVersion) {
    throw new Error(`The backup copy reports schema version ${copied.schemaVersion}, the live database ${live.schemaVersion}.`);
  }

  files = await fileInventory(stateDestination);
  manifest = {
    format: 2,
    environment,
    createdAt: new Date().toISOString(),
    source: relative(projectRoot, source).replaceAll('\\', '/'),
    database: BACKUP_DB_NAME,
    schemaVersion: copied.schemaVersion,
    migrations: copied.migrations,
    integrity: copied.integrity,
    rowCounts: copied.rowCounts,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  await writeFile(join(backupRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
} catch (error) {
  // A half-written backup directory must not survive: retention would otherwise count it as a
  // real backup and, after enough failures, prune valid older ones in its favour.
  await rm(backupRoot, { recursive: true, force: true });
  throw error;
}

/**
 * Retention. A backup is only useful if taking one is cheap enough to do routinely, which means old
 * copies have to be cleared or they grow without bound - the test state is about 4 MB each time.
 * Keeps the newest few and removes the rest. Only ever prunes this environment's own folder, and
 * never the backup just written. Only directories with a manifest count as backups; anything
 * else is left alone rather than silently deleted, and never displaces a valid backup.
 */
const KEEP = 10;
const environmentRoot = join(projectRoot, 'local-backups', environment);
const existing = [];
for (const entry of await readdir(environmentRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const hasManifest = await stat(join(environmentRoot, entry.name, 'manifest.json')).then(() => true, () => false);
  if (hasManifest) existing.push(entry.name);
}
existing.sort().reverse();
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
  schemaVersion: manifest.schemaVersion,
  integrity: manifest.integrity,
  rowCounts: manifest.rowCounts,
  kept: Math.min(existing.length, KEEP),
  pruned: pruned.length,
}, null, 2));
