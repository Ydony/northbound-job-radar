/**
 * Encrypted backup envelope for the self-hosted target (F11/T33).
 *
 * SCOPE: this encrypts backup/replica artifacts AFTER a WAL checkpoint and
 * BEFORE they leave the host. It does not encrypt the live database file —
 * the running app necessarily holds plaintext and keys in memory (see the F11
 * protection contract). Live-file protection is volume/file permissions plus
 * a separately-controlled recovery key; see `docs/DEPLOY.md`.
 *
 * DESIGN (deliberately boring, no homemade cryptography):
 * - AES-256-GCM via `node:crypto` (`createCipheriv` / `createDecipheriv`),
 *   12-byte random nonce per file, 16-byte auth tag. Wrong keys, truncated
 *   files and flipped bytes fail authentication instead of returning garbage.
 * - The recovery key is a 256-bit random value, base64-encoded, supplied ONLY
 *   through `BACKUP_RECOVERY_KEY` or a root-owned 0600 file named by
 *   `BACKUP_RECOVERY_KEY_FILE`. It is never written into the backup directory,
 *   never logged, and never appears in the manifest — only a non-reversible
 *   SHA-256 fingerprint identifies which key a backup needs.
 * - Envelope layout v1: `NBENC1` (6 ASCII bytes) || nonce (12) || ciphertext+tag.
 *   The manifest records plaintext/ciphertext digests so a restore can prove
 *   what it decrypted, not just that decryption did not throw.
 *
 * LITESTREAM NOTE: Litestream replicates checkpointed SQLite pages; it is not
 * assumed to encrypt them. The replica bucket must use SSE (R2/B2 SSE-S3 or
 * equivalent) AND/OR hold only envelopes produced here. `verify:encrypted-backup`
 * proves the envelope path restores; it does not prove Litestream encrypts.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const BACKUP_ENVELOPE_MAGIC = 'NBENC1';
export const BACKUP_ENVELOPE_VERSION = 1;
export const BACKUP_ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/** Fail-closed key loader. Throws without ever including key material in the message. */
export function loadRecoveryKey(env: Record<string, string | undefined> = process.env): Buffer {
  const direct = (env.BACKUP_RECOVERY_KEY ?? '').trim();
  const fileRef = (env.BACKUP_RECOVERY_KEY_FILE ?? '').trim();
  if (direct && fileRef) {
    throw new Error('Set exactly one of BACKUP_RECOVERY_KEY / BACKUP_RECOVERY_KEY_FILE.');
  }
  const encoded = direct || (fileRef ? readFileSync(fileRef, 'utf8').split('\n')[0]?.trim() ?? '' : '');
  if (!encoded) {
    throw new Error('Backup recovery key is absent: set BACKUP_RECOVERY_KEY_FILE (preferred) or BACKUP_RECOVERY_KEY.');
  }
  let key: Buffer;
  try {
    key = Buffer.from(encoded, 'base64');
  } catch {
    throw new Error('Backup recovery key is not valid base64.');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`Backup recovery key must decode to ${KEY_BYTES} bytes.`);
  }
  return key;
}

/** Non-reversible identifier recorded in the manifest so an operator can match backup to key. */
export function recoveryKeyFingerprint(key: Buffer): string {
  return createHash('sha256').update('nb-backup-recovery-key-v1:').update(key).digest('hex').slice(0, 16);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function encryptBuffer(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('Recovery key must be 32 bytes.');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(BACKUP_ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from(BACKUP_ENVELOPE_MAGIC, 'ascii'), nonce, ciphertext]);
}

export function decryptBuffer(envelope: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('Recovery key must be 32 bytes.');
  const magic = envelope.subarray(0, BACKUP_ENVELOPE_MAGIC.length).toString('ascii');
  if (magic !== BACKUP_ENVELOPE_MAGIC) {
    throw new Error('Not an encrypted backup envelope (bad magic).');
  }
  const nonce = envelope.subarray(BACKUP_ENVELOPE_MAGIC.length, BACKUP_ENVELOPE_MAGIC.length + NONCE_BYTES);
  const rest = envelope.subarray(BACKUP_ENVELOPE_MAGIC.length + NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES || rest.length < 17) {
    throw new Error('Encrypted backup envelope is truncated.');
  }
  const tag = rest.subarray(rest.length - 16);
  const ciphertext = rest.subarray(0, rest.length - 16);
  const decipher = createDecipheriv(BACKUP_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
