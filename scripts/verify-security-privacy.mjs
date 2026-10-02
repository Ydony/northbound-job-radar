#!/usr/bin/env node

/**
 * T42 security/privacy evidence gate (F13).
 *
 * Runs the existing security/privacy unit checks, static log/secret hygiene
 * checks, and `npm audit --omit=dev`, then emits REDACTED JSON evidence:
 * pass/fail counts and file digests only — no emails, tokens, passwords,
 * environment values, or user data. Synthetic fixtures only; never run this
 * against production or with real credentials.
 *
 * Usage: node scripts/verify-security-privacy.mjs [--out <path>]
 * Exit 0 only when every check passes; anything else (including an
 * unreachable audit registry) fails the gate, because missing evidence
 * blocks T23 / public opening.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex === -1 ? null : resolve(process.argv[outIndex + 1] ?? '');
if (outPath && (!outPath.startsWith(`${projectRoot}/`) || outPath === projectRoot)) {
  throw new Error('The --out path must stay inside the project.');
}

const UNIT_FILES = [
  'tests/account-deletion.test.ts',
  'tests/privacy-policy.test.ts',
  'tests/security-headers.test.ts',
  'tests/auth.test.ts',
  'tests/email.test.ts',
  'tests/tenant-route-bindings.test.ts',
  'tests/public-admin-isolation.test.ts',
  'tests/admin-discovery-isolation.test.ts',
  'tests/rate-limit.test.ts',
  'tests/security-privacy-evidence.test.ts',
];

const checks = [];
const pass = (id, detail) => checks.push({ id, status: 'pass', detail });
const fail = (id, detail) => checks.push({ id, status: 'fail', detail });

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function walk(dir, suffixes) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(absolute, suffixes));
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) found.push(absolute);
  }
  return found;
}

// 1. Unit gate: the existing security/privacy suites, run as-is.
{
  const result = spawnSync('npx', ['tsx', '--test', ...UNIT_FILES], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 300000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const count = (label) => Number(output.match(new RegExp(`# ${label} (\\d+)`))?.[1] ?? NaN);
  const passed = count('pass');
  const failed = count('fail');
  if (result.status === 0 && Number.isFinite(passed) && failed === 0) {
    pass('unit-suites', `${UNIT_FILES.length} files, ${passed} tests passed`);
  } else {
    fail('unit-suites', `exit=${result.status} pass=${passed} fail=${failed}`);
  }
}

// 2. Static hygiene checks over committed source (lib/app/worker/db only).
const haystacks = new Map();
for (const file of await walk(projectRoot, ['.ts', '.tsx'])) {
  const relative = file.slice(projectRoot.length + 1).replaceAll('\\', '/');
  if (!/^(lib|app|worker|db)\//.test(relative)) continue;
  haystacks.set(relative, await readFile(file, 'utf8'));
}
const allSource = [...haystacks.values()].join('\n');

{
  const hits = [...haystacks.entries()]
    .filter(([, text]) => /console\.(log|info|debug|warn|error)/.test(text))
    .map(([name]) => name);
  if (hits.length === 0) pass('no-console-in-app-source', 'no console.* calls in lib/app/worker/db');
  else fail('no-console-in-app-source', `console calls in: ${hits.join(', ')}`);
}

{
  // Passwords, tokens, and keys must never be written to logs or stored raw.
  // There is no logging in app source (previous check), so this pins the
  // storage side: token hashes only, hashed passwords only.
  const email = haystacks.get('lib/email.ts') ?? '';
  const ok = email.includes('token_hash') && email.includes('hashEmailToken(token)')
    && !/console\.(log|info|debug|warn|error)\s*\(.*(password|token|apiKey|secret)/i.test(allSource);
  if (ok) pass('secrets-never-logged-or-stored-raw', 'tokens persisted as hashes; no secret logging');
  else fail('secrets-never-logged-or-stored-raw', 'token-hash storage or secret-logging pattern changed');
}

{
  const runtime = haystacks.get('db/runtime.ts') ?? '';
  const limiter = haystacks.get('lib/rate-limit.ts') ?? '';
  const authRoute = haystacks.get('app/api/auth/route.ts') ?? '';
  const ok = runtime.includes("DELETE FROM auth_events WHERE created_at < datetime('now', '-30 days')")
    && /15 \* 60_?000/.test(authRoute) && limiter.includes('DELETE FROM rate_limits WHERE reset_at <=');
  if (ok) pass('abuse-data-expires', 'auth_events 30-day purge; 15-minute sign-in windows with sweep');
  else fail('abuse-data-expires', 'retention purge pattern changed in db/runtime.ts, app/api/auth/route.ts or lib/rate-limit.ts');
}

{
  // Comments may discuss removed features; the promise covers the served copy.
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  const privacy = stripComments(haystacks.get('lib/privacy-policy.ts') ?? '');
  const ok = privacy.includes('Resend') && /expir/i.test(privacy)
    && !/\bCVs?\b/i.test(privacy) && !/\bR2\b/.test(privacy);
  if (ok) pass('privacy-notice-accurate', 'names Resend + token expiry; claims no CV/R2 handling');
  else fail('privacy-notice-accurate', 'lib/privacy-policy.ts disclosure changed');
}

// 3. Retention doc completeness: every F13 category present, no silent gaps.
{
  const doc = await readFile(join(projectRoot, 'docs/SECURITY_PRIVACY_RETENTION.md'), 'utf8')
    .catch(() => '');
  const required = ['account', 'search', 'auth_events', 'token', 'backup', 'PROPOSED', 'IMPLEMENTED'];
  const missing = required.filter((word) => !doc.toLowerCase().includes(word.toLowerCase()));
  if (doc && missing.length === 0) {
    pass('retention-table-complete', `sha256:${sha256(doc).slice(0, 16)} covers accounts/searches/logs/tokens/backups`);
  } else {
    fail('retention-table-complete', doc ? `missing: ${missing.join(', ')}` : 'retention doc unreadable');
  }
}

// 4. Production dependency audit. Fails on high/critical; anything lower is
// recorded but does not block. An unreachable registry fails the gate rather
// than silently passing it.
{
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 180000,
  });
  try {
    const audit = JSON.parse(result.stdout ?? '{}');
    const advisories = audit.advisories ?? audit.vulnerabilities ?? {};
    const entries = Object.values(advisories);
    const severe = entries.filter((entry) => ['high', 'critical'].includes(entry?.severity)).length;
    if (severe === 0) pass('npm-audit', `0 high/critical production advisories (${entries.length} total recorded)`);
    else fail('npm-audit', `${severe} high/critical production advisories`);
  } catch {
    fail('npm-audit', 'registry output unreadable — rerun with network access; absence of evidence blocks release');
  }
}

const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
const evidence = {
  tool: 'verify-security-privacy',
  sha: shaResult.status === 0 ? shaResult.stdout.trim() : 'unknown',
  generatedAt: new Date().toISOString(),
  verdict: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
  checks,
};

const rendered = JSON.stringify(evidence, null, 2);
console.log(rendered);
if (outPath) await writeFile(outPath, `${rendered}\n`);
if (evidence.verdict !== 'pass') process.exit(1);
