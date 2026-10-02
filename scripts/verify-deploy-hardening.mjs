#!/usr/bin/env node
/**
 * T37: harden service/proxy templates; check dependencies, artefacts and
 * secret leakage; document actual host checks.
 *
 * What this proves, from the repo alone and with synthetic fixtures only:
 *  1. every systemd unit pins the unprivileged user, refuses new privileges
 *     and carries the filesystem-containment set (ProtectSystem=strict,
 *     ProtectHome, PrivateTmp, PrivateDevices, kernel-module/tunable guards);
 *  2. the nginx template terminates TLS at 1.2+, hides its version, caps
 *     request bodies, rate-limits auth, and never serves databases, secrets,
 *     backups or VCS metadata;
 *  3. .gitignore covers secrets and database/backup artefacts, and no such
 *     artefact is tracked in git;
 *  4. no tracked file carries a recognisable secret;
 *  5. `npm audit --omit=dev` reports no Critical/High advisory in production
 *     dependencies.
 *
 * What this does NOT prove (deliberately — see docs/VPS_HOST_CHECKS.md): that
 * the host actually runs these templates, that ports/SSH/updates are as
 * documented, or that replication reaches the bucket. Those checks need
 * authorized private access to the machine and are recorded there, never here.
 *
 * Run with: `npm run verify:deploy-hardening`
 * Exits non-zero on the first failed section; prints only file names and
 * advisory ids, never values.
 */
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
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
function read(name) {
  return readFileSync(join(root, name), 'utf8');
}

// ---------------------------------------------------------------- units ---
console.log('1/5 systemd units run unprivileged and contained');
const units = [
  'deploy/ikbeneenappel-web.service',
  'deploy/ikbeneenappel-refresh.service',
  'deploy/ikbeneenappel-litestream.service',
];
// The containment set reviewed for T37. MemoryDenyWriteExecute and
// SystemCallFilter are deliberately absent (Node JIT; per-version syscall
// surface) and are asserted absent in tests/deploy-hardening.test.ts so a
// future edit cannot silently add a boot-breaking directive.
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
  'RestrictRealtime=true',
];
for (const unit of units) {
  const body = read(unit);
  check(!/^User=root/m.test(body), `${unit} never runs as root`);
  for (const directive of requiredDirectives) {
    check(body.includes(directive), `${unit} sets ${directive}`);
  }
  check(body.includes('ReadWritePaths=/var/lib/ikbeneenappel'),
    `${unit} confines writes to the data directory`);
}
check(read('deploy/ikbeneenappel-refresh.service').includes('Type=oneshot'),
  'the refresh unit stays Type=oneshot (no overlapping collectors)');
check(read('deploy/ikbeneenappel-web.service').includes('StateDirectory=ikbeneenappel'),
  'the web unit lets systemd own the data directory');

// ---------------------------------------------------------------- nginx ---
console.log('2/5 the proxy terminates TLS, brakes floods and hides artefacts');
const nginx = read('deploy/nginx-ikbeneenappel.conf');
check(nginx.includes('server_tokens off;'), 'nginx hides its version');
check(/ssl_protocols\s+TLSv1\.2\s+TLSv1\.3;/.test(nginx), 'TLS 1.2 minimum, 1.3 preferred');
check(nginx.includes('ssl_session_tickets off;'), 'TLS session tickets off (no second secret to rotate)');
check(/listen 80;[\s\S]*return 301 https:/.test(nginx), 'plain HTTP only redirects to HTTPS');
check(nginx.includes('client_max_body_size 1m;'), 'request bodies capped (no upload exists)');
check(nginx.includes('limit_req zone=auth'), 'auth routes keep the burst brake');
check(nginx.includes('limit_req_status 503;'), 'the brake refuses with 503, not a fake login failure');
// No upstream other than loopback: the proxy must never be one edit away from
// forwarding internal traffic somewhere else.
const upstreams = [...nginx.matchAll(/server\s+([^;]+);/g)]
  .map((m) => m[1].trim())
  .filter((s) => /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(s));
check(upstreams.length > 0 && upstreams.every((s) => s.startsWith('127.0.0.1')),
  'every IP upstream is loopback', upstreams.join(', ') || 'no IP upstream found');
for (const pattern of ['sqlite', 'local-backups', '.wrangler', 'pem']) {
  check(nginx.includes(pattern), `nginx denies ${pattern}`);
}
// .dev.vars/.env/.git carry no literal marker: they are covered by the
// dotfile block, which is what this asserts.
check(/location ~ \/\\\.\s*\{\s*\n(\s.*\n)*?\s*return 404;/m.test(nginx),
  'nginx denies dotfiles (.dev.vars, .env, .git) with 404');
check(!/add_header\s+Content-Security-Policy/i.test(nginx),
  'nginx sets no CSP of its own (the app owns the nonce policy)');
check(!/add_header\s+X-Frame-Options/i.test(nginx),
  'nginx sets no framing header of its own (the app owns it)');

// --------------------------------------------------------------- gitignore --
console.log('3/5 secrets and database artefacts are untracked and ignored');
const gitignore = read('.gitignore');
for (const pattern of ['.dev.vars', '.env', '*.sqlite', '*.db', '*.pem', '*.key', '.wrangler', '.local', '/dist/']) {
  check(gitignore.includes(pattern), `.gitignore covers ${pattern}`);
}
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  check(false, 'git ls-files runs (needed for the artefact scan)');
}
if (tracked.length > 0) {
  check(tracked.length > 0, `${tracked.length} tracked files scanned`);
  const forbidden = tracked.filter((f) =>
    /\.sqlite(-shm|-wal)?$/.test(f) || /\.db(-shm|-wal)?$/.test(f)
    || /(^|\/)\.dev\.vars\.([^e]|e[^x])/.test(f) || /(^|\/)\.env(\.|$)/.test(f)
    || /(^|\/)(local-backups|outputs|work|tmp)\//.test(f) || /\.pem$/.test(f) || /\.key$/.test(f));
  check(forbidden.length === 0, 'no database, secret, backup or key file is tracked',
    forbidden.slice(0, 5).join(', '));
}

// --------------------------------------------------------------- secrets ----
console.log('4/5 no tracked file carries a recognisable secret');
const secretPatterns = [
  /BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
  /xox[bap]-[A-Za-z0-9-]+/,
  /re_[A-Za-z0-9]{20,}/,
  /sk-live-[A-Za-z0-9]+/,
];
// Scanned: everything tracked except fixtures, tests, docs, the lockfile and
// the files whose whole purpose is documenting placeholders or generating
// fresh values. Values are never printed — only file names and line numbers.
const scanSkip = /^(package-lock\.json$|tests\/|docs\/|.*\.test\.[jt]s$|\.dev\.vars\.example$|scripts\/(init-secrets|check-visual)\.mjs$)/;
const offenders = [];
for (const file of tracked) {
  if (scanSkip.test(file)) continue;
  let body;
  try {
    body = read(file);
  } catch {
    continue;
  }
  if (body.length > 500_000) continue;
  body.split('\n').forEach((line, i) => {
    if (secretPatterns.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}`);
  });
}
check(offenders.length === 0, 'secret-pattern scan is clean', offenders.slice(0, 5).join(', '));
// The example file documents placeholders only: every credential line is empty.
const exampleSecrets = read('.dev.vars.example').split('\n')
  .filter((line) => /^(ADZUNA_APP_KEY|CAREERJET_API_KEY|RESEND_API_KEY|SESSION_SECRET|TURNSTILE_SECRET_KEY|INDEED_API_KEY)=./.test(line));
check(exampleSecrets.length === 0, 'the example vars file holds placeholders, not values');

// ------------------------------------------------------------------ audit ---
console.log('5/5 production dependencies carry no Critical/High advisory');
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8' });
let advisories = null;
try {
  const parsed = JSON.parse(audit.stdout);
  advisories = Object.entries(parsed.vulnerabilities ?? {})
    .filter(([, v]) => v.severity === 'critical' || v.severity === 'high');
} catch {
  check(false, 'npm audit --omit=dev returns parseable JSON (registry reachable?)');
}
if (advisories !== null) {
  check(advisories.length === 0, 'zero Critical/High production advisories',
    advisories.map(([k]) => k).slice(0, 5).join(', '));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS service/proxy templates, artefacts, secrets and production dependencies.');
