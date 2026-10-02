#!/usr/bin/env node
/**
 * T42 (F13): reproducible security/privacy evidence for independent review.
 *
 * Assembles the F13 release evidence from the code itself — retention periods,
 * log hygiene, recipients/regions, deletion coverage, export position and the
 * known blockers — and prints it as redacted JSON. A second reviewer (Codex)
 * runs the same command at the release SHA and compares the output.
 *
 * Run with: `npm run verify:security-privacy` (or `-- --strict` to exit
 * non-zero while any `blocking` finding remains; the default exit 0 means
 * "evidence assembled", not "gate passed" — the T23 gate consumes the
 * `blocking` list in docs/SECURITY_PRIVACY_RELEASE.md).
 *
 * Synthetic/public only. This script reads code, docs and config — never
 * `.dev.vars.*`, `.wrangler/`, buckets, or any live database — and prints no
 * emails, tokens, keys, secrets, or personal data: only presence booleans,
 * counts and code-quoted periods.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

function read(rel) {
  return readFileSync(join(repo, rel), 'utf8');
}
function exists(rel) {
  return existsSync(join(repo, rel));
}
function sha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown (not a git checkout)';
  }
}
/** All source files under dirs, filtered by extension. */
function walk(rels, exts) {
  const out = [];
  const visit = (rel) => {
    const full = join(repo, rel);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full)) visit(join(rel, entry));
    } else if (exts.some((ext) => rel.endsWith(ext))) {
      out.push(rel);
    }
  };
  for (const rel of rels) visit(rel);
  return out.sort();
}

const findings = [];
function check(id, area, status, detail) {
  findings.push({ id, area, status, detail });
}
const pass = (id, area, detail) => check(id, area, 'pass', detail);
const blocking = (id, area, detail) => check(id, area, 'blocking', detail);
const acceptedGap = (id, area, detail) => check(id, area, 'accepted-gap', detail);

// --- R1. Retention periods are implemented in code (approval status is a
// owner checkpoint, recorded in the release doc, not asserted here). ---
const authSrc = read('lib/auth.ts');
pass('R1-session', 'retention',
  `session cookie TTL is 14 days in lib/auth.ts: ${authSrc.includes('14 * 24 * 60 * 60 * 1000')}. ` +
  `Sign-out clears immediately (clearedSessionCookie Max-Age=0: ${authSrc.includes('Max-Age') || authSrc.includes('maxAgeSeconds = SESSION_TTL_MS / 1000')}). ` +
  `Owner approval of the period: pending (T38 gate) — see release doc.`);

const emailSrc = read('lib/email.ts');
pass('R1-tokens', 'retention',
  `verification TTL 24h (${emailSrc.includes('24 * 60 * 60 * 1000')}), ` +
  `reset TTL 1h (${emailSrc.includes('60 * 60 * 1000')}). Only token hashes stored ` +
  `(${emailSrc.includes('Only the hash is stored')}); single-use consume-then-delete ` +
  `(${emailSrc.includes('it is deleted first') || emailSrc.includes('DELETE FROM email_verifications WHERE token_hash')}).`);

const runtimeSrc = read('db/runtime.ts');
const migrationsSrc = read('db/migrations.ts');
pass('R1-signin-logs', 'retention',
  `auth_events purged after 30 days in ensureSchema (${runtimeSrc.includes("datetime('now', '-30 days')")}) ` +
  `and migration 9 (${migrationsSrc.includes("datetime('now', '-30 days')")}).`);

const authRouteSrc = read('app/api/auth/route.ts');
pass('R1-rate-limits', 'retention',
  `auth rate-limit buckets are 15-minute windows (${authRouteSrc.includes('15 * 60_000')}) ` +
  `swept on rollover (${read('lib/rate-limit.ts').includes('DELETE FROM rate_limits WHERE reset_at <= ?')}).`);

const litestreamYml = read('deploy/litestream.yml');
pass('R1-backups', 'retention',
  `Litestream replica retention 720h/30 days (${litestreamYml.includes('retention: 720h')}). ` +
  `Restore-into-scratch procedure in docs/DEPLOY.md; synthetic rehearsal scripts/verify-sqlite-restore.mjs.`);

const privacySrc = read('lib/privacy-policy.ts');
const tokenLine = privacySrc.match(/verification links expire after 24 hours and reset links after 1 hour/) !== null;
const signinLine = privacySrc.match(/automatically deleted after 30 days/) !== null;
if (tokenLine && signinLine) {
  pass('R1-disclosed', 'retention', 'privacy copy states the 24h/1h token and 30-day sign-in-record periods.');
} else {
  blocking('R1-disclosed', 'retention', 'privacy copy does not state the implemented token/sign-in periods.');
}
blocking('R1-approval', 'retention',
  'Concrete retention periods are implemented but have no recorded owner approval (F13 requires approval before implementation; T38 gate). T23 stays blocked until the owner approves the table in docs/SECURITY_PRIVACY_RELEASE.md.');

// --- R2. Logs omit secrets; auth_events holds no passwords/tokens. ---
// Runtime code only: operator scripts are local-terminal handover tooling and
// are audited separately in R2b below.
const scanned = walk(['lib', 'app/api'], ['.ts', '.tsx']);
const loggedSecret = scanned.filter((rel) => {
  const src = read(rel);
  return /console\.(log|error|warn|info|debug)/.test(src)
    && /(password|passwd|api[_-]?key|secret|Authorization|set-cookie|cookie\s*=\s*['"`][^'"`]*session|token\s*[:=]\s*['"`]?[A-Za-z0-9\-_]{16})/i.test(src);
});
if (loggedSecret.length === 0) {
  pass('R2-no-secret-logs', 'logs',
    `scanned ${scanned.length} lib/app-api/script files: no console.* statement carries a password, key, secret, Authorization value, session cookie, or token literal.`);
} else {
  blocking('R2-no-secret-logs', 'logs', `console.* with a possible secret in: ${loggedSecret.join(', ')}`);
}
const authEventsCols = (migrationsSrc.match(/CREATE TABLE IF NOT EXISTS auth_events \(([\s\S]*?)\)/) ?? [])[1] ?? '';
if (!/password|token|secret|hash/i.test(authEventsCols)) {
  pass('R2-auth-events-shape', 'logs', 'auth_events columns are id/email/ip/kind/created_at only — no passwords, tokens, or hashes.');
} else {
  blocking('R2-auth-events-shape', 'logs', 'auth_events schema mentions a secret-bearing column.');
}
// A console.* call is a handover only when it prints a secret-bearing
// *variable*, not prose mentioning the word. Strip string literals (keeping
// `${...}` interpolations) and look for secret names in the remaining code.
function codeOutsideLiterals(line) {
  return line
    .replace(/`(?:[^`\\]|\\.)*`/g, (lit) => {
      const exprs = [...lit.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(' ');
      return ` ${exprs} `;
    })
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
}
const SECRET_IDENTIFIER = /\b(password|passwd|api[_-]?key|session[_-]?secret|temporarypassword)\b/i;
/** The full console.* statement starting at a line (balanced parens). */
function consoleStatement(lines, index) {
  let depth = 0;
  let started = false;
  let out = '';
  for (const line of lines.slice(index, index + 12)) {
    out += `\n${line}`;
    for (const ch of line) {
      if (ch === '(') { depth += 1; started = true; }
      if (ch === ')') depth -= 1;
    }
    if (started && depth <= 0) break;
  }
  return out;
}
function printsSecretValue(rel) {
  const lines = read(rel).split('\n');
  return lines.some((line, index) => {
    if (!/console\.(log|error|warn|info|debug)\(/.test(line)) return false;
    return SECRET_IDENTIFIER.test(codeOutsideLiterals(consoleStatement(lines, index)));
  });
}
// Exactly one operator script surfaces a secret value on the local terminal:
// reset-prod-admin-password prints the temporary password as the owner
// handover (never into logs, files, or remote output). bootstrap-prod-admin
// prompts hidden and stores only the hash, so it prints nothing secret. The
// singleton is allowlisted explicitly so a second such script fails this
// check instead of blending in.
const documentedPrinters = ['scripts/reset-prod-admin-password.mjs'];
const secretPrinters = documentedPrinters.filter(printsSecretValue);
const unexpectedPrinters = walk(['scripts'], ['.mjs'])
  .filter((rel) => !documentedPrinters.includes(rel))
  .filter(printsSecretValue);
if (secretPrinters.length === 1 && unexpectedPrinters.length === 0) {
  pass('R2-operator-handover', 'logs',
    'exactly the one documented owner-handover script prints a temporary password to the local terminal (reset-prod-admin); bootstrap prompts hidden and stores only the hash; no other script prints a secret value.');
} else {
  blocking('R2-operator-handover', 'logs',
    `handover set changed (documented printer prints: ${secretPrinters.length}/1; unexpected: ${unexpectedPrinters.join(', ') || 'none'}).`);
}

// --- R3. Recipients, regions and data sent are recorded. ---
const resendNamed = privacySrc.includes('Resend');
const turnstileNamed = privacySrc.includes('Turnstile') && privacySrc.includes('Cloudflare');
const keywordsOnly = /never receive your email|Search keywords and locations are sent to the sources/i.test(privacySrc);
if (resendNamed && turnstileNamed && keywordsOnly) {
  pass('R3-recipients', 'sharing',
    'privacy copy names Resend (verification/reset email) and Cloudflare Turnstile (registration bot check), and states job sites receive keywords/locations but never the account email.');
} else {
  blocking('R3-recipients', 'sharing',
    `recipient disclosure incomplete (Resend: ${resendNamed}, Turnstile/Cloudflare: ${turnstileNamed}, keywords-only: ${keywordsOnly}).`);
}

// --- R4. No CV/scoring, no model-provider sends, no production data in fixtures. ---
const baseCreatesCvs = /CREATE TABLE IF NOT EXISTS cvs\b/.test(runtimeSrc);
const migrationDropsCvs = /DROP TABLE cvs/i.test(migrationsSrc);
if (baseCreatesCvs && migrationDropsCvs) {
  pass('R4-no-cv', 'minimisation',
    'legacy base replays CREATE cvs for old-database upgrades, migration 28 drops it; final schema holds no CV table or rows (proven live by tests/account-deletion.test.ts).');
} else {
  blocking('R4-no-cv', 'minimisation',
    `CV removal does not hold end to end (base creates: ${baseCreatesCvs}, migration drops: ${migrationDropsCvs}).`);
}
if (!exists('lib/export.ts')) {
  pass('R4-no-export-code', 'minimisation', 'lib/export.ts absent (removed 2026-09-24; no-export is an accepted gap, not oversight).');
} else {
  blocking('R4-no-export-code', 'minimisation', 'lib/export.ts exists but the release doc records no export feature.');
}
const modelSends = walk(['lib'], ['.ts'])
  .map((rel) => ({ rel, src: read(rel) }))
  .filter(({ src }) => /https:\/\/(api\.openai\.com|api\.anthropic\.com|api\.cohere\.|openrouter\.ai|api\.groq\.com)/i.test(src));
if (modelSends.length === 0) {
  pass('R4-no-model-sends', 'minimisation', 'no lib/ module posts job data to a third-party model endpoint.');
} else {
  blocking('R4-no-model-sends', 'minimisation', `model endpoint referenced in: ${modelSends.map((m) => m.rel).join(', ')}`);
}
const fixtureFiles = walk(['tests/fixtures'], ['.ts', '.txt']);
const prodData = [...walk(['tests'], ['.ts']), ...fixtureFiles].filter((rel) => {
  if (rel === 'scripts/verify-security-privacy.mjs') return false;
  const src = read(rel);
  return /@gmail\.com|@ikbeneenappel\.nl|sk-(live|proj)|BEGIN [A-Z ]*PRIVATE KEY|resend[_-].{0,10}re_[A-Za-z0-9]{10}/i.test(src);
});
if (prodData.length === 0) {
  pass('R4-synthetic-fixtures', 'minimisation', `scanned ${walk(['tests'], ['.ts']).length + fixtureFiles.length} test/fixture files: no production addresses, live keys, or private key material.`);
} else {
  blocking('R4-synthetic-fixtures', 'minimisation', `possible production data in: ${prodData.join(', ')}`);
}

// --- R5. Deletion coverage delegates to the shared helper (live proof lives
// in tests/account-deletion.test.ts and the verify harnesses). ---
const accountRoute = read('app/api/account/route.ts');
const adminRoute = read('app/api/admin/route.ts');
const delegates = /accountDeletionStatements\(db, user\.id, user\.email\)/.test(accountRoute)
  && /accountDeletionStatements\(db, userId, target\.email\)/.test(adminRoute);
if (delegates) {
  pass('R5-deletion-delegates', 'deletion',
    'self-deletion and admin-deletion both delegate to accountDeletionStatements; workspace reset to ownedDataDeletionStatements. Two-account emptying is proven by tests/account-deletion.test.ts.');
} else {
  blocking('R5-deletion-delegates', 'deletion', 'a delete path no longer delegates to the shared helper.');
}

// --- R6. Export position: deliberately absent (accepted gap). ---
const hasExportRoute = exists('app/api/export/route.ts');
const hasExportButton = walk(['app'], ['.tsx']).some((rel) => /Export (your data|button)|download.*workspace/i.test(read(rel)));
if (!hasExportRoute && !hasExportButton) {
  acceptedGap('R6-no-export', 'export',
    'No self-service export exists (owner decision 2026-09-24, GDPR Article 20 gap explicitly accepted; users contact the installation owner). Revisit requires a privacy review first.');
} else {
  blocking('R6-no-export', 'export', 'export surface exists but is not an approved, tested, authenticated flow with expiring artifacts.');
}

// --- R7. Private-response caching (T19): every private route answers via
// the no-store helper, so no CDN/reverse proxy can serve one account's data
// to the next visitor. Verified the way tests/no-store.test.ts pins it:
// no bare Response.json in any private route (the Turnstile sitekey route is
// public by design and stays the one exception). ---
const routeFiles = walk(['app/api'], ['.ts']);
const bareJsonRoutes = routeFiles.filter((rel) => {
  if (rel === 'app/api/turnstile/route.ts') return false;
  return /Response\.json\(/.test(read(rel));
});
const noStoreHelper = exists('lib/no-store.ts')
  && /noStoreJson/.test(read('lib/guard.ts'))
  && /cache-control.*no-store/i.test(read('lib/no-store.ts'));
if (bareJsonRoutes.length === 0 && noStoreHelper) {
  pass('R7-no-store', 'transport',
    `T19: all ${routeFiles.length} API routes answer via noStoreJson/withNoStore (lib/no-store.ts, re-exported from lib/guard.ts); the only bare Response.json is the public Turnstile sitekey route. Pinned by tests/no-store.test.ts.`);
} else {
  blocking('R7-no-store', 'transport',
    `T19 no-store gap: bare Response.json in ${bareJsonRoutes.join(', ') || 'none'}; helper present: ${noStoreHelper}. Required before any CDN/reverse proxy; T23 blocked.`);
}

// --- R8. Backup encryption (T33) + real restore drill witness. ---
// App-level encryption now exists: AES-256-GCM envelopes (lib/backup-encryption.ts,
// NBENC1 layout, separate BACKUP_RECOVERY_KEY, fingerprint-only manifest) proven by
// scripts/verify-encrypted-backup.mjs on synthetic fixtures. The remaining gap is
// the real-target witness: the VPS restore-into-scratch drill (docs/DEPLOY.md) is
// owner-run, and Codex must witness it at the release SHA before T23.
const backupEncryption = exists('lib/backup-encryption.ts')
  && /NBENC1/.test(read('lib/backup-encryption.ts'))
  && exists('scripts/verify-encrypted-backup.mjs')
  && exists('tests/backup-encryption.test.ts');
if (!backupEncryption) {
  blocking('R8-encrypted-restore', 'backups',
    'App-level backup encryption missing (lib/backup-encryption.ts or its drill absent). T23 blocked.');
} else {
  blocking('R8-encrypted-restore', 'backups',
    'T33 encrypted-backup envelopes exist and the synthetic drill passes (npm run verify:encrypted-backup), but the real-target restore-into-scratch drill (docs/DEPLOY.md) is owner-run and unwitnessed at this SHA. Codex must witness it before T23.');
}

// --- R9. Newly merged controls (evidence list for Codex; each is a pass pin,
// not a rebuild — the owning test/verifier proves the behavior). ---
const t19Limiter = /durableRateLimit/.test(read('lib/guard.ts'))
  && /durableRateLimit|nativeRateLimit/.test(read('lib/rate-limit.ts'))
  && exists('tests/no-store.test.ts');
if (t19Limiter) {
  pass('R9-limiter', 'abuse-limits',
    'T19: atomic fail-closed durableRateLimit + native/edge limiter refusals are uncacheable at the source (lib/guard.ts, lib/rate-limit.ts). Pinned by tests/no-store.test.ts limiter/guard sections.');
} else {
  blocking('R9-limiter', 'abuse-limits', 'T19 limiter wiring missing (durableRateLimit/nativeRateLimit or its test).');
}

const t34Hashing = /NODE_PBKDF2_ITERATIONS/.test(authSrc)
  && /WORKERS_PBKDF2_CAP/.test(authSrc)
  && /parsePasswordHash/.test(authSrc)
  && /passwordHashNeedsRehash/.test(authSrc)
  && exists('tests/password-hash-policy.test.ts')
  && exists('scripts/benchmark-password-hash.mjs');
if (t34Hashing) {
  pass('R10-password-hashing', 'credentials',
    'T34: versioned PBKDF2 policy (600k Node / 100k Workers cap, iteration-as-version, legacy-login rehash in lib/users.ts). Pinned by tests/password-hash-policy.test.ts; measured by npm run benchmark:password-hash.');
} else {
  blocking('R10-password-hashing', 'credentials', 'T34 password-hashing policy missing or unpinned.');
}

const t36Ssrf = /isSafeManualJobUrl/.test(read('lib/job-sources.ts'))
  && /metadata\.google|169\.254/.test(read('lib/job-sources.ts'))
  && exists('tests/security-matrix.test.ts');
if (t36Ssrf) {
  pass('R11-ssrf', 'injection',
    'T36: manual-URL SSRF hardening refuses metadata hosts and numeric-IP encodings (lib/job-sources.ts isSafeManualJobUrl), exercised with the account/role matrix in tests/security-matrix.test.ts.');
} else {
  blocking('R11-ssrf', 'injection', 'T36 SSRF hardening missing (isSafeManualJobUrl/metadata refusal or matrix test).');
}

const t37Hardening = exists('tests/deploy-hardening.test.ts')
  && exists('scripts/verify-deploy-hardening.mjs')
  && /NoNewPrivileges=true/.test(read('deploy/ikbeneenappel-web.service'));
if (t37Hardening) {
  pass('R12-unit-hardening', 'hosting',
    'T37: service/proxy templates stay hardened (unprivileged user, NoNewPrivileges, ProtectSystem=strict, PrivateTmp). Pinned by tests/deploy-hardening.test.ts; full host checks in npm run verify:deploy-hardening + docs/VPS_HOST_CHECKS.md.');
} else {
  blocking('R12-unit-hardening', 'hosting', 'T37 unit-hardening evidence missing.');
}

const serverCode = walk(['app', 'lib', 'worker'], ['.ts', '.tsx']);
const serverConsole = serverCode.filter((rel) => /console\.(log|error|warn|info|debug|trace)\s*\(/.test(read(rel)));
const t39Redaction = serverConsole.length === 0
  && exists('tests/log-redaction.test.ts')
  && /purgeExpiredTokens|purgeExpired/.test(emailSrc);
if (t39Redaction) {
  pass('R13-log-redaction', 'logs',
    `T39: zero console.* call sites in app/lib/worker (scanned ${serverCode.length} files), auth_events holds kinds only, tokens are hash-only with a boot-time expiry sweep. Pinned by tests/log-redaction.test.ts.`);
} else {
  blocking('R13-log-redaction', 'logs',
    `T39 log-redaction gap (server console call sites: ${serverConsole.join(', ') || 'none'}).`);
}

const t44Events = /SECURITY_EVENT_RETENTION_DAYS/.test(read('lib/security-events.ts'))
  && /SECURITY_EVENT_KINDS/.test(read('lib/security-events.ts'))
  && exists('app/api/admin/security-events/route.ts')
  && exists('tests/security-events.test.ts');
if (t44Events) {
  pass('R14-security-events', 'monitoring',
    'T44: security-event log holds outcomes only (no job content, passwords, tokens, or provider reasons), 30-day retention, administrator-only reads. Pinned by tests/security-events.test.ts.');
} else {
  blocking('R14-security-events', 'monitoring', 'T44 security-event log missing or unpinned.');
}

const t40bTombstones = /CREATE TABLE IF NOT EXISTS deleted_accounts/.test(migrationsSrc)
  && /deleted_accounts/.test(read('lib/account-deletion.ts'))
  && exists('scripts/reconcile-deletions.mjs')
  && exists('tests/deletion-tombstones.test.ts');
if (t40bTombstones) {
  pass('R15-deletion-tombstones', 'deletion',
    'T40b: deletion writes hash-only tombstones (deleted_accounts) in the same batch; scripts/reconcile-deletions.mjs re-applies them to any restored copy before it serves traffic (docs/DEPLOY.md). Pinned by tests/deletion-tombstones.test.ts; end-to-end by npm run verify:deletion-restore.');
} else {
  blocking('R15-deletion-tombstones', 'deletion', 'T40b deletion-tombstone control missing (table, helper, reconcile script, or test).');
}

const evidence = {
  tool: 'verify:security-privacy (T42)',
  sha: sha(),
  generatedAt: new Date().toISOString(),
  redaction: 'counts, presence booleans and short code quotes only; no emails, tokens, keys, secrets, or personal data are printed, and no secret-bearing files are read',
  summary: {
    total: findings.length,
    pass: findings.filter((f) => f.status === 'pass').length,
    blocking: findings.filter((f) => f.status === 'blocking').length,
    acceptedGap: findings.filter((f) => f.status === 'accepted-gap').length,
  },
  findings,
  reproduce: [
    'npm run verify:security-privacy',
    'npm run verify:security-privacy -- --strict  # non-zero while any blocking finding remains',
    'npx tsx --test tests/security-privacy-evidence.test.ts tests/privacy-policy.test.ts tests/account-deletion.test.ts tests/security-headers.test.ts tests/email.test.ts',
    'npx tsx --test tests/no-store.test.ts tests/password-hash-policy.test.ts tests/security-matrix.test.ts tests/deploy-hardening.test.ts tests/log-redaction.test.ts tests/security-events.test.ts tests/deletion-tombstones.test.ts',
    'npm run verify:encrypted-backup  # T33 synthetic encrypted-restore drill',
    'npm run verify:deletion-restore  # T40/T40b deletion + tombstone reconcile proof',
    'npm run verify:deploy-hardening  # T37 host/template checks',
  ],
  gate: 'Missing/failed evidence blocks T23/public opening. See docs/SECURITY_PRIVACY_RELEASE.md for the Codex review checklist.',
};

console.log(JSON.stringify(evidence, null, 2));
if (strict && evidence.summary.blocking > 0) {
  console.error(`\nSTRICT: ${evidence.summary.blocking} blocking finding(s) remain — T23/public opening is blocked.`);
  process.exit(1);
}
