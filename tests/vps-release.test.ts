import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// T03 (F1): pin the release gates so a later edit cannot silently re-arm an
// automatic production deploy, re-interpolate an input into shell, or record
// an unverified SHA. Mirrors scripts/verify-vps-release.mjs; the script checks
// the runbook-completeness gates too, pinned here as well.
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const releaseWorkflow: string = readFileSync(join(root, '.github', 'workflows', 'release-vps.yml'), 'utf8');
const cfWorkflow: string = readFileSync(join(root, '.github', 'workflows', 'deploy-prod.yml'), 'utf8');
const runbook: string = readFileSync(join(root, 'docs', 'VPS_RELEASE.md'), 'utf8');

function jobBlock(workflow: string, name: string): string {
  const lines: string[] = workflow.split('\n');
  const start: number = lines.findIndex((line: string) => new RegExp(`^ {2}${name}:\\s*$`).test(line));
  assert.notEqual(start, -1, `no job named ${name}`);
  let end: number = lines.findIndex((line: string, i: number) => i > start && /^ {2}\w+:\s*$/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('the VPS release is owner-triggered only', () => {
  assert.match(releaseWorkflow, /^ {2}workflow_dispatch:/m, 'no manual trigger');
  for (const trigger of ['push', 'pull_request', 'schedule']) {
    assert.doesNotMatch(releaseWorkflow, new RegExp(`^ {2}${trigger}:`, 'm'), `automatic ${trigger} trigger present`);
  }
});

test('the verified SHA is recorded explicitly, never interpolated, never the dispatch head', () => {
  const envHits: string[] = releaseWorkflow
    .split('\n')
    .filter((line: string) => /^ {4}environment: production-vps\s*$/.test(line));
  assert.equal(envHits.length, 1, 'more than one job writes the production-vps record');
  const record: string = jobBlock(releaseWorkflow, 'record');
  assert.match(record, /needs:.*verify/, 'record does not wait for verify');
  assert.match(record, /environment: production-vps/, 'record does not hold the environment');
  assert.match(jobBlock(releaseWorkflow, 'verify'), /needs:.*build/, 'verify does not wait for build');
  assert.ok(record.includes('deployments: write'), 'record cannot create the deployment');
  assert.ok(record.includes('repos/$REPO/deployments'), 'record does not create the deployment explicitly');
  assert.ok(record.includes('required_contexts'), 'deployment does not declare its (empty) required contexts');
  assert.ok(record.includes("state='success'"), 'deployment is not marked success');
  const inputUseLines: string[] = releaseWorkflow
    .split('\n')
    .filter((line: string) => line.includes('${{ inputs.'));
  assert.ok(inputUseLines.length > 0, 'no workflow input uses found');
  for (const line of inputUseLines) {
    assert.match(line, /^\s*(?:ref|name|SHA|PREVIOUS_SHA):/, `input reaches shell text: ${line.trim()}`);
  }
  assert.ok(!releaseWorkflow.includes("'${{ inputs."), 'input interpolated in shell single quotes');
  assert.ok(!releaseWorkflow.includes('"${{ inputs.'), 'input interpolated in shell double quotes');
  assert.ok(!releaseWorkflow.includes('`${{ inputs.'), 'input interpolated in shell backticks');
  assert.ok(releaseWorkflow.includes('previous_sha must be empty or'), 'previous_sha is not validated');
  const build: string = jobBlock(releaseWorkflow, 'build');
  assert.ok(build.includes('merge-base --is-ancestor'), 'no master-ancestry pre-flight');
  assert.ok(
    build.indexOf('merge-base --is-ancestor') < build.indexOf('npm ci'),
    'master-ancestry check does not run before the build',
  );
});

test('no automatic Cloudflare deploy is left to race the VPS release', () => {
  assert.doesNotMatch(cfWorkflow, /^ {2}push:/m, 'push trigger still present');
  assert.match(cfWorkflow, /^ {2}workflow_dispatch:/m, 'manual dispatch removed');
  assert.match(cfWorkflow, /environment: production/, 'approval gate removed');
});

test('the refresh job follows the release and migrations gate the revert', () => {
  assert.ok(runbook.includes('Both units run the same SHA'), 'refresh unit not tied to the release SHA');
  assert.ok(
    runbook.includes('systemctl restart ikbeneenappel-web.service ikbeneenappel-refresh.service'),
    'refresh unit missing from the restart steps',
  );
  assert.ok(
    runbook.includes('git diff --quiet <previous-sha> <sha> -- db/migrations.ts'),
    'no migration pre-flight before the instant revert',
  );
  assert.ok(
    runbook.includes('migrations changed: use the backup restore instead'),
    'no backup-restore fallback for migrated releases',
  );
});

test('the runbook states the SHA evidence honestly and the revert as unverified', () => {
  assert.match(runbook, /rollback/i, 'no rollback procedure');
  assert.ok(runbook.includes('production-vps'), 'no production-vps SHA evidence');
  assert.ok(runbook.includes('if and only if its artifact verified'), 'evidence claim missing');
  assert.ok(runbook.includes('the approval log'), 'dispatch-head caveat missing');
  assert.ok(
    runbook.includes('unverified until the owner runs it on a host'),
    'revert overstated: no plain unverified statement',
  );
});
