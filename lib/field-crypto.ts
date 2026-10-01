import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * T29 (F11) evaluation helper: field-level encryption for private database
 * values, using a reviewed primitive — AES-256-GCM via OpenSSL — not a
 * homemade cipher. Random 96-bit IV per value, 128-bit auth tag; tampering,
 * truncation or a wrong key fails authentication instead of returning
 * corrupted plaintext.
 *
 * Deliberately NOT wired into any production query path. Owner review of the
 * storage/key-custody approach precedes T30/T32, and F11 stays Proposed until
 * assessment and implementation are separately authorized. This file exists so
 * the assessment's compatibility claim (adapter + file-copy/Litestream-shape
 * backup roundtrip, fail-closed without the key) is proved on synthetic
 * fixtures rather than asserted.
 *
 * Envelope format: `v1:<base64-iv>:<base64-ciphertext+tag>`. The `v1` prefix
 * versions the construction so a future rotation (key id, algorithm) can be
 * distinguished on read without guessing.
 */

const ENVELOPE_VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Decode a 32-byte data-encryption key from its base64 runtime form. Fails closed. */
export function decodeDataKey(candidate: string | undefined): Buffer {
  if (!candidate || candidate.trim() === '') {
    throw new Error('Field encryption key is not configured.');
  }
  let key: Buffer;
  try {
    key = Buffer.from(candidate.trim(), 'base64');
  } catch {
    throw new Error('Field encryption key is not valid base64.');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error('Field encryption key must decode to 32 bytes.');
  }
  return key;
}

function splitEnvelope(envelope: string): { iv: Buffer; payload: Buffer } {
  const parts = envelope.split(':');
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Unknown field encryption envelope.');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const payload = Buffer.from(parts[2], 'base64');
  if (iv.length !== IV_BYTES || payload.length < 17) {
    throw new Error('Malformed field encryption envelope.');
  }
  return { iv, payload };
}

/** Encrypt one private value. The `aad` binds the ciphertext to its row context; a copy into another row will not decrypt. */
export function encryptField(plaintext: string, key: Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) throw new Error('Field encryption key must be 32 bytes.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Tag-in-payload keeps one TEXT column sufficient; GCM verifies it on open.
  const payload = Buffer.concat([ciphertext, tag]);
  return `${ENVELOPE_VERSION}:${iv.toString('base64')}:${payload.toString('base64')}`;
}

/** Decrypt one private value. Wrong/missing key, wrong `aad`, or any tampering throws — never returns a guess. */
export function decryptField(envelope: string, key: Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) throw new Error('Field encryption key must be 32 bytes.');
  const { iv, payload } = splitEnvelope(envelope);
  // Ciphertext || 16-byte tag.
  const ciphertext = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Re-wrap one value from `oldKey` to `newKey`, keeping the same row binding. Wrong old key throws; nothing is written. */
export function rotateField(envelope: string, oldKey: Buffer, newKey: Buffer, aad: string): string {
  return encryptField(decryptField(envelope, oldKey, aad), newKey, aad);
}

/** Constant-time check used by the secret-injection PoC: does this candidate unlock the probe envelope? */
export function keyUnlocksProbe(probe: { envelope: string; aad: string; expected: string }, candidate: Buffer): boolean {
  try {
    const opened = decryptField(probe.envelope, candidate, probe.aad);
    const a = Buffer.from(opened, 'utf8');
    const b = Buffer.from(probe.expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
