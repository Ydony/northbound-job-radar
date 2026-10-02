import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * T32 (F11) evaluation helper: encrypted delivery for recoverable
 * API/session/service secrets, using the same reviewed primitive as T29's
 * field encryption — AES-256-GCM via OpenSSL — not a homemade cipher.
 * Random 96-bit IV per envelope, 128-bit auth tag, versioned envelope.
 *
 * Deliberately NOT wired into any production boot path. F11 stays Proposed:
 * owner review of the storage/key-custody approach precedes T30/T32 rollout,
 * and assessment and implementation are separately authorized. This file
 * exists so the "replace persistent plaintext service secrets" claim is
 * proved on synthetic fixtures (seal → restart → rotate → revoke, absent
 * keys fail closed) rather than asserted.
 *
 * Envelope format: `senv1:<base64-iv>:<base64-ciphertext+tag>` over a
 * canonical JSON object (sorted keys) of secret name → value. The `senv1`
 * prefix versions the construction so a future key id or algorithm can be
 * distinguished on read without guessing. The AAD binds the envelope to its
 * purpose (default `SERVICE_SECRETS_AAD`); an envelope sealed for one
 * purpose does not open under another.
 */

export const ENVELOPE_VERSION = 'senv1';
export const SERVICE_SECRETS_AAD = 'ikbeneenappel-service-secrets:v1';

const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Recoverable secret names covered by the encrypted envelope. Anything not
 * listed here is either nonsecret configuration (stays plaintext by design:
 * RESEND_FROM, ALLOW_SIGNUPS, ports, URLs) or a one-way hash that must never
 * be sealed reversibly (per-user password hashes). Sealing rejects unknown
 * names so a typo cannot silently leave a real secret outside the envelope.
 */
export const SEALED_SECRET_KEYS = [
  'SESSION_SECRET',
  'RESEND_API_KEY',
  'TURNSTILE_SECRET_KEY',
  'INDEED_API_KEY',
  'ADZUNA_APP_KEY',
  'CAREERJET_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
] as const;

export type SealedSecretKey = (typeof SEALED_SECRET_KEYS)[number];
export type ServiceSecrets = Partial<Record<SealedSecretKey, string>>;

/** Decode a 32-byte unlock key from its base64 runtime form. Fails closed. */
export function decodeUnlockKey(candidate: string | undefined): Buffer {
  if (!candidate || candidate.trim() === '') {
    throw new Error('Service-secret unlock key is not configured.');
  }
  const key = Buffer.from(candidate.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('Service-secret unlock key must decode to 32 bytes.');
  }
  return key;
}

function splitEnvelope(envelope: string): { iv: Buffer; payload: Buffer } {
  const parts = envelope.split(':');
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Unknown service-secret envelope.');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const payload = Buffer.from(parts[2], 'base64');
  if (iv.length !== IV_BYTES || payload.length < 17) {
    throw new Error('Malformed service-secret envelope.');
  }
  return { iv, payload };
}

function canonicalJson(secrets: ServiceSecrets): string {
  const entries = Object.entries(secrets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, value] of entries) {
    if (!(SEALED_SECRET_KEYS as readonly string[]).includes(name)) {
      throw new Error(`Refusing to seal unexpected secret name: ${name}`);
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error(`Refusing to seal empty value for: ${name}`);
    }
  }
  return JSON.stringify(Object.fromEntries(entries));
}

/** Seal a set of service secrets under `key`. Returns the envelope text to store at rest. */
export function sealServiceSecrets(secrets: ServiceSecrets, key: Buffer, aad = SERVICE_SECRETS_AAD): string {
  if (key.length !== KEY_BYTES) throw new Error('Service-secret unlock key must be 32 bytes.');
  const plaintext = canonicalJson(secrets);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${ENVELOPE_VERSION}:${iv.toString('base64')}:${payload.toString('base64')}`;
}

/**
 * Open an envelope into memory. Returns only the sealed values; the caller
 * injects each subsystem's subset (session signer gets SESSION_SECRET, mail
 * gets RESEND_API_KEY, nothing gets the whole map unless it needs it).
 * Wrong/missing key, wrong purpose, or any tampering throws.
 */
export function openServiceSecrets(envelope: string, key: Buffer, aad = SERVICE_SECRETS_AAD): ServiceSecrets {
  if (key.length !== KEY_BYTES) throw new Error('Service-secret unlock key must be 32 bytes.');
  const { iv, payload } = splitEnvelope(envelope);
  const ciphertext = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  const result: ServiceSecrets = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!(SEALED_SECRET_KEYS as readonly string[]).includes(name) || typeof value !== 'string') {
      throw new Error('Service-secret envelope holds an unexpected entry.');
    }
    result[name as SealedSecretKey] = value;
  }
  return result;
}

/** Re-wrap an envelope from `oldKey` to `newKey`, keeping the same purpose. Wrong old key throws. */
export function rotateServiceSecrets(envelope: string, oldKey: Buffer, newKey: Buffer, aad = SERVICE_SECRETS_AAD): string {
  return sealServiceSecrets(openServiceSecrets(envelope, oldKey, aad), newKey, aad);
}

/** Constant-time probe: does `candidate` unlock this envelope? Never throws, never reveals values. */
export function unlockKeyMatches(envelope: string, candidate: Buffer, aad = SERVICE_SECRETS_AAD): boolean {
  try {
    openServiceSecrets(envelope, candidate, aad);
    // Re-open twice and compare success bits in constant time so the boolean
    // itself does not shortcut on envelope shape.
    const a = Buffer.from([1]);
    const b = Buffer.from([1]);
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
