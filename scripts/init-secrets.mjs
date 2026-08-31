#!/usr/bin/env node
/**
 * Generates a separate SESSION_SECRET for .dev.vars.dev or .dev.vars.test.
 *
 * Accounts and passwords live in the database, created through the sign-up form; this only creates
 * the key that signs session cookies. Rotating it signs every user out, which is the fastest way to
 * revoke access if a cookie is ever exposed.
 */
import { webcrypto as crypto } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const environment = process.argv.find((argument) => argument === 'dev' || argument === 'test');
if (!environment) {
  console.error('Usage: node scripts/init-secrets.mjs <dev|test> [--rotate]');
  process.exit(1);
}

const FILE = `.dev.vars.${environment}`;
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

const legacy = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8') : '';
const existing = existsSync(FILE)
  ? readFileSync(FILE, 'utf8')
  : legacy
      .split(/\r?\n/)
      .filter((line) => !/^SESSION_SECRET=/.test(line))
      .join('\n');
if (/^SESSION_SECRET=.+/m.test(existing) && !process.argv.includes('--rotate')) {
  console.log('SESSION_SECRET is already set. Pass --rotate to replace it (this signs everyone out).');
  process.exit(0);
}

const kept = existing.split(/\r?\n/).filter((line) => !/^SESSION_SECRET=/.test(line)).join('\n');
writeFileSync(FILE, `${kept.trimEnd()}\n`);
appendFileSync(FILE, `\n# Signs session cookies. Rotating this signs every user out.\nSESSION_SECRET=${secret}\n`);
console.log(`Wrote a ${environment}-only SESSION_SECRET to ${FILE}.`);
console.log('The first account created becomes the administrator and adopts any existing workspace data.');
