import { readFileSync } from 'node:fs';

/**
 * Database key injection and fail-closed open policy (F11, T30).
 *
 * What this module is: the seam where an encrypted database key enters the
 * self-hosted stack, and the checks that refuse to run when the key story is
 * wrong. Every error path here fails closed — the process throws during
 * `bindings()`, before any query runs — and no error message, status report,
 * or log line ever carries key material.
 *
 * What this module is NOT: encryption itself. The self-hosted driver is
 * `node:sqlite`, which ships no cipher (`PRAGMA key` is not implemented), so
 * `db/sqlite-adapter.ts` cannot turn a key into an encrypted file. Until the
 * owner-selected cipher driver from T29 lands behind the same adapter, any
 * keyed open is refused rather than silently downgraded to plaintext. A key
 * that is accepted but ignored would be worse than no key at all: the operator
 * would believe the database is encrypted while a file copy reads clean.
 *
 * Consequences, stated plainly so nobody has to rediscover them:
 * - `DB_ENCRYPTION_REQUIRED=true` without a usable cipher driver keeps the app
 *   down. That is the intended fail-closed posture, not a bug to work around
 *   by unsetting the flag.
 * - WAL/SHM sidecars, temp files, Litestream copies, and exports are plaintext
 *   until the cipher lands. Do not assume the backup tooling works unchanged
 *   with an encrypted database (F11 protection contract).
 * - Key custody: `SQLITE_KEY_FILE` (a root-owned `0600` file, e.g. alongside
 *   the systemd `EnvironmentFile`) is preferred over `SQLITE_KEY`. The key is
 *   held in memory only for the open call and never serialized.
 */

export interface DatabaseKeyMaterial {
  /** Where the key came from. Reported in status; the value itself never is. */
  source: 'SQLITE_KEY' | 'SQLITE_KEY_FILE';
  key: string;
}

export interface DatabaseOpenPolicy {
  path: string;
  key: DatabaseKeyMaterial | undefined;
  encryptionRequired: boolean;
  /** False on the current `node:sqlite` driver: it has no cipher to inject into. */
  driverSupportsEncryption: boolean;
}

const REQUIRED_FLAG = 'DB_ENCRYPTION_REQUIRED';

/** True only for the exact string 'true'. Anything else — including unset — means plaintext dev/test posture. */
export function isEncryptionRequired(env: Record<string, unknown>): boolean {
  return env[REQUIRED_FLAG] === 'true';
}

/**
 * Resolve the database key from the environment. `SQLITE_KEY_FILE` wins over
 * `SQLITE_KEY` when both are set, so a file-backed deployment cannot be
 * shadowed by a stale inline value.
 *
 * Throws fail-closed when `SQLITE_KEY_FILE` points at a file that cannot be
 * read or holds only whitespace: a half-configured key must stop the boot,
 * not fall through to an unencrypted open.
 */
export function resolveDatabaseKey(env: Record<string, unknown>): DatabaseKeyMaterial | undefined {
  const filePath = env.SQLITE_KEY_FILE;
  if (typeof filePath === 'string' && filePath !== '') {
    let contents: string;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      throw new Error(`SQLITE_KEY_FILE cannot be read; refusing to open the database without its key. (${filePath})`);
    }
    if (contents.trim() === '') {
      throw new Error('SQLITE_KEY_FILE is empty; refusing to open the database without its key.');
    }
    return { source: 'SQLITE_KEY_FILE', key: contents.trim() };
  }
  const inline = env.SQLITE_KEY;
  if (typeof inline === 'string' && inline.trim() !== '') {
    return { source: 'SQLITE_KEY', key: inline.trim() };
  }
  return undefined;
}

/**
 * The fail-closed gate. Returns the policy for the caller to act on, or throws
 * before any file is opened:
 * - required but no key: refuse (would otherwise boot plaintext against policy).
 * - key supplied but the driver has no cipher: refuse (would otherwise accept
 *   a key and ignore it, which reads as encrypted while staying plaintext).
 */
export function decideDatabaseOpen(policy: DatabaseOpenPolicy): { path: string; key: string | undefined } {
  if (policy.encryptionRequired && !policy.key) {
    throw new Error(`${REQUIRED_FLAG} is set but no database key was provided (SQLITE_KEY_FILE or SQLITE_KEY); refusing to open the database.`);
  }
  if (policy.key && !policy.driverSupportsEncryption) {
    throw new Error(
      `A database key was provided via ${policy.key.source} but this build's SQLite driver offers no cipher; ` +
        'refusing to open as plaintext. This needs the owner-selected encryption driver (F11/T29) before keyed opens can succeed.',
    );
  }
  return { path: policy.path, key: policy.key?.key };
}

/**
 * Safe-to-log status: key presence and source only, never key material.
 * Suitable for health checks and verify scripts.
 */
export function databaseEncryptionStatus(policy: Omit<DatabaseOpenPolicy, 'key'> & { keyPresent: boolean; keySource?: DatabaseKeyMaterial['source'] }) {
  return {
    encrypted: false,
    encryptionRequired: policy.encryptionRequired,
    keyPresent: policy.keyPresent,
    ...(policy.keySource ? { keySource: policy.keySource } : {}),
    driverSupportsEncryption: policy.driverSupportsEncryption,
  };
}
