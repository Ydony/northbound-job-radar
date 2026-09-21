#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { approvedProfile, configuredVars, createIndeedOperator, localOrigin, APPROVED_PROFILE_REVISION } from './indeed-operator.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  env: { type: 'string', default: 'test' }, url: { type: 'string' },
  'approved-jobspy': { type: 'boolean', default: false },
} });
const environment = values.env;
if (!['dev', 'test'].includes(environment)) throw new Error('Choose --env dev or --env test');
const origin = localOrigin(values.url ?? `http://127.0.0.1:${environment === 'dev' ? 3000 : 3001}`);
const sessionFile = resolve(root, '.wrangler', 'indeed-client', `${environment}.json`);
function privateWrite(target, content) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}
async function input() {
  if (process.stdin.isTTY) throw new Error('Supply credentials as JSON through stdin, not command arguments. See docs/INDEED_TESTING.md.');
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 10000) throw new Error('Input too large'); }
  return JSON.parse(text);
}
try {
  const command = positionals[0];
  if (command === 'setup') {
    const profile = values['approved-jobspy'] ? await approvedProfile() : await input();
    const target = resolve(root, `.dev.vars.${environment}`);
    let existing;
    try { existing = readFileSync(target, 'utf8'); }
    catch { throw new Error('Run npm run init-secrets first.'); }
    privateWrite(target, configuredVars(existing, profile));
    console.log(JSON.stringify({ ok: true, environment, restartRequired: true,
      provenance: values['approved-jobspy'] ? `Owner-approved local experiment: JobSpy ${APPROVED_PROFILE_REVISION}` : 'Operator-supplied profile',
      message: 'Local configuration saved. Restart this environment once. No Indeed request was sent.' }));
  } else if (command === 'login') {
    const { email, password } = await input();
    if (typeof email !== 'string' || typeof password !== 'string') throw new Error('Supply email and password');
    const session = await createIndeedOperator({ baseUrl: origin }).login(email, password);
    mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
    privateWrite(sessionFile, JSON.stringify(session));
    console.log(JSON.stringify({ ok: true, environment, message: 'Administrator session saved locally. No Indeed request was sent.' }));
  } else if (['search', 'status', 'logout'].includes(command)) {
    let session;
    try { session = JSON.parse(readFileSync(sessionFile, 'utf8')); }
    catch { throw new Error('Run Indeed login once for this environment.'); }
    if (session.origin !== origin) throw new Error('Saved session belongs to another local origin; login for this URL first.');
    const operator = createIndeedOperator({ baseUrl: origin, cookie: session.cookie });
    if (command === 'logout') {
      await operator.logout();
      rmSync(sessionFile);
      console.log(JSON.stringify({ ok: true, message: 'Session revoked and removed.' }));
    } else {
      const result = await operator[command]();
      console.log(JSON.stringify(result, null, 2));
      if (command === 'search' && !result.ok) process.exitCode = 2;
    }
  } else {
    console.log('Usage: npm run indeed -- setup|login|search|status|logout --env dev|test [--url http://127.0.0.1:PORT]\nSetup accepts JSON on stdin or explicit --approved-jobspy. Login accepts email/password JSON on stdin. Search uses saved roles, countries and account session; no readiness call required.');
  }
} catch (error) {
  // Never dump request/response objects, credentials, raw upstream errors or a stack.
  console.error(JSON.stringify({ ok: false, error: error instanceof SyntaxError ? 'Invalid JSON input or response.' : error.message }));
  process.exitCode = 1;
}
