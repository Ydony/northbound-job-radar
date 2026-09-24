import assert from 'node:assert/strict';
import test from 'node:test';
import { adminOnlySourceKeys, jobSourceAdapters } from '../lib/job-adapters';
import {
  SOURCE_POLICY_REGISTRY,
  SOURCE_POLICY_STATUSES,
  adminOnlySourcePolicyKeys,
  publicSourceKeys,
  sourcePolicyFor,
} from '../lib/source-policy';

test('every registered adapter has exactly one source-policy entry', () => {
  assert.ok(jobSourceAdapters.length > 0, 'expected at least one adapter');
  const keys = SOURCE_POLICY_REGISTRY.map((entry) => entry.key);
  for (const adapter of jobSourceAdapters) {
    const matches = keys.filter((key) => key === adapter.key);
    assert.equal(
      matches.length,
      1,
      `${adapter.key} has ${matches.length} registry entries: add exactly one to SOURCE_POLICY_REGISTRY so it cannot silently default`,
    );
  }
});

test('no registry entry points at a removed adapter and no key repeats', () => {
  const adapterKeys = new Set(jobSourceAdapters.map((adapter) => adapter.key));
  const seen = new Set<string>();
  for (const entry of SOURCE_POLICY_REGISTRY) {
    assert.ok(adapterKeys.has(entry.key), `${entry.key} has a registry entry but no adapter: remove the stale row`);
    assert.ok(!seen.has(entry.key), `${entry.key} has more than one registry entry`);
    seen.add(entry.key);
  }
});

test('registry audience agrees with the enforced server-side gate', () => {
  // The gate is what actually hides sources from ordinary accounts; the registry must say
  // the same thing, or a consumer reading the registry would promise a split the code
  // does not enforce.
  const hidden = adminOnlySourceKeys();
  for (const entry of SOURCE_POLICY_REGISTRY) {
    if (entry.audience === 'public') {
      assert.equal(hidden.has(entry.key), false, `${entry.key} is registered public but hidden by the gate`);
    } else {
      assert.ok(hidden.has(entry.key), `${entry.key} is registered admin-only but reachable by ordinary accounts`);
    }
  }
});

test('registry enabled state agrees with adapter availability', () => {
  for (const adapter of jobSourceAdapters) {
    const entry = sourcePolicyFor(adapter.key);
    assert.ok(entry, `${adapter.key} has no registry entry`);
    assert.equal(
      entry.enabled,
      adapter.availability === 'enabled',
      `${adapter.key} availability is ${adapter.availability} but the registry says enabled=${entry.enabled}`,
    );
  }
});

test('every entry carries a valid policy status and its evidence', () => {
  for (const entry of SOURCE_POLICY_REGISTRY) {
    assert.ok(
      (SOURCE_POLICY_STATUSES as readonly string[]).includes(entry.policyStatus),
      `${entry.key} has an unknown policy status: ${entry.policyStatus}`,
    );
    assert.match(entry.basis.trim(), /.{20,}/, `${entry.key} records no evidence basis for its status`);
  }
});

test('registry helpers agree with the registry rows', () => {
  assert.deepEqual(
    publicSourceKeys().sort(),
    SOURCE_POLICY_REGISTRY.filter((entry) => entry.audience === 'public').map((entry) => entry.key).sort(),
  );
  assert.deepEqual(
    adminOnlySourcePolicyKeys().sort(),
    SOURCE_POLICY_REGISTRY.filter((entry) => entry.audience === 'admin-only').map((entry) => entry.key).sort(),
  );
  assert.equal(sourcePolicyFor('eures-ch')?.audience, 'public');
  assert.equal(sourcePolicyFor('jobs.ch')?.policyStatus, 'against-terms');
  assert.equal(sourcePolicyFor('no-such-source'), undefined);
});
