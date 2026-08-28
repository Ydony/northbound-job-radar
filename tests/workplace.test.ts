import assert from 'node:assert/strict';
import test from 'node:test';
import { detectWorkplaceType, workplaceLabel } from '../lib/workplace';

test('detects fully remote roles', () => {
  assert.equal(detectWorkplaceType('This is a fully remote position.'), 'remote');
  assert.equal(detectWorkplaceType('You may work from home permanently.'), 'remote');
  assert.equal(detectWorkplaceType('100% remote within Europe.'), 'remote');
});

test('prefers hybrid when an ad mentions both office and remote work', () => {
  assert.equal(detectWorkplaceType('Hybrid role: 2 days in the office, rest remote.'), 'hybrid');
  assert.equal(detectWorkplaceType('We offer a mix of home and office working.'), 'hybrid');
  assert.equal(detectWorkplaceType('3 days per week in the office.'), 'hybrid');
});

test('detects on-site roles', () => {
  assert.equal(detectWorkplaceType('This role is office-based in Zurich.'), 'onsite');
  assert.equal(detectWorkplaceType('Work on-site with our team.'), 'onsite');
});

test('stays unknown rather than guessing when no signal exists', () => {
  assert.equal(detectWorkplaceType('We are looking for a data analyst to join our team.'), 'unknown');
  assert.equal(detectWorkplaceType(''), 'unknown');
});

test('labels every type for display', () => {
  assert.equal(workplaceLabel('remote'), 'Remote');
  assert.equal(workplaceLabel('hybrid'), 'Hybrid');
  assert.equal(workplaceLabel('onsite'), 'On-site');
  assert.equal(workplaceLabel('unknown'), 'Work type unknown');
});
