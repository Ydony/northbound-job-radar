import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Pinning test for the F9/T27 branding + optional-VPN decision note.
 *
 * F9 requires each idea to carry a benefit, a permission/cost/privacy assessment,
 * and an owner decision — and states that only separately approved ideas become
 * implementation work. This test fails if the note loses any of those parts, or if
 * it stops restating the no-evasion boundary it was written to preserve. It checks
 * prose, not behavior; the enforced gates live in collection-budgets, job-adapters,
 * and admin-discovery-isolation tests.
 */

const NOTE_URL = new URL('../docs/BRANDING_VPN_DECISION.md', import.meta.url);

async function note() {
  return readFile(NOTE_URL, 'utf8');
}

test('the decision note covers branding: benefit, assessment, and owner decision', async () => {
  const text = await note();
  assert.match(text, /## 1\. Separate branding/, 'the branding idea must have its own section');
  assert.match(text, /\*\*Benefit\.\*\*/, 'branding must state its benefit');
  assert.match(text, /Permission \/ cost \/ privacy assessment/, 'branding must carry the assessment');
  assert.match(text, /\*\*Owner decision\.\*\*[\s\S]*?owner's domain/, 'branding decision keeps the owner domain');
  assert.match(text, /no ChatGPT branding/, 'branding decision preserves the no-ChatGPT-branding rule');
});

test('the decision note covers optional VPN: benefit, assessment, and owner decision', async () => {
  const text = await note();
  assert.match(text, /## 2\. Optional VPN/, 'the VPN idea must have its own section');
  assert.match(text, /VPN changes the visible source IP/, 'VPN must be framed as IP shielding, not permission');
  assert.match(text, /never requests or stores VPN credentials/, 'VPN must restate the credential boundary');
  assert.match(text, /stays optional/, 'VPN must stay optional, never required for ordinary search');
});

test('the decision note preserves the no-evasion boundary', async () => {
  const text = await note();
  for (const banned of [
    /no randomized or human-imitating timing/,
    /no fingerprint spoofing/,
    /no headless-browser stealth/,
    /no proxy rotation, IP cycling/,
    /a block is a\s+stop signal/,
    /no automated source-site login/,
  ]) {
    assert.match(text, banned, `the note must restate the boundary: ${banned}`);
  }
});

test('the note approves nothing: separate implementation approval, no automatic purchase', async () => {
  const text = await note();
  assert.match(text, /separately approved implementation feature/,
    'each idea must require separate approval before becoming work');
  assert.match(text, /No [\s\S]*?purchase[\s\S]*?or integration follows automatically/,
    'the note must disclaim automatic purchase/integration');
});

test('the boundaries the note cites still exist where it says they do', async () => {
  const [vpn, plan, policy] = await Promise.all([
    readFile(new URL('../docs/VPN.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/PUBLIC_ADMIN_INTEGRATION_PLAN.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/SOURCE_POLICY.md', import.meta.url), 'utf8'),
  ]);
  assert.match(vpn, /Do not add proxy rotation, IP cycling, fingerprint spoofing, or bot-detection evasion\./,
    'docs/VPN.md must still state the evasion prohibition the note cites');
  assert.match(plan, /Do not introduce auto-application, source-site login, or new branding\./,
    'the integration plan must still forbid new branding');
  assert.match(plan, /with no ChatGPT branding or login/,
    'the integration plan must still rule out ChatGPT branding');
  assert.match(policy, /no-evasion rule/, 'docs/SOURCE_POLICY.md must still record the no-evasion rule');
});
