import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  BACKUP_ENVELOPE_MAGIC,
  decryptBuffer,
  encryptBuffer,
  loadRecoveryKey,
  recoveryKeyFingerprint,
} from '../lib/backup-encryption';

/**
 * T33 (F11): unit contract for the encrypted-backup envelope.
 * The end-to-end drill (checkpoint -> encrypt -> isolated restore) lives in
 * `scripts/verify-encrypted-backup.mjs`; these tests pin the envelope rules
 * without touching a database. All fixtures synthetic.
 */

test('encrypt/decrypt round-trips private fixtures with the correct key', () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('SYNTH-FIXTURE private criteria + saved-job relation', 'utf8');
  const envelope = encryptBuffer(plaintext, key);
  assert.ok(!envelope.includes('SYNTH-FIXTURE'), 'ciphertext must not contain plaintext');
  assert.equal(envelope.subarray(0, 6).toString('ascii'), BACKUP_ENVELOPE_MAGIC);
  assert.deepEqual(decryptBuffer(envelope, key), plaintext);
});

test('nonces differ per file so identical plaintexts give different envelopes', () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('same bytes', 'utf8');
  assert.ok(!encryptBuffer(plaintext, key).equals(encryptBuffer(plaintext, key)));
});

test('wrong key fails authentication instead of returning garbage', () => {
  const envelope = encryptBuffer(Buffer.from('synthetic private row', 'utf8'), randomBytes(32));
  assert.throws(() => decryptBuffer(envelope, randomBytes(32)));
});

test('flipped byte or truncated envelope fails closed', () => {
  const key = randomBytes(32);
  const envelope = encryptBuffer(Buffer.from('synthetic private row', 'utf8'), key);
  const flipped = Buffer.from(envelope);
  flipped[flipped.length - 1] ^= 0x01;
  assert.throws(() => decryptBuffer(flipped, key));
  assert.throws(() => decryptBuffer(envelope.subarray(0, 10), key), /truncated|magic/);
  assert.throws(() => decryptBuffer(Buffer.from('plain sqlite bytes', 'utf8'), key), /magic/);
});

test('key loader fails closed and never echoes key material', () => {
  assert.throws(() => loadRecoveryKey({}), /absent/);
  assert.throws(() => loadRecoveryKey({ BACKUP_RECOVERY_KEY: 'short' }), /32 bytes/);
  assert.throws(
    () => loadRecoveryKey({ BACKUP_RECOVERY_KEY: randomBytes(32).toString('base64'), BACKUP_RECOVERY_KEY_FILE: '/x' }),
    /exactly one/,
  );
  const key = randomBytes(32);
  const loaded = loadRecoveryKey({ BACKUP_RECOVERY_KEY: key.toString('base64') });
  assert.ok(loaded.equals(key));
});

test('manifest fingerprint identifies the key without revealing it', () => {
  const key = randomBytes(32);
  const fingerprint = recoveryKeyFingerprint(key);
  assert.equal(fingerprint.length, 16);
  assert.ok(!key.toString('base64').includes(fingerprint));
  assert.equal(recoveryKeyFingerprint(key), fingerprint);
  assert.notEqual(recoveryKeyFingerprint(randomBytes(32)), fingerprint);
});
