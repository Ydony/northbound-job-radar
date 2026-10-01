#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

if (await portIsOpen(port)) {
  throw new Error(`Stop the ${environment} server on port ${port} before taking a backup.`);
}
await stat(source).catch(() => {
  throw new Error(
    `No ${environment} database exists at ${source}. Start it once with `
    + `\`npm run ${environment === 'test' ? 'test:local' : 'dev'}\` to create it.`,
  );
});

/**
 * Checkpoint the WAL into the database file before copying it. A plain copy of a live WAL
 * database is the truncated-restore failure that scripts/verify-sqlite-restore.mjs exists to
 * catch; in production this is `litestream replicate` running continuously. The port guard above
 * has already established that no server holds the file.
 */
{
  const checkpoint = new DatabaseSync(source);
  try {
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
}
const live = describe(source);
if (live.integrity !== 'ok') {
  throw new Error(`The ${environment} database fails integrity_check (${live.integrity}); not backing up a corrupt file.`);
}

const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const backupRoot = join(projectRoot, 'local-backups', environment, timestamp);
const stateDestination = join(backupRoot, 'state');
await mkdir(stateDestination, { recursive: true });
await cp(source, join(stateDestination, BACKUP_DB_NAME), { errorOnExist: true });

/**
 * Detect a failed backup now, not at restore time. The checkpoint above means the single file is
 * self-contained, so the copy must open, pass integrity_check, and report the same schema version
 * and row counts as the live file. Catching it here is the whole point: a backup is only worth
 * taking if a bad one is loud.
 */
const copied = describe(join(stateDestination, BACKUP_DB_NAME));
if (copied.integrity !== 'ok') {
  throw new Error(`The backup copy fails integrity_check (${copied.integrity}).`);
}
if (copied.schemaVersion !== live.schemaVersion) {
  throw new Error(`The backup copy reports schema version ${copied.schemaVersion}, the live database ${live.schemaVersion}.`);
}
for (const [table, total] of Object.entries(live.rowCounts)) {
  if (copied.rowCounts[table] !== total) {
    throw new Error(`The backup copy has ${copied.rowCounts[table]} ${table} rows, the live database ${total}.`);
  }
}

const files = await fileInventory(stateDestination);
const manifest = {
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
  schemaVersion: manifest.schemaVersion,
  integrity: manifest.integrity,
  rowCounts: manifest.rowCounts,
  kept: Math.min(existing.length, KEEP),
  pruned: pruned.length,
}, null, 2));
