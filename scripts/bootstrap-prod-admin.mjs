#!/usr/bin/env node
/** Deploy, visit the Worker once to apply migrations, then run this locally. Never use HTTP signup for bootstrap. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hashPassword, verifyPassword } from '../lib/auth.ts';
import { isValidEmail, normalizeEmail, passwordProblem } from '../lib/users.ts';

const help = `Usage: npm run bootstrap:prod-admin [-- --dry-run]

Run locally, after deploying the Worker and visiting its URL once to apply the schema.
This creates the FIRST administrator directly in production D1; remote HTTP signup stays blocked.
It refuses an existing user. --dry-run exercises a disposable local D1 only.
Email and password are prompted locally; never put them in arguments or environment variables.`;
if (process.argv.includes('--help')) {
  console.log(help);
  process.exit(0);
}
const dryRun = process.argv.includes('--dry-run');
if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) {
  console.error(help);
  process.exit(1);
}
if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
  console.error('An interactive local terminal is required; credentials cannot be piped or supplied as arguments.');
  process.exit(1);
}

const config = JSON.parse(await readFile(resolve('dist/server/wrangler.json'), 'utf8'));
if (config.name !== 'ikbeneenappel-prod'
  || config.d1_databases?.length !== 1
  || config.d1_databases[0].binding !== 'DB'
  || config.d1_databases[0].database_id !== 'b0a513c7-0d01-486c-8b16-5cdb6690c959') {
  throw new Error('Run npm run build:prod first; the generated Worker/D1 configuration is not production.');
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function promptPassword() {
  process.stdout.write('Password (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let password = '';
  try {
    for await (const chunk of process.stdin) {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') throw new Error('Cancelled.');
        if (char === '\r' || char === '\n') {
          process.stdout.write('\n');
          return password;
        }
        if (char === '\u007f' || char === '\b') password = password.slice(0, -1);
        else if (char >= ' ') password += char;
      }
    }
    throw new Error('Terminal input ended.');
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

async function wrangler(args) {
  const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'),
    'd1', 'execute', 'ikbeneenappel-prod', '--config', resolve('dist/server/wrangler.json'),
    dryRun ? '--local' : '--remote', '--json', '--yes', ...args],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let error = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { error += chunk; });
  const code = await new Promise((done) => child.on('exit', done));
  if (code !== 0) {
    // Wrangler may echo SQL on failure; never print its output after a credential-bearing INSERT.
    throw new Error(`D1 operation failed (exit ${code}). Check Wrangler login, schema and network. `
      + `Diagnostic length: ${error.length} bytes.`);
  }
  try { return JSON.parse(output); }
  catch { throw new Error('Wrangler returned an unexpected non-JSON response.'); }
}

function rows(result) {
  const record = Array.isArray(result) ? result[0] : result;
  if (record?.success === false || !Array.isArray(record?.results)) {
    throw new Error('D1 did not report a successful query.');
  }
  return record.results;
}

let tempDirectory;
let sqlFile;
try {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = normalizeEmail(await rl.question('Admin email: '));
  rl.close();
  if (!isValidEmail(email)) throw new Error('Invalid email address.');
  const password = await promptPassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const hash = await hashPassword(password);
  if (!await verifyPassword(password, hash)) throw new Error('Password hash self-check failed.');
  tempDirectory = await mkdtemp(join(tmpdir(), 'ikben-bootstrap-'));
  if (dryRun) {
    await wrangler(['--persist-to', tempDirectory, '--command', `CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, session_epoch INTEGER NOT NULL DEFAULT 1)`]);
  }
  const persistence = dryRun ? ['--persist-to', tempDirectory] : [];
  const initial = rows(await wrangler([...persistence, '--command', 'SELECT COUNT(*) AS total FROM users']));
  if (initial.length !== 1 || Number(initial[0].total) !== 0) {
    throw new Error('Bootstrap refused: the users table is not empty.');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const sql = `INSERT INTO users (id, email, password_hash, role, status, created_at, last_seen_at)
    SELECT ${quote(id)}, ${quote(email)}, ${quote(hash)}, 'admin', 'active', ${quote(now)}, ${quote(now)}
    WHERE NOT EXISTS (SELECT 1 FROM users);`;
  sqlFile = join(tempDirectory, 'bootstrap.sql');
  await writeFile(sqlFile, sql, { mode: 0o600, flag: 'wx' });
  rows(await wrangler([...persistence, '--file', sqlFile]));
  const inserted = rows(await wrangler([...persistence, '--command',
    `SELECT id, role, status FROM users WHERE id = ${quote(id)}`]));
  if (inserted.length !== 1 || inserted[0].role !== 'admin' || inserted[0].status !== 'active') {
    throw new Error('Bootstrap insert was not confirmed. Inspect the database before retrying.');
  }
  console.log(dryRun ? 'Local D1 dry-run passed; production was not touched.'
    : 'Production administrator created. Sign in and change the password promptly.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed.');
  process.exitCode = 1;
} finally {
  if (sqlFile) await rm(sqlFile, { force: true });
  if (tempDirectory) {
    const parent = resolve(tmpdir()) + sep;
    if (!resolve(tempDirectory).startsWith(parent)) {
      console.error('Unsafe temporary cleanup path; no directory removed.');
      process.exitCode = 1;
    } else if (dryRun) await rm(tempDirectory, { recursive: true, force: true });
    else await rmdir(tempDirectory);
  }
}
