#!/usr/bin/env node
/**
 * T03 (F1): synthetic rehearsal for the VPS release/rollback procedure.
 *
 * The real release is owner-run — dispatch `release-vps.yml`, approve the
 * `production-vps` environment, deploy the recorded SHA on the host — and no
 * host exists here, so this script rehearses the SHAPE of that procedure:
 *
 * 1. Static gates on the workflow files: the VPS release is
 *    owner-triggered only, the `production-vps` SHA record is written only
 *    by a job that runs after verification, and the Cloudflare deploy no
 *    longer fires automatically on push (it would race the VPS release for
 *    one production).
 * 2. Instant-revert drill on throwaway directories: stage two synthetic
 *    releases, swing a `current` pointer to the new one, fail its check,
 *    swing back — and confirm the previous release content is what serves.
 *    A plain pointer file stands in for the host's release symlink; the
 *    logic proved (a failed release never strands the pointer on itself)
 *    is the same.
 *
 * Run with: `npm run verify:vps-release` (plain node, no dependencies).
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release-vps.yml'), 'utf8');
const cfWorkflow = readFileSync(join(root, '.github', 'workflows', 'deploy-prod.yml'), 'utf8');
const runbook = readFileSync(join(root, 'docs', 'VPS_RELEASE.md'), 'utf8');

let failures = 0;
function check(condition, label, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` - ${detail}`}`);
  return false;
}

/** Job headers are exactly two-space indented (`  name:`); trigger keys too. */
function jobBlock(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^  ${name}:\\s*$`).test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^  \w+:\s*$/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

console.log('1/4 The VPS release is owner-triggered only');
check(/^  workflow_dispatch:/m.test(releaseWorkflow), 'release-vps.yml has a workflow_dispatch trigger');
for (const trigger of ['push', 'pull_request', 'schedule']) {
  check(!new RegExp(`^  ${trigger}:`, 'm').test(releaseWorkflow), `release-vps.yml has no ${trigger} trigger`);
}

console.log('2/4 The production-vps SHA is recorded only after verification');
const envHits = releaseWorkflow.split('\n').filter((line) => /^    environment: production-vps\s*$/.test(line));
check(envHits.length === 1, 'exactly one job carries environment: production-vps', `${envHits.length} found`);
const record = jobBlock(releaseWorkflow, 'record');
check(record !== null, 'that job is named record');
check(record !== null && /needs:.*verify/.test(record), 'the record job needs the verify job');
check(record !== null && /environment: production-vps/.test(record), 'the record job holds the environment');
const verifyJob = jobBlock(releaseWorkflow, 'verify');
check(verifyJob !== null && /needs:.*build/.test(verifyJob), 'the verify job needs the build job');

console.log('3/4 No automatic Cloudflare deploy is left to race it');
check(!/^  push:/m.test(cfWorkflow), 'deploy-prod.yml has no push trigger');
check(/^  workflow_dispatch:/m.test(cfWorkflow), 'deploy-prod.yml stays manually dispatchable');
check(/environment: production/.test(cfWorkflow), 'deploy-prod.yml keeps the production approval gate');
check(/rollback/i.test(runbook), 'the runbook documents rollback');
check(runbook.includes('production-vps'), 'the runbook names production-vps as the SHA evidence');

console.log('4/4 A failed release falls back to the previous one');
const work = mkdtempSync(join(tmpdir(), 'vps-release-'));
const evidence = { previous: 'sha-previous-good', failed: 'sha-new-broken', served: null };
try {
  const previous = join(work, 'releases', evidence.previous);
  const next = join(work, 'releases', evidence.failed);
  mkdirSync(previous, { recursive: true });
  mkdirSync(next, { recursive: true });
  writeFileSync(join(previous, 'server.js'), '// previous good bundle\n');
  writeFileSync(join(next, 'server.js'), '// new broken bundle\n');
  const pointer = join(work, 'current');
  writeFileSync(pointer, evidence.previous);
  // Deploy: swing the pointer only after staging completes.
  writeFileSync(pointer, evidence.failed);
  // Verify the new release; it fails, so swing back — never strand the
  // pointer on a release that did not verify.
  const newBundle = readFileSync(join(work, 'releases', readFileSync(pointer, 'utf8'), 'server.js'), 'utf8');
  if (!newBundle.includes('previous good bundle')) {
    writeFileSync(pointer, evidence.previous);
  }
  evidence.served = readFileSync(join(work, 'releases', readFileSync(pointer, 'utf8'), 'server.js'), 'utf8');
  check(evidence.served.includes('previous good bundle'), 'the pointer serves the previous release after a failed verify');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(JSON.stringify({ verifier: 'verify:vps-release', failures, evidence }, null, 2));
if (failures > 0) {
  console.error(`\n${failures} check(s) failed. The VPS release procedure is not ready.`);
  process.exit(1);
}
console.log('\nPASS the VPS release/rollback gates hold on synthetic fixtures.');
