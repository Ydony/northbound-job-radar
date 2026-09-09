import assert from 'node:assert/strict';
import test from 'node:test';
import { sourcePoliciesForRole } from '../lib/source-policies';

test('ordinary accounts are not told about administrator-only discovery sources', () => {
  const names = sourcePoliciesForRole(false).map((policy) => policy.name);
  for (const privateName of [
    'Adzuna (Switzerland and Netherlands)',
    'Careerjet (Switzerland and Netherlands)',
    'IamExpat',
  ]) assert.equal(names.includes(privateName), false, `${privateName} leaked to the public source page`);
  assert.equal(sourcePoliciesForRole(false).some((policy) => policy.group === 'Restricted sites'), false);
});

test('administrators retain the complete source-policy record', () => {
  const names = sourcePoliciesForRole(true).map((policy) => policy.name);
  for (const privateName of [
    'Adzuna (Switzerland and Netherlands)',
    'Careerjet (Switzerland and Netherlands)',
    'IamExpat',
    'jobs.ch',
  ]) assert.ok(names.includes(privateName), `${privateName} is missing from the administrator view`);
});
