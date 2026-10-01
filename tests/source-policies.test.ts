import assert from 'node:assert/strict';
import test from 'node:test';
import { atsCompanies } from '../lib/ats-feeds';
import { sourcePolicies, sourcePoliciesForRole } from '../lib/source-policies';

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

test('T08: the public boards entry names the configured platforms and states Teamtailor/Workable support honestly', () => {
  const boards = sourcePolicies.find((policy) => policy.name.startsWith('Company career boards'));
  assert.ok(boards, 'boards policy entry is missing');
  for (const platform of ['Greenhouse', 'Lever', 'Ashby', 'Recruitee', 'Personio']) {
    assert.match(boards!.name, new RegExp(platform), `boards entry no longer names configured platform ${platform}`);
  }
  const body = `${boards!.collected} ${boards!.theirRules} ${boards!.ourPosition}`;
  assert.match(body, /282 verified/);
  assert.match(boards!.ourPosition, /never republished/);
  assert.match(boards!.ourPosition, /Workday is excluded/);
  // The adapter supports Teamtailor and Workable, but no verified board currently uses them:
  // the entry must say so plainly instead of implying coverage.
  assert.match(body, /Teamtailor/);
  assert.match(body, /Workable/);
  assert.match(body, /no verified board currently uses them|zero of the 282 verified boards uses them/i);
  // Reality check against the configured list: all 282 boards sit on the five named platforms.
  assert.equal(atsCompanies.length, 282);
  assert.deepEqual(
    [...new Set(atsCompanies.map((company) => company.platform))].sort(),
    ['ashby', 'greenhouse', 'lever', 'personio', 'recruitee'],
  );
  assert.equal(
    atsCompanies.filter((company) => company.platform === 'teamtailor' || company.platform === 'workable').length,
    0,
    'a Teamtailor or Workable board was configured without updating the transparency entry',
  );
});

test('T08: FreeHire names its unresolved redistribution question and its launch gate', () => {
  const freehire = sourcePolicies.find((policy) => policy.name.startsWith('FreeHire'));
  assert.ok(freehire, 'FreeHire policy entry is missing');
  assert.match(freehire!.theirRules, /nothing about redistributing results/);
  assert.match(freehire!.theirRules, /unresolved \(#166\)/);
  assert.match(freehire!.ourPosition, /still outstanding/);
  assert.match(freehire!.ourPosition, /before launch/);
  assert.match(freehire!.ourPosition, /not counted as launched public coverage/);
});

test('T08: Job-Room states the owner assumption instead of implying a grant', () => {
  const jobRoom = sourcePolicies.find((policy) => policy.name.startsWith('Job-Room'));
  assert.ok(jobRoom, 'Job-Room policy entry is missing');
  assert.match(jobRoom!.ourPosition, /explicit owner assumption/);
  assert.match(jobRoom!.ourPosition, /an assumption is not a permission/);
});

test('T08: unresolved candidates are present, ungated nowhere, and enabled nowhere', () => {
  for (const name of ['Jooble', 'UWV / werk.nl', 'OpenPostings', 'eurojobs.com']) {
    const entry = sourcePolicies.find((policy) => policy.name.startsWith(name));
    assert.ok(entry, `${name} has no transparency entry: an unresolved source must be gated in words, not absent`);
    assert.match(
      `${entry!.theirRules} ${entry!.ourPosition}`,
      /Gated|Not used|not to be revisited/i,
      `${name} states no gate`,
    );
    assert.equal(entry!.adminOnly ?? false, false, `${name} is a not-used explanation and stays visible to all`);
  }
  const ordinary = sourcePoliciesForRole(false).map((policy) => policy.name);
  assert.ok(ordinary.some((name) => name.startsWith('Jooble')), 'ordinary accounts lose the Jooble explanation');
});
