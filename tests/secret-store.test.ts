import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SEALED_SECRET_KEYS,
  SERVICE_SECRETS_AAD,
  decodeUnlockKey,
  openServiceSecrets,
  rotateServiceSecrets,
  sealServiceSecrets,
  unlockKeyMatches,
} from '../lib/secret-store';

/**
 * T32 (F11) synthetic proof: persistent plaintext service secrets are
 * replaced by an encrypted envelope delivered at runtime, and
 * rotation/restart/revocation behave. All fixtures are synthetic
 * (`synthetic-…`, `example.invalid`); keys are random per run and never
 * committed. No production secret file is read or written.
 */

const dir = mkdtempSync(join(tmpdir(), 't32-secrets-'));
const envelopePath = join(dir, 'service-secrets.enc');
const backupPath = join(dir, 'service-secrets.enc.bak');

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const wrongKey = randomBytes(32);

// Synthetic stand-ins for SESSION_SECRET-class values. Distinct sentinels so
// a leak scan can attribute any occurrence to the exact value that leaked.
const FIXTURES = {
  SESSION_SECRET: 'synthetic-session-secret-t32-7f3a-example-invalid',
  RESEND_API_KEY: 'synthetic-resend-key-t32-9f2c-example-invalid',
  TURNSTILE_SECRET_KEY: 'synthetic-turnstile-secret-t32-51bd-example-invalid',
  INDEED_API_KEY: 'synthetic-indeed-key-t32-c04e-example-invalid',
};

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp dir only; a held handle on Windows must not fail the suite.
  }
});

function writtenBytes(): Buffer {
  const parts = [envelopePath, backupPath].filter((p) => existsSync(p)).map((p) => readFileSync(p));
  return Buffer.concat(parts);
}

function assertNoPlaintextLeak(context: string) {
  const bytes = writtenBytes();
  for (const value of Object.values(FIXTURES)) {
    assert.equal(bytes.includes(Buffer.from(value, 'utf8')), false, `${context}: synthetic value is readable at rest`);
  }
}

test('sealed envelope replaces the plaintext file and stays opaque at rest', () => {
  const envelope = sealServiceSecrets(FIXTURES, keyA);
  assert.match(envelope, /^senv1:/);
  writeFileSync(envelopePath, envelope, 'utf8');
  copyFileSync(envelopePath, backupPath);
  assertNoPlaintextLeak('envelope+backup');
  // Neither the raw unlock key nor its base64 form travels with the ciphertext.
  const bytes = writtenBytes();
  assert.equal(bytes.includes(keyA), false, 'raw unlock key bundled with envelope');
  assert.equal(bytes.includes(Buffer.from(keyA.toString('base64'), 'utf8')), false, 'encoded unlock key bundled');
});

test('injection survives restart: the same envelope re-opens in fresh memory', () => {
  const envelope = readFileSync(envelopePath, 'utf8');
  // Simulate a process restart: drop every reference, re-read both files.
  const reopenedEnvelope = Buffer.from(envelope, 'utf8').toString('utf8');
  const reopenedKey = decodeUnlockKey(keyA.toString('base64'));
  const injected = openServiceSecrets(reopenedEnvelope, reopenedKey);
  assert.deepEqual(injected, FIXTURES);
  // Subsystem injection takes only what it needs; nothing requires the whole map.
  assert.equal(injected.SESSION_SECRET, FIXTURES.SESSION_SECRET);
});

test('absent keys, wrong keys, wrong purpose, and tampering fail closed', () => {
  const envelope = readFileSync(envelopePath, 'utf8');
  assert.throws(() => decodeUnlockKey(undefined));
  assert.throws(() => decodeUnlockKey(''));
  assert.throws(() => decodeUnlockKey('too-short'));
  assert.throws(() => openServiceSecrets(envelope, wrongKey));
  assert.throws(() => openServiceSecrets(envelope, keyA, 'another-purpose:v1'));
  const segments = envelope.split(':');
  const mid = Math.floor(segments[2].length / 2);
  const flipped = `${segments[0]}:${segments[1]}:${segments[2].slice(0, mid)}${segments[2][mid] === 'A' ? 'B' : 'A'}${segments[2].slice(mid + 1)}`;
  assert.throws(() => openServiceSecrets(flipped, keyA));
  assert.equal(unlockKeyMatches(envelope, keyA), true);
  assert.equal(unlockKeyMatches(envelope, wrongKey), false);
});

test('rotation re-wraps to the new key; the old key stops working', () => {
  const envelope = readFileSync(envelopePath, 'utf8');
  const rotated = rotateServiceSecrets(envelope, keyA, keyB);
  assert.equal(openServiceSecrets(rotated, keyB).SESSION_SECRET, FIXTURES.SESSION_SECRET);
  assert.throws(() => openServiceSecrets(rotated, keyA));
  assert.throws(() => rotateServiceSecrets(envelope, wrongKey, keyB));
  // Persist the rotation the way an operator would: replace the envelope file.
  writeFileSync(envelopePath, rotated, 'utf8');
  assertNoPlaintextLeak('rotated envelope');
});

test('revocation replaces the envelope; nonsecret config stays plaintext by design', () => {
  // Revocation = new envelope with fresh synthetic values under a fresh key;
  // the old envelope no longer represents anything the app will accept.
  const freshKey = randomBytes(32);
  const fresh = {
    SESSION_SECRET: 'synthetic-session-secret-t32-revoked-example-invalid',
    RESEND_API_KEY: 'synthetic-resend-key-t32-revoked-example-invalid',
  };
  const revoked = sealServiceSecrets(fresh, freshKey);
  assert.equal(openServiceSecrets(revoked, freshKey).SESSION_SECRET, fresh.SESSION_SECRET);
  assert.throws(() => openServiceSecrets(revoked, keyB));
  // Unknown names are refused so a secret cannot silently fall outside the envelope.
  assert.throws(() => sealServiceSecrets({ SESSION_SECRET: 'x', NO_SUCH_SECRET: 'y' } as never, freshKey));
  assert.throws(() => sealServiceSecrets({ SESSION_SECRET: '' }, freshKey));
  // Nonsecret configuration is explicitly out of scope for the envelope.
  for (const name of ['RESEND_FROM', 'ALLOW_SIGNUPS', 'PORT', 'SQLITE_PATH'] as const) {
    assert.equal((SEALED_SECRET_KEYS as readonly string[]).includes(name), false, `${name} must stay plaintext config`);
  }
  assert.equal(SERVICE_SECRETS_AAD, 'ikbeneenappel-service-secrets:v1');
});
