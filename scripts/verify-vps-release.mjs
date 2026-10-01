#!/usr/bin/env node
/**
 * T03 (F1): synthetic rehearsal for the VPS release/rollback procedure.
 *
 * The real release is owner-run — dispatch `release-vps.yml`, approve the
 * `production-vps` environment, deploy the recorded SHA on the host — and no
 * host exists here, so this script checks the SHAPE of that procedure with
 * static gates that can each fail:
 *
 * 1. The VPS release is owner-triggered only.
 * 2. The verified SHA is recorded explicitly (a `production-vps` deployment
 *    whose ref is the input SHA, created after verification), workflow inputs
 *    reach shell only through `env:` quoted, and the cheap master-ancestry
 *    gate runs before anything is built.
 * 3. No automatic Cloudflare deploy is left to race it.
 * 4. The runbook moves the refresh unit with the web unit on the same SHA,
 *    and refuses the instant revert when a migration shipped between the SHAs.
 * 5. The runbook states plainly that the host-side revert is unverified until
 *    the owner runs it on a host, and that the run's automatic environment
 *    entry (the dispatch head) is the approval log, not the SHA evidence.
 *
 * What this script does NOT do: earlier it staged two synthetic bundles and
 * "reverted" between files it had written itself, which passed by
 * construction and could never catch a mistake in the real revert commands.
 * That drill is gone. The instant revert below is checked for presence and
 * completeness only; running it is an owner checkpoint on a host.
 *
 * Run with: `npm run verify:vps-release` (plain node, no dependencies).
 * Prints JSON evidence on stdout; exits non-zero on any mismatch.
 */
import { readFileSync } from 'node:fs';
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
  const start = lines.findIndex((line) => new RegExp(`^ {2}${name}:\\s*$`).test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^ {2}\w+:\s*$/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

const evidence = {};

console.log('1/5 The VPS release is owner-triggered only');
check(/^ {2}workflow_dispatch:/m.test(releaseWorkflow), 'release-vps.yml has a workflow_dispatch trigger');
for (const trigger of ['push', 'pull_request', 'schedule']) {
  check(!new RegExp(`^ {2}${trigger}:`, 'm').test(releaseWorkflow), `release-vps.yml has no ${trigger} trigger`);
}

console.log('2/5 The verified SHA is recorded explicitly, never interpolated, never the dispatch head');
const envHits = releaseWorkflow.split('\n').filter((line) => /^ {4}environment: production-vps\s*$/.test(line));
check(envHits.length === 1, 'exactly one job carries environment: production-vps', `${envHits.length} found`);
const record = jobBlock(releaseWorkflow, 'record');
const build = jobBlock(releaseWorkflow, 'build');
check(record !== null, 'that job is named record');
check(record !== null && /needs:.*verify/.test(record), 'the record job needs the verify job');
check(record !== null && /environment: production-vps/.test(record), 'the record job holds the environment');
const verifyJob = jobBlock(releaseWorkflow, 'verify');
check(verifyJob !== null && /needs:.*build/.test(verifyJob), 'the verify job needs the build job');
// The deployment history is only true SHA evidence when the deployment points
// at the released SHA itself, not at the dispatch head.
evidence.explicitDeployment = check(
  record !== null
    && record.includes('deployments: write')
    && record.includes('repos/$REPO/deployments')
    && record.includes('required_contexts')
    && record.includes("state='success'"),
  'the record job creates the production-vps deployment for the input SHA and marks it success',
);
// Inputs reach shell only through env:, quoted — a hostile value can neither
// execute before validation nor ride along unvalidated.
const inputUseLines = releaseWorkflow.split('\n').filter((line) => line.includes('${{ inputs.'));
evidence.inputsViaEnvOnly = check(
  inputUseLines.length > 0
    && inputUseLines.every((line) => /^\s*(?:ref|name|SHA|PREVIOUS_SHA):/.test(line)),
  'every workflow input use is an action input or env assignment, never shell text',
  inputUseLines.filter((line) => !/^\s*(?:ref|name|SHA|PREVIOUS_SHA):/.test(line)).join('; '),
);
check(releaseWorkflow.includes('SHA: ${{ inputs.sha }}'), 'the SHA travels through env:');
check(releaseWorkflow.includes('PREVIOUS_SHA: ${{ inputs.previous_sha }}'), 'previous_sha travels through env:');
check(releaseWorkflow.includes('"$SHA"'), 'shell reads the SHA quoted from the environment');
check(!releaseWorkflow.includes("'${{ inputs."), 'no input is interpolated inside shell single quotes');
check(!releaseWorkflow.includes('"${{ inputs.'), 'no input is interpolated inside shell double quotes');
check(!releaseWorkflow.includes('`${{ inputs.'), 'no input is interpolated inside shell backticks');
check(releaseWorkflow.includes('previous_sha must be empty or'), 'previous_sha is validated as empty or 40-hex');
// The cheap master-ancestry gate runs before the expensive build, not after it.
evidence.masterPreflightFirst = check(
  build !== null
    && build.includes('merge-base --is-ancestor')
    && build.indexOf('merge-base --is-ancestor') < build.indexOf('npm ci'),
  'the build proves the SHA is on master before installing or building anything',
);

console.log('3/5 No automatic Cloudflare deploy is left to race it');
check(!/^ {2}push:/m.test(cfWorkflow), 'deploy-prod.yml has no push trigger');
check(/^ {2}workflow_dispatch:/m.test(cfWorkflow), 'deploy-prod.yml stays manually dispatchable');
check(/environment: production/.test(cfWorkflow), 'deploy-prod.yml keeps the production approval gate');
check(/rollback/i.test(runbook), 'the runbook documents rollback');
check(runbook.includes('production-vps'), 'the runbook names production-vps as the SHA evidence');

console.log('4/5 The refresh job follows the release and migrations gate the revert');
evidence.refreshFollowsRelease = check(
  runbook.includes('Both units run the same SHA')
    && runbook.includes('systemctl restart ikbeneenappel-web.service ikbeneenappel-refresh.service'),
  'the runbook releases and reverts the refresh unit on the same SHA as the web unit',
);
evidence.migrationPreflight = check(
  runbook.includes('git diff --quiet <previous-sha> <sha> -- db/migrations.ts')
    && runbook.includes('migrations changed: use the backup restore instead'),
  'the runbook refuses the instant revert when a migration shipped between the SHAs',
);

console.log('5/5 The host-side revert is documented without overstating what was proved');
evidence.revertHonestlyUnverified = check(
  runbook.includes('unverified until the owner runs it on a host')
    && runbook.includes('if and only if its artifact verified')
    && runbook.includes('the approval log'),
  'the runbook states the revert is unverified and the dispatch head is not the evidence',
);

console.log(JSON.stringify({ verifier: 'verify:vps-release', failures, evidence }, null, 2));
if (failures > 0) {
  console.error(`\n${failures} check(s) failed. The VPS release procedure is not ready.`);
  process.exit(1);
}
console.log('\nPASS the VPS release/rollback gates hold on synthetic fixtures.');
