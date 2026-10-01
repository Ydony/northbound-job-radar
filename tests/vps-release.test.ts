import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// T03 (F1): pin the release gates so a later edit cannot silently re-arm an
// automatic production deploy or record an unverified SHA. Mirrors
// scripts/verify-vps-release.mjs; the script rehearses the revert drill too,
// this test pins the file gates inside `npm test`.
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release-vps.yml'), 'utf8');
const cfWorkflow = readFileSync(join(root, '.github', 'workflows', 'deploy-prod.yml'), 'utf8');
const runbook = readFileSync(join(root, 'docs', 'VPS_RELEASE.md'), 'utf8');

function jobBlock(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^  ${name}:\\s*$`).test(line));
  assert.notEqual(start, -1, `no job named ${name}`);
  let end = lines.findIndex((line, i) => i > start && /^  \w+:\s*$/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('the VPS release is owner-triggered only', () => {
  assert.match(releaseWorkflow, /^  workflow_dispatch:/m, 'no manual trigger');
  for (const trigger of ['push', 'pull_request', 'schedule']) {
    assert.doesNotMatch(releaseWorkflow, new RegExp(`^  ${trigger}:`, 'm'), `automatic ${trigger} trigger present`);
  }
});

test('the production-vps SHA is recorded only after verification', () => {
  const envHits = releaseWorkflow.split('\n').filter((line) => /^    environment: production-vps\s*$/.test(line));
  assert.equal(envHits.length, 1, 'more than one job writes the production-vps record');
  const record = jobBlock(releaseWorkflow, 'record');
  assert.match(record, /needs:.*verify/, 'record does not wait for verify');
  assert.match(record, /environment: production-vps/, 'record does not hold the environment');
  assert.match(jobBlock(releaseWorkflow, 'verify'), /needs:.*build/, 'verify does not wait for build');
});

test('no automatic Cloudflare deploy is left to race the VPS release', () => {
  assert.doesNotMatch(cfWorkflow, /^  push:/m, 'push trigger still present');
  assert.match(cfWorkflow, /^  workflow_dispatch:/m, 'manual dispatch removed');
  assert.match(cfWorkflow, /environment: production/, 'approval gate removed');
});

test('the runbook documents rollback and the SHA evidence', () => {
  assert.match(runbook, /rollback/i, 'no rollback procedure');
  assert.ok(runbook.includes('production-vps'), 'no production-vps SHA evidence');
});
