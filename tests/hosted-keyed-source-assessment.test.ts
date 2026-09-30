import assert from 'node:assert/strict';
import test from 'node:test';
import { adminOnlySourceKeys, jobSourceAdapters } from '../lib/job-adapters';
import { HOSTED_SOURCE_ASSESSMENTS, hostedAssessmentFor } from '../lib/hosted-sources';
import { isAccessRefusal, isRuntimeBudgetExhausted } from '../lib/collection-budgets';
import { indeedReadiness } from '../lib/indeed/auth';

// T13 (F4): hosted assessment for Adzuna/Careerjet credentials, site/IP requirements, and
// Indeed's separate local boundary. Entirely synthetic: no upstream traffic, no real keys,
// no production data. The matrix names environment VARIABLES only; the last test trips if
// anything shaped like a secret VALUE ever lands in it.

test('every administrator-side adapter has exactly one hosted decision', () => {
  // Administrator-side means hidden from ordinary accounts: the adminOnly gate set plus the
  // Indeed experiment keys, matching how the scrape and state routes withhold them.
  const hidden = adminOnlySourceKeys();
  const adminAdapters = jobSourceAdapters.filter((adapter) =>
    hidden.has(adapter.key) || adapter.experimentalIndeed);
  assert.ok(adminAdapters.length > 0, 'expected administrator-side adapters');
  const assessed = new Set(HOSTED_SOURCE_ASSESSMENTS.map((entry) => entry.key));
  for (const adapter of adminAdapters) {
    assert.ok(assessed.has(adapter.key),
      `${adapter.key} has no hosted decision: assess it before launch (supported, configuration-needed, or blocked)`);
  }
  for (const entry of HOSTED_SOURCE_ASSESSMENTS) {
    assert.ok(jobSourceAdapters.some((adapter) => adapter.key === entry.key),
      `${entry.key} assesses a removed adapter: drop the stale row`);
  }
  assert.equal(assessed.size, HOSTED_SOURCE_ASSESSMENTS.length, 'a hosted decision repeats a key');
});

test('hosted decisions use only the three review-gate verdicts', () => {
  for (const entry of HOSTED_SOURCE_ASSESSMENTS) {
    assert.ok(['supported', 'configuration-needed', 'blocked'].includes(entry.decision),
      `${entry.key} has an unknown hosted decision: ${entry.decision}`);
    assert.match(entry.reason.trim(), /.{40,}/, `${entry.key} records no exact reason for its decision`);
  }
});

test('Adzuna is configuration-needed with key-only credentials and no site/IP binding', () => {
  for (const key of ['adzuna-ch', 'adzuna-nl']) {
    const entry = hostedAssessmentFor(key);
    assert.ok(entry, `${key} has no hosted assessment`);
    assert.equal(entry.decision, 'configuration-needed');
    // Keys only. An IP, Referer, or registered-site requirement here would make hosted use
    // depend on network identity the host cannot promise, so this list is pinned exactly.
    assert.deepEqual([...entry.credentialNames].sort(), ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY']);
    assert.match(entry.siteOrIpRequirements, /no registered site/i);
    assert.match(entry.reason, /unavailable/i);
  }
});

test('Careerjet is blocked for hosted use with its site, Referer, and real-IP requirements stated', () => {
  for (const key of ['careerjet-ch', 'careerjet-nl']) {
    const entry = hostedAssessmentFor(key);
    assert.ok(entry, `${key} has no hosted assessment`);
    assert.equal(entry.decision, 'blocked');
    assert.deepEqual([...entry.credentialNames].sort(),
      ['CAREERJET_API_KEY', 'CAREERJET_REFERER', 'CAREERJET_USER_IP']);
    assert.match(entry.siteOrIpRequirements, /registered/i);
    assert.match(entry.siteOrIpRequirements, /Referer/i);
    assert.match(entry.siteOrIpRequirements, /real end-user IP/i);
    assert.match(entry.reason, /unset in every hosted environment/i);
  }
});

test('VPN-gated and permissionless page sources are blocked for hosted use', () => {
  for (const key of ['jobs.ch', 'jobup.ch', 'jobscout24.ch', 'undutchables.nl', 'iamexpat.nl']) {
    const entry = hostedAssessmentFor(key);
    assert.ok(entry, `${key} has no hosted assessment`);
    assert.equal(entry.decision, 'blocked', `${key} must not reach hosted production without an owner exception`);
  }
  assert.match(hostedAssessmentFor('jobs.ch')!.reason, /written.*permission/i);
  assert.match(hostedAssessmentFor('undutchables.nl')!.reason, /403/i);
  assert.match(hostedAssessmentFor('iamexpat.nl')!.reason, /no explicit permission/i);
});

test('Indeed stays a blocked local experiment: the local boundary is never generalized to hosted', () => {
  for (const key of ['indeed-ch', 'indeed-nl']) {
    const entry = hostedAssessmentFor(key);
    assert.ok(entry, `${key} has no hosted assessment`);
    assert.equal(entry.decision, 'blocked');
    assert.match(entry.reason, /loopback/i);
    assert.match(entry.reason, /source-specific.*decision/i);
    assert.match(entry.reason, /never be generalized/i);
  }
  // The code boundary behind that verdict, exercised with synthetic fixtures: hosted-shaped
  // access (non-loopback execution) is denied before any network access, and so are
  // non-administrator, unapproved, and disabled callers. Only the full local set is ready.
  const synthetic = { apiKey: 'a'.repeat(64), userAgent: 'Synthetic local test', appInfo: 'synthetic=fixture' };
  const local = { enabled: true, localExecution: true, administrator: true, appIdentityExperimentApproved: true };
  assert.equal(indeedReadiness(local, synthetic), 'ready');
  assert.equal(indeedReadiness({ ...local, localExecution: false }, synthetic), 'denied');
  assert.equal(indeedReadiness({ ...local, administrator: false }, synthetic), 'denied');
  assert.equal(indeedReadiness({ ...local, appIdentityExperimentApproved: false }, synthetic), 'denied');
  assert.equal(indeedReadiness({ ...local, enabled: false }, synthetic), 'disabled');
});

test('refusal handling cited by the assessment holds: refusals stop, budgets never masquerade as refusals', () => {
  // Keyed sources that answer 401/403/429/451 (or name the refusal) are left alone for the rest
  // of the run: no retry, no rotation, no fallback. A host that runs out of its own invocation
  // budget must never latch a working source as blocked.
  assert.equal(isAccessRefusal(new Error('Adzuna request failed (403).')), true);
  assert.equal(isAccessRefusal(new Error('Careerjet request failed (429: rate limited).')), true);
  assert.equal(isAccessRefusal(new Error('socket hang up')), false);
  assert.equal(isRuntimeBudgetExhausted(new Error('Too many subrequests.')), true);
  assert.equal(isAccessRefusal(new Error('Too many subrequests.')), false);
});

test('the assessment publishes variable names only, never secret values', () => {
  const serialized = JSON.stringify(HOSTED_SOURCE_ASSESSMENTS);
  for (const entry of HOSTED_SOURCE_ASSESSMENTS) {
    for (const name of entry.credentialNames) {
      assert.match(name, /^[A-Z][A-Z0-9_]+$/, `${name} is not a plain variable name`);
    }
  }
  // Tripwire against pasting a real key, token, or bearer value into the matrix. The synthetic
  // 64-hex fixture shape used across the Indeed suites stands in for key material here.
  assert.doesNotMatch(serialized, /[a-f0-9]{64}/i);
  assert.doesNotMatch(serialized, /sk-|Bearer |Basic [A-Za-z0-9+/=]{8,}/);
});
