#!/usr/bin/env node
/**
 * T37 — verify deploy-template hardening and repo hygiene (F12 release gate).
 *
 * Static checks only: everything here runs against the worktree with no host
 * access, no credentials and no network (except the optional `npm audit`
 * step, which is skipped with a warning when the registry is unreachable).
 * Actual host checks that need authorized private access live in
 * docs/HOST_CHECKS.md and are NOT run here.
 *
 * Run with: `npm run verify:hardening` (or `node scripts/verify-deploy-hardening.mjs [--audit]`).
 * Exits non-zero on the first failed expectation.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const runAudit = process.argv.includes('--audit');

let failures = 0;
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` - ${detail}`}`);
  return false;
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

/** Tracked files via git, falling back to a null list when git is unavailable. */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- units ---
const units = [
  'deploy/ikbeneenappel-web.service',
  'deploy/ikbeneenappel-refresh.service',
  'deploy/ikbeneenappel-litestream.service',
];
// Baseline from the 2026-09-29 review plus the T37 additions.
const requiredDirectives = [
  'User=ikbeneenappel',
  'NoNewPrivileges=true',
  'ProtectSystem=strict',
  'ProtectHome=true',
  'PrivateTmp=true',
  'PrivateDevices=true',
  'ProtectKernelTunables=true',
  'ProtectKernelModules=true',
  'ProtectControlGroups=true',
  'RestrictSUIDSGID=true',
  'LockPersonality=true',
  'RestrictRealtime=true',
  'RemoveIPC=true',
  'ProtectClock=true',
  'ProtectHostname=true',
  'ReadWritePaths=/var/lib/ikbeneenappel',
  'UMask=0027',
];

console.log('1/5 systemd units are sandboxed');
for (const unit of units) {
  const body = read(unit);
  for (const directive of requiredDirectives) {
    check(body.includes(directive), `${unit} sets ${directive}`);
  }
  check(!/^User=root/m.test(body), `${unit} does not run as root`);
  check(!/^MemoryDenyWriteExecute\s*=\s*true/m.test(body), `${unit} omits MDWX (V8 JIT would die at startup)`);
}

// ---------------------------------------------------------------- nginx ---
console.log('2/5 reverse-proxy template brakes floods and hides files');
const nginx = read('deploy/nginx-ikbeneenappel.conf');
for (const needle of [
  'limit_req_zone',
  'limit_req zone=auth',
  'limit_req_status 503',
  'client_max_body_size',
  'proxy_connect_timeout',
  'proxy_read_timeout',
  'proxy_send_timeout',
  'return 404;',
  'server_tokens off;',
  'X-Real-IP',
]) {
  check(nginx.includes(needle), `nginx conf contains ${needle}`);
}
check(/sqlite.*sqlite-wal/s.test(nginx), 'nginx hides SQLite sidecar files');
check(!/add_header\s+(Strict-Transport-Security|Content-Security-Policy|X-Frame-Options)/.test(nginx),
  'nginx does not double-send app security headers');
check(!/(SESSION_SECRET|RESEND_API_KEY|TURNSTILE_SECRET_KEY|BEGIN [A-Z ]*PRIVATE KEY)/.test(nginx),
  'nginx template holds no secret values');

// -------------------------------------------------------------- hygiene ---
console.log('3/5 secrets and build artifacts stay out of git');
const gitignore = read('.gitignore');
for (const needle of ['.dev.vars', '.local', '/dist/', '/.wrangler/', '*.pem', '.env*', 'local-backups']) {
  check(gitignore.includes(needle), `.gitignore covers ${needle}`);
}
const tracked = trackedFiles();
if (tracked.length === 0) {
  console.log('  warn   git ls-files unavailable; skipping tracked-file scan');
} else {
  const banned = tracked.filter((f) => {
    if (f === '.dev.vars.example') return false; // the committed template, not a secret
    if (f.endsWith('.gitignore')) return false; // placeholder keepers, not content
    return (
      /(^|\/)\.dev\.vars(\..+)?$/.test(f) ||
      /(^|\/)\.env(\..+)?$/.test(f) ||
      /(^|\/)\.local(\/|$)/.test(f) ||
      /(^|\/)dist(\/|$)/.test(f) ||
      /(^|\/)\.wrangler(\/|$)/.test(f) ||
      /\.(sqlite|sqlite-wal|sqlite-shm|sqlite-journal|db)$/.test(f) ||
      /\.pem$/.test(f) ||
      /(^|\/)local-backups(\/|$)/.test(f) ||
      /(^|\/)outputs(\/|$)/.test(f)
    );
  });
  check(banned.length === 0, 'no tracked secret/artifact files', banned.slice(0, 5).join(', '));
}

console.log('4/5 no secret values committed in tracked text');
const allowlisted = new Set([
  '.dev.vars.example',
  'scripts/verify-deploy-hardening.mjs',
  'tests/deploy-hardening.test.ts',
  'docs/HOST_CHECKS.md',
]);
const secretPatterns = [
  /sk-live-[A-Za-z0-9_-]{8,}/, // Resend-style live keys
  /xox[bap]-/i, // Slack-style tokens (placeholder for any pasted bot token)
  /AKIA[0-9A-Z]{16}/, // AWS access keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gsk_[A-Za-z0-9]{20,}/,
];
const hits = [];
for (const file of tracked) {
  if (allowlisted.has(file)) continue;
  if (!/\.(ts|tsx|js|mjs|json|yml|yaml|conf|service|timer|md|example|ps1|sh)$/.test(file)) continue;
  let body;
  try {
    body = read(file);
  } catch {
    continue;
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(body)) hits.push(`${file}: ${pattern}`);
  }
  // Assigned (non-empty) secret-looking variables outside the example file.
  const assigned = body.match(/^(SESSION_SECRET|RESEND_API_KEY|TURNSTILE_SECRET_KEY|AWS_SECRET_ACCESS_KEY|ADZUNA_APP_KEY|CAREERJET_API_KEY|INDEED_API_KEY)\s*=\s*\S+/m);
  if (assigned && file !== '.dev.vars.example') hits.push(`${file}: ${assigned[0].slice(0, 40)}`);
}
check(hits.length === 0, 'tracked files hold no secret values', hits.slice(0, 5).join('; '));

// ---------------------------------------------------------------- audit ---
console.log('5/5 dependency audit');
if (!runAudit) {
  console.log('  skip npm audit (pass --audit to run it; needs registry access)');
} else {
  try {
    execFileSync('npm', ['audit', '--omit=dev', '--audit-level=high'], { cwd: root, stdio: 'inherit' });
    console.log('  ok   npm audit reports no High/Critical production advisories');
  } catch {
    failures += 1;
    console.error('  FAIL npm audit reported High/Critical advisories (see above)');
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS deploy hardening + repo hygiene static checks.');
