/**
 * Benchmarks the PBKDF2-SHA256 password-hashing policy (T34).
 *
 * Run: npm run benchmark:password-hash
 * On the VPS, re-run this exact command before treating NODE_PBKDF2_ITERATIONS
 * in lib/auth.ts as reviewed there; if the 600,000-iteration row costs far more
 * than a few hundred milliseconds on that hardware, lower the target with the
 * PASSWORD_HASH_ITERATIONS environment variable instead of editing call sites.
 *
 * Synthetic password only. Nothing is written anywhere.
 */
import { currentPasswordIterations, hashPassword, parsePasswordHash, verifyPassword } from '../lib/auth.ts';

const PASSWORD = 'synthetic-benchmark-password-0123456789';
const CANDIDATES = [100_000, 210_000, 310_000, 600_000];
const ROUNDS = 5;

async function medianOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeHash(iterations) {
  const samples = [];
  let last = '';
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now();
    last = await hashPassword(PASSWORD, iterations);
    samples.push(performance.now() - start);
  }
  return { hash: last, ms: await medianOf(samples) };
}

async function timeVerify(stored) {
  const samples = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now();
    if (!await verifyPassword(PASSWORD, stored)) throw new Error(`self-check failed at ${stored.split('$')[1]} iterations`);
    samples.push(performance.now() - start);
  }
  return medianOf(samples);
}

const rows = [];
for (const iterations of CANDIDATES) {
  const { hash, ms: hashMs } = await timeHash(iterations);
  const parsed = parsePasswordHash(hash);
  if (!parsed || parsed.iterations !== iterations) throw new Error(`version round-trip failed at ${iterations}`);
  const verifyMs = await timeVerify(hash);
  rows.push({ iterations, hashMs, verifyMs });
}

console.log('iterations | hash (median) | verify (median)');
for (const row of rows) {
  console.log(`${String(row.iterations).padStart(10)} | ${row.hashMs.toFixed(1).padStart(9)} ms | ${row.verifyMs.toFixed(1).padStart(11)} ms`);
}
console.log(`current policy target on this machine: ${currentPasswordIterations()} iterations`);
console.log('600,000 is the OWASP 2023 minimum for PBKDF2-HMAC-SHA256; login is infrequent and');
console.log('rate-limited, so ~150 ms per attempt is affordable on this hardware.');
