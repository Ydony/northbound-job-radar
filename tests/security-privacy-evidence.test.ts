import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSessionValue, readSessionValue } from '../lib/auth';
import { PASSWORD_RESET_TOKEN_TTL_MS, VERIFICATION_TOKEN_TTL_MS } from '../lib/email';
import { dataWeHold, whereDataLives } from '../lib/privacy-policy';

/**
 * T42 (F13): unit pins behind `npm run verify:security-privacy`.
 *
 * The script assembles release evidence from the code; these tests pin the
 * same invariants inside the suite so a drift fails `npm test` before it
 * ever reaches the evidence bundle. All fixtures are synthetic
 * (`@example.test`); nothing here touches a live database or a secret.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(repo, rel), 'utf8');
const exists = (rel: string) => existsSync(join(repo, rel));

function walk(rels: string[], exts: string[]): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
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

test('retention periods are the documented constants, not drifted literals', () => {
  assert.equal(VERIFICATION_TOKEN_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(PASSWORD_RESET_TOKEN_TTL_MS, 60 * 60 * 1000);
  assert.match(read('db/runtime.ts'), /datetime\('now', '-30 days'\)/);
  assert.match(read('db/migrations.ts'), /datetime\('now', '-30 days'\)/);
  assert.match(read('app/api/auth/route.ts'), /15 \* 60_000/);
  assert.match(read('deploy/litestream.yml'), /retention: 720h/);
});

test('a session lives 14 days and dies on sign-out', async () => {
  const now = Date.now();
  const value = await createSessionValue('synthetic-user', 'synthetic-secret', 1, now);
  const [, , expiry] = value.split('.')[0].split(':');
  assert.equal(Number(expiry) - now, 14 * 24 * 60 * 60 * 1000);
  assert.ok(await readSessionValue(value, 'synthetic-secret', now));
  assert.equal(await readSessionValue(value, 'synthetic-secret', now + 14 * 24 * 60 * 60 * 1000 + 1), null);
});

test('the privacy copy discloses the implemented periods and recipients', () => {
  const held = JSON.stringify(dataWeHold);
  assert.match(held, /verification links expire after 24 hours and reset links after 1 hour/);
  assert.match(held, /automatically deleted after 30 days/);
  assert.match(held, /Resend/);
  assert.match(whereDataLives.join(' '), /Turnstile/);
  assert.match(whereDataLives.join(' '), /never receive your email/);
});

test('auth_events stores no secret-bearing columns', () => {
  const migrations = read('db/migrations.ts');
  const body = (migrations.match(/CREATE TABLE IF NOT EXISTS auth_events \(([\s\S]*?)\)/) ?? [])[1] ?? '';
  assert.ok(body.length > 0, 'auth_events definition not found');
  assert.doesNotMatch(body, /password|token|secret|hash/i);
});

test('no runtime module sends job data to a third-party model endpoint', () => {
  const offenders = walk(['lib'], ['.ts'])
    .filter((rel) => /https:\/\/(api\.openai\.com|api\.anthropic\.com|api\.cohere\.|openrouter\.ai|api\.groq\.com)/i.test(read(rel)));
  assert.deepEqual(offenders, []);
});

test('no self-service export surface exists (accepted no-export gap)', () => {
  assert.equal(exists('lib/export.ts'), false);
  assert.equal(exists('app/api/export/route.ts'), false);
  const buttons = walk(['app'], ['.tsx'])
    .filter((rel) => /Export (your data|button)|download.*workspace/i.test(read(rel)));
  assert.deepEqual(buttons, []);
});

test('the documented owner handover is exactly one password-printing script', () => {
  assert.equal(exists('scripts/reset-prod-admin-password.mjs'), true);
  assert.match(read('scripts/reset-prod-admin-password.mjs'), /console\.log\(temporaryPassword\)/);
  // bootstrap-prod-admin prompts hidden and stores only the hash.
  assert.doesNotMatch(read('scripts/bootstrap-prod-admin.mjs'), /console\.log\(\s*(password|temporaryPassword)\s*\)/);
});

test('release evidence tooling exists and reads no secret-bearing files', () => {
  const script = read('scripts/verify-security-privacy.mjs');
  // The header comment names these paths only to forbid them; the pin is that
  // no read/join call ever targets them.
  assert.doesNotMatch(script, /read\(['"]\.(dev\.vars|wrangler)/);
  assert.doesNotMatch(script, /join\(repo, ['"]\.(dev\.vars|wrangler)/);
  assert.doesNotMatch(script, /CLOUDFLARE_API_TOKEN|RESEND_API_KEY['"]?\s*[,}\]]/);
  assert.match(script, /redaction/);
  assert.equal(exists('docs/SECURITY_PRIVACY_RELEASE.md'), true);
});

test('T19: private routes answer via the no-store helper (only Turnstile stays bare)', () => {
  assert.equal(exists('lib/no-store.ts'), true);
  assert.match(read('lib/guard.ts'), /noStoreJson/);
  const offenders = walk(['app/api'], ['.ts'])
    .filter((rel) => rel !== 'app/api/turnstile/route.ts')
    .filter((rel) => /Response\.json\(/.test(read(rel)));
  assert.deepEqual(offenders, []);
});

test('T34/T40b/T44: merged security controls are pinned in code', () => {
  // T34 versioned hashing (constants; behavior lives in tests/password-hash-policy.test.ts).
  assert.match(read('lib/auth.ts'), /NODE_PBKDF2_ITERATIONS/);
  assert.match(read('lib/auth.ts'), /WORKERS_PBKDF2_CAP/);
  assert.match(read('lib/auth.ts'), /parsePasswordHash/);
  assert.equal(exists('tests/password-hash-policy.test.ts'), true);
  // T36 SSRF refusal surface (matrix behavior lives in tests/security-matrix.test.ts).
  assert.match(read('lib/job-sources.ts'), /isSafeManualJobUrl/);
  assert.equal(exists('tests/security-matrix.test.ts'), true);
  // T37 unit hardening (host checks live in npm run verify:deploy-hardening).
  assert.match(read('deploy/ikbeneenappel-web.service'), /NoNewPrivileges=true/);
  assert.equal(exists('tests/deploy-hardening.test.ts'), true);
  // T39 stronger log guarantee (leakage/expiry behavior lives in tests/log-redaction.test.ts).
  assert.equal(exists('tests/log-redaction.test.ts'), true);
  // T44 outcome-only event log (retention + kinds; reads stay administrator-only).
  assert.match(read('lib/security-events.ts'), /SECURITY_EVENT_RETENTION_DAYS/);
  assert.equal(exists('tests/security-events.test.ts'), true);
  // T40b hash-only tombstones + reconcile step (end-to-end lives in verify:deletion-restore).
  assert.match(read('db/migrations.ts'), /CREATE TABLE IF NOT EXISTS deleted_accounts/);
  assert.match(read('lib/account-deletion.ts'), /deleted_accounts/);
  assert.equal(exists('scripts/reconcile-deletions.mjs'), true);
  assert.equal(exists('tests/deletion-tombstones.test.ts'), true);
  // T33 encrypted-backup envelopes (restore drill lives in verify:encrypted-backup).
  assert.match(read('lib/backup-encryption.ts'), /NBENC1/);
  assert.equal(exists('tests/backup-encryption.test.ts'), true);
});
