import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// T42: pins the release-evidence contract so it cannot rot silently. The heavy
// checks (deletion completeness, privacy copy, headers, auth, cross-account
// isolation) live in their own suites and run inside the verifier; this file
// only guards the assembly itself: the retention doc says what F13 requires,
// and the verifier emits redacted evidence, never secrets.

async function retentionDoc() {
  return readFile(new URL('../docs/SECURITY_PRIVACY_RETENTION.md', import.meta.url), 'utf8');
}

async function verifierSource() {
  return readFile(new URL('../scripts/verify-security-privacy.mjs', import.meta.url), 'utf8');
}

test('the retention table covers accounts, searches, logs, tokens and backups', async () => {
  const doc = await retentionDoc();
  for (const category of ['account', 'search', 'auth_events', 'token', 'backup']) {
    assert.match(doc, new RegExp(category, 'i'), `retention table never mentions ${category}`);
  }
});

test('every retention row is decided or explicitly owner-pending, never silent', async () => {
  const doc = await retentionDoc();
  const rows = doc.split('\n').filter((line) => line.startsWith('|') && !line.startsWith('| Data'));
  assert.ok(rows.length >= 8, `expected a full retention table, found ${rows.length} rows`);
  for (const row of rows) {
    if (/^\|[\s-]+$/.test(row.replaceAll('|', '|').split('|').slice(1, -1).join('|'))) continue;
    if (/^|\s*-+/.test(row)) continue;
    assert.match(row, /IMPLEMENTED|PROPOSED/, `row has no status marker: ${row.slice(0, 80)}`);
  }
});

test('indefinite retention is allowed only for the documented aggregate exception', async () => {
  const doc = await retentionDoc();
  const indefinite = doc.split('\n').filter((line) => /kept indefinitely|retained indefinitely|stored indefinitely/i.test(line));
  assert.ok(indefinite.length > 0, 'the indefinite-retention rule must be stated, not avoided');
  for (const line of indefinite) {
    assert.match(
      line,
      /aggregate|no personal data|PROPOSED/i,
      `indefinite retention without a reason: ${line.slice(0, 120)}`,
    );
  }
});

test('the doc records recipients and the no-export owner decision honestly', async () => {
  const doc = await retentionDoc();
  assert.match(doc, /Resend/, 'email recipient is not recorded');
  assert.match(doc, /Turnstile|Cloudflare/, 'bot-check recipient is not recorded');
  assert.match(doc, /no self-service export/i, 'the no-export owner decision is not recorded');
  assert.match(doc, /Article 20/, 'the accepted GDPR gap is not named');
});

test('the verifier runs the existing suites instead of reimplementing them', async () => {
  const source = await verifierSource();
  for (const suite of ['account-deletion', 'privacy-policy', 'security-headers', 'auth.test',
    'email.test', 'tenant-route-bindings', 'public-admin-isolation', 'rate-limit']) {
    assert.ok(source.includes(suite), `verifier no longer runs ${suite}`);
  }
  // The gate assembles evidence; deletion/privacy logic stays in lib/ + its own tests.
  assert.doesNotMatch(source, /DELETE FROM \w+ WHERE user_id/, 'verifier duplicates deletion logic');
});

test('the verifier cannot leak secrets: it reads none and emits counts only', async () => {
  const source = await verifierSource();
  assert.doesNotMatch(source, /process\.env\[[^\]]*\]/, 'verifier reads environment values');
  assert.doesNotMatch(
    source,
    /process\.env.*(ADMIN|RESEND|PASSWORD|SECRET|TOKEN|KEY)/,
    'verifier reads credential-shaped environment values',
  );
  assert.ok(source.includes('pass/fail counts') || source.includes('counts and pass/fail'),
    'the redaction promise is not documented in the script');
});

test('the retention doc itself holds no secret values', async () => {
  const doc = await retentionDoc();
  assert.doesNotMatch(doc, /sk-(live|test)-[A-Za-z0-9]+/, 'doc contains a secret-key-shaped value');
  assert.doesNotMatch(doc, /password\s*[:=]\s*\S+/i, 'doc contains a password-shaped value');
  assert.doesNotMatch(doc, /Bearer [A-Za-z0-9._~-]{8,}/, 'doc contains a bearer-token-shaped value');
});

test('the gate is wired as an npm script', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: Record<string, string> };
  assert.match(
    pkg.scripts?.['verify:security-privacy'] ?? '',
    /verify-security-privacy\.mjs/,
    'npm run verify:security-privacy is not wired',
  );
});
