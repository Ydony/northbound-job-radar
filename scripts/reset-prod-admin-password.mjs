#!/usr/bin/env node
/** Owner-operated emergency recovery for the sole production administrator. Never use an HTTP reset endpoint. */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hashPassword, verifyPassword } from '../lib/auth.ts';

const dryRun = process.argv.includes('--dry-run');
if (process.argv.includes('--help')) {
  console.log('Usage: npm run reset:prod-admin-password [-- --dry-run]\n'
    + 'Resets the sole production admin to a generated temporary password, shown only in this terminal.\n'
    + 'Use --dry-run to exercise a disposable local D1 without touching production.');
  process.exit(0);
}
if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) {
  throw new Error('Unexpected argument. Use --help for usage.');
}
if (!dryRun && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  throw new Error('Run interactively in a local terminal; never pipe production credentials.');
}

const config = JSON.parse(await readFile(resolve('dist/server/wrangler.json'), 'utf8'));
if (config.name !== 'ikbeneenappel-prod' || config.d1_databases?.length !== 1
  || config.d1_databases[0].binding !== 'DB'
  || config.d1_databases[0].database_id !== 'b0a513c7-0d01-486c-8b16-5cdb6690c959') {
  throw new Error('Run npm run build:prod in this checkout first. Production bindings did not match.');
}

function quote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

let temporaryDirectory;
let sqlFile;
try {
  if (!dryRun) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await input.question('Reset the sole production admin password? Type RESET: ');
    input.close();
    if (answer !== 'RESET') throw new Error('Cancelled; no password changed.');
  }

  temporaryDirectory = await mkdtemp(join(tmpdir(), 'ikben-admin-reset-'));
  const childEnvironment = { ...process.env };
  delete childEnvironment.CLOUDFLARE_ENV;
  const persistence = dryRun ? ['--persist-to', temporaryDirectory] : [];
  async function execute(args) {
    const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1', 'execute', 'ikbeneenappel-prod', '--config', resolve('dist/server/wrangler.json'),
      dryRun ? '--local' : '--remote', '--json', '--yes', ...persistence, ...args],
    { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', () => {}); // Never print Wrangler errors that may echo the SQL hash.
    const code = await new Promise((done) => child.on('exit', done));
    if (code !== 0) throw new Error(`D1 operation failed (exit ${code}); no password was displayed.`);
    // Wrangler may prepend progress text even with --json on a remote --file operation.
    const jsonStart = output.search(/\[\s*\{\s*"results"\s*:/);
    if (jsonStart < 0) throw new Error('D1 returned no result JSON.');
    const parsed = JSON.parse(output.slice(jsonStart));
    const result = Array.isArray(parsed) ? parsed[0] : parsed;
    if (result?.success !== true || !Array.isArray(result.results)) {
      throw new Error('D1 did not report a successful operation.');
    }
    return result;
  }

  if (dryRun) {
    await execute(['--command', `CREATE TABLE users (
      id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL, session_epoch INTEGER NOT NULL DEFAULT 1)`]);
    await execute(['--command', `INSERT INTO users (id, password_hash, role, status)
      VALUES (${quote(randomUUID())}, 'synthetic-old-hash', 'admin', 'active')`]);
  }

  const before = (await execute(['--command',
    'SELECT id, role, status, session_epoch FROM users'])).results;
  if (before.length !== 1 || before[0].role !== 'admin' || before[0].status !== 'active') {
    throw new Error('Refused: production must have exactly one active administrator and no other users.');
  }
  const user = before[0];
  const temporaryPassword = randomBytes(24).toString('base64url');
  const hash = await hashPassword(temporaryPassword);
  if (!await verifyPassword(temporaryPassword, hash)) throw new Error('Generated password failed self-check.');
  const nextEpoch = Number(user.session_epoch) + 1;
  sqlFile = join(temporaryDirectory, 'reset.sql');
  await writeFile(sqlFile,
    `UPDATE users SET password_hash = ${quote(hash)}, session_epoch = ${nextEpoch}
      WHERE id = ${quote(user.id)} AND role = 'admin' AND status = 'active'
      AND session_epoch = ${Number(user.session_epoch)};`, { mode: 0o600, flag: 'wx' });
  await execute(['--file', sqlFile]);
  const after = (await execute(['--command',
    'SELECT id, role, status, session_epoch, password_hash FROM users'])).results;
  if (after.length !== 1 || after[0].id !== user.id || after[0].session_epoch !== nextEpoch
    || !await verifyPassword(temporaryPassword, after[0].password_hash)) {
    throw new Error('Password update could not be verified.');
  }

  if (dryRun) {
    console.log('Disposable local D1 password-reset dry-run passed. Production was not touched.');
  } else {
    console.log('\nTemporary administrator password (copy now; it will not be shown again):');
    console.log(temporaryPassword);
    console.log('Sign in, then change it immediately in Settings. All previous sessions were revoked.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Password reset failed.');
  process.exitCode = 1;
} finally {
  if (sqlFile) await rm(sqlFile, { force: true });
  if (temporaryDirectory) {
    const parent = resolve(tmpdir()) + sep;
    if (resolve(temporaryDirectory).startsWith(parent)) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } else {
      console.error('Unsafe temporary cleanup path; no directory removed.');
      process.exitCode = 1;
    }
  }
}
