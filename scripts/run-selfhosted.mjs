#!/usr/bin/env node
/**
 * The self-hosted stack, running for a person to use (#196).
 *
 * `npm run test:local` starts the Cloudflare target on workerd at :3001. This starts the *other*
 * target - the standalone Node bundle on SQLite, which is what the VPS will run - at :3002, so the
 * two can be compared side by side without either disturbing the other.
 *
 * The database starts **empty and stays local**, per the owner's decision that data only matters
 * in production. `.local/selfhosted.sqlite` is gitignored and persists between restarts, so an
 * account registered here survives a restart; delete the file to start over. Registering the first
 * account on loopback makes it the administrator, verified, with no emailer needed.
 *
 * No provider credentials are read. Every source will report itself unavailable, which is the
 * honest outcome and is what makes this safe to run anywhere: a search exercises the whole
 * pipeline without contacting anyone.
 *
 * `npm run verify:selfhosted` is the automated form of the same thing, on a throwaway database.
 * This script is for looking at it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const bundle = join(root, 'dist', 'standalone', 'server.js');
const localDir = join(root, '.local');
const databasePath = join(localDir, 'selfhosted.sqlite');
const secretPath = join(localDir, 'selfhosted-session-secret');
const port = Number(process.env.PORT ?? 3002);

if (!existsSync(bundle)) {
  console.error('No standalone bundle yet. Run `npm run build` first.');
  process.exit(1);
}

mkdirSync(localDir, { recursive: true });
// Kept in a file rather than regenerated per start: a new secret invalidates every session, so
// restarting the server would sign you out and look like a bug. Local only, and gitignored.
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(48).toString('base64'), 'utf8');

const fresh = !existsSync(databasePath);
console.log(`Self-hosted stack (Node + SQLite) on http://127.0.0.1:${port}`);
console.log(`Database ${databasePath}${fresh ? ' (new, empty)' : ' (existing)'}`);
if (fresh) console.log('Register the first account on this address to become the administrator.');
console.log('No provider keys are configured, so every source will report itself unavailable.');
console.log('Stop with Ctrl+C.\n');

const server = spawn(process.execPath, [bundle], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    SQLITE_PATH: databasePath,
    SESSION_SECRET: readFileSync(secretPath, 'utf8').trim(),
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
