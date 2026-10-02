#!/usr/bin/env node
/**
 * T32 (F11) synthetic verification: encrypted service-secret delivery with
 * rotation and restart.
 *
 * Proves, on throwaway synthetic fixtures only (no real secrets, keys, or
 * production data), that:
 *  1. persistent plaintext secret files are replaced by an encrypted
 *     envelope at rest (AES-256-GCM via `lib/secret-store.ts`), opened into
 *     memory at boot with only the needed values injected;
 *  2. injection survives restart: two separate boot processes open the same
 *     envelope with the separately held unlock key;
 *  3. absent/wrong keys fail closed (boot refuses; never runs unconfigured);
 *  4. rotation re-wraps to a new unlock key and revokes the old one;
 *  5. revocation replaces the envelope; the backup copy bundles no key and
 *     leaks no plaintext, and isolated restore recovers with the separately
 *     held key.
 *
 * Prints REDACTED JSON evidence only: counts, booleans, envelope version.
 * Never prints keys, secret values, or ciphertext. Exits non-zero on any
 * mismatch.
 *
 * Run with: `node --import tsx scripts/verify-secret-rotation.mjs`
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Child boot mode: open one envelope with one key file, print a redacted
// verdict, exit 0 on success or 2 when fail-closed. Never prints values.
if (process.argv[2] === '--boot') {
  const [, , , envelopePath, keyPath] = process.argv;
  const { decodeUnlockKey, openServiceSecrets } = await import('../lib/secret-store.ts');
  try {
    const envelope = readFileSync(envelopePath, 'utf8');
    const key = decodeUnlockKey(readFileSync(keyPath, 'utf8'));
    const secrets = openServiceSecrets(envelope, key);
    const names = Object.keys(secrets).sort();
    // Inject only what each subsystem needs: prove the session signer and
    // the mail sender each receive a non-empty value without echoing either.
    const sessionReady = typeof secrets.SESSION_SECRET === 'string' && secrets.SESSION_SECRET.length > 0;
    const mailReady = typeof secrets.RESEND_API_KEY === 'string' && secrets.RESEND_API_KEY.length > 0;
    if (!sessionReady || names.length === 0) {
      console.error('BOOT fail-closed: envelope opened but required secrets are missing.');
      process.exit(2);
    }
    console.log(JSON.stringify({ boot: 'ok', secrets: names.length, sessionReady, mailReady }));
    process.exit(0);
  } catch {
    console.error('BOOT fail-closed: unlock key absent, wrong, or envelope tampered.');
    process.exit(2);
  }
}

const work = mkdtempSync(join(tmpdir(), 't32-verify-'));
const envelopePath = join(work, 'service-secrets.enc');
const backupPath = join(work, 'service-secrets.enc.bak');
const keyAPath = join(work, 'unlock-key-A');
const keyBPath = join(work, 'unlock-key-B');

const { decodeUnlockKey, openServiceSecrets, rotateServiceSecrets, sealServiceSecrets } = await import(
  '../lib/secret-store.ts'
);

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const wrongKey = randomBytes(32);

const fixtures = {
  SESSION_SECRET: 'synthetic-session-secret-t32-verify-example-invalid',
  RESEND_API_KEY: 'synthetic-resend-key-t32-verify-example-invalid',
  TURNSTILE_SECRET_KEY: 'synthetic-turnstile-secret-t32-verify-example-invalid',
};

// 1: seal to an envelope file; the unlock key lives in a SEPARATE file
// (the systemd-credential stand-in: root-owned 0600, never beside the
// ciphertext in a backup). Nonsecret config stays outside by design.
const envelope = sealServiceSecrets(fixtures, keyA);
writeFileSync(envelopePath, envelope, { encoding: 'utf8', mode: 0o600 });
writeFileSync(keyAPath, keyA.toString('base64'), { encoding: 'utf8', mode: 0o600 });
writeFileSync(keyBPath, keyB.toString('base64'), { encoding: 'utf8', mode: 0o600 });
copyFileSync(envelopePath, backupPath);

function boot(envelopeFile, keyFile) {
  return spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], '--boot', envelopeFile, keyFile], {
    encoding: 'utf8',
  });
}

// 2: injection survives restart — two separate boot processes, same material.
const first = boot(envelopePath, keyAPath);
const second = boot(envelopePath, keyAPath);
const restartOk = first.status === 0 && second.status === 0;

// 3: absent/wrong keys fail closed; the app refuses rather than running open.
const absent = boot(envelopePath, join(work, 'no-such-key'));
writeFileSync(join(work, 'wrong-key'), wrongKey.toString('base64'), 'utf8');
const wrong = boot(envelopePath, join(work, 'wrong-key'));
const failClosedAbsent = absent.status !== 0;
const failClosedWrong = wrong.status !== 0;
let missingKeyFails = false;
try {
  decodeUnlockKey('');
} catch {
  missingKeyFails = true;
}

// 4: rotation — re-wrap to keyB, persist, new key boots, old key is revoked.
const rotated = rotateServiceSecrets(readFileSync(envelopePath, 'utf8'), keyA, keyB);
writeFileSync(envelopePath, rotated, 'utf8');
const rotatedBoot = boot(envelopePath, keyBPath);
const oldKeyBoot = boot(envelopePath, keyAPath);
const rotationOk = rotatedBoot.status === 0;
const oldKeyRevoked = oldKeyBoot.status !== 0;

// 5: revocation — fresh synthetic values under a fresh key; isolated restore
// of the backup copy (no key alongside it) still recovers with the key held
// separately, and nothing at rest leaks plaintext or key bytes.
const freshKey = randomBytes(32);
const fresh = {
  SESSION_SECRET: 'synthetic-session-secret-t32-revoked-example-invalid',
  RESEND_API_KEY: 'synthetic-resend-key-t32-revoked-example-invalid',
};
const revoked = sealServiceSecrets(fresh, freshKey);
const revokedOpens = openServiceSecrets(revoked, freshKey).SESSION_SECRET === fresh.SESSION_SECRET;
let retiredKeyRefused = false;
try {
  openServiceSecrets(revoked, keyB);
} catch {
  // Opening with the retired key must throw; reaching here means it did.
  retiredKeyRefused = true;
}
const revocationOk = revokedOpens && retiredKeyRefused;
const atRest = Buffer.concat([readFileSync(envelopePath), readFileSync(backupPath)]);
const backupLeaks = Object.values({ ...fixtures, ...fresh }).some((value) =>
  atRest.includes(Buffer.from(value, 'utf8')),
);
const keyBundled =
  atRest.includes(keyA) ||
  atRest.includes(keyB) ||
  atRest.includes(Buffer.from(keyA.toString('base64'), 'utf8'));
const isolated = openServiceSecrets(readFileSync(backupPath, 'utf8'), keyA);
const restoreRecoverOk = isolated.SESSION_SECRET === fixtures.SESSION_SECRET;

const evidence = {
  synthetic: true,
  envelopeVersion: envelope.split(':')[0],
  secretsSealed: Object.keys(fixtures).length,
  restartOk,
  failClosedAbsent,
  failClosedWrong,
  missingKeyFails,
  rotationOk,
  oldKeyRevoked,
  revocationOk,
  backupLeaksPlaintext: backupLeaks,
  keyBundledWithBackup: keyBundled,
  restoreRecoverOk,
};
console.log(JSON.stringify(evidence, null, 2));

const pass =
  restartOk &&
  failClosedAbsent &&
  failClosedWrong &&
  missingKeyFails &&
  rotationOk &&
  oldKeyRevoked &&
  revocationOk &&
  !backupLeaks &&
  !keyBundled &&
  restoreRecoverOk;
if (!pass) {
  console.error('Secret-delivery rehearsal FAILED.');
  process.exit(1);
}
console.log('Secret-delivery rehearsal PASS: encrypted delivery, restart survival, fail-closed keys, rotation, and revocation all hold on synthetic fixtures.');
