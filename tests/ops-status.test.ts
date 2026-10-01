import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertSanitized,
  checkBackup,
  checkDeployArtifacts,
  checkRefresh,
  checkServices,
  checkStorage,
  DEFAULT_OPS_THRESHOLDS,
  evaluateOpsEvidence,
  overallVerdict,
  type OpsEvidence,
} from '../lib/ops-status';

/**
 * F8/T24: sanitized operational checks. Every value below is synthetic —
 * no host, no credential, no production data. Thresholds are pinned here
 * so a quiet constant change cannot silently move the F8 retirement gate.
 */

const PERIOD_START = '2026-10-01T00:00:00.000Z';
const COLLECTED_AT = '2026-10-08T00:00:00.000Z';
const HOUR = 3_600_000;

function healthy(): OpsEvidence {
  return {
    periodStart: PERIOD_START,
    collectedAt: COLLECTED_AT,
    services: [
      { name: 'ikbeneenappel-web.service', active: true, restarts: 0 },
      { name: 'ikbeneenappel-refresh.service', active: true, restarts: 0 },
      { name: 'ikbeneenappel-litestream.service', active: true, restarts: 0 },
    ],
    refreshRuns: [
      { at: '2026-10-07T18:00:00.000Z', ok: true, failedSources: [] },
      { at: '2026-10-08T00:00:00.000Z', ok: true, failedSources: [] },
    ],
    backup: { lastReplicaAt: '2026-10-07T23:55:00.000Z' },
    storage: { dbBytes: 100 * 1_048_576, freeBytes: 60 * 1_073_741_824 },
  };
}

test('healthy synthetic evidence passes every area', () => {
  const { checks, verdict } = evaluateOpsEvidence(healthy());
  assert.equal(verdict, 'pass');
  assert.deepEqual(checks.map((check) => check.area), ['services', 'refresh', 'backup', 'storage']);
  for (const check of checks) assert.equal(check.verdict, 'pass');
});

test('services: missing, inactive and restarted units', () => {
  const missing = checkServices(healthy().services.slice(0, 2), PERIOD_START);
  assert.equal(missing.verdict, 'fail');
  assert.match(missing.summary, /litestream/);

  const inactive = checkServices(
    healthy().services.map((service) => service.name === 'ikbeneenappel-web.service'
      ? { ...service, active: false }
      : service),
    PERIOD_START,
  );
  assert.equal(inactive.verdict, 'fail');
  assert.match(inactive.summary, /not active/);

  const restarted = checkServices(
    healthy().services.map((service) => service.name === 'ikbeneenappel-litestream.service'
      ? { ...service, restarts: 3 }
      : service),
    PERIOD_START,
  );
  assert.equal(restarted.verdict, 'warn');
  assert.match(restarted.summary, /restarts in period/);
});

test('refresh: empty period, total failure and stale success all fail', () => {
  assert.equal(checkRefresh([], PERIOD_START, COLLECTED_AT).verdict, 'fail');

  const allFailed = checkRefresh(
    [{ at: '2026-10-07T18:00:00.000Z', ok: false, failedSources: ['ats-ch'] }],
    PERIOD_START,
    COLLECTED_AT,
  );
  assert.equal(allFailed.verdict, 'fail');
  assert.match(allFailed.summary, /none successful/);

  const stale = checkRefresh(
    [{ at: '2026-10-07T06:00:00.000Z', ok: true, failedSources: [] }],
    PERIOD_START,
    COLLECTED_AT,
  );
  assert.equal(stale.verdict, 'fail');
  assert.match(stale.summary, /two cadences/);
});

test('refresh: recent success after a failure warns and names the source', () => {
  const recovering = checkRefresh(
    [
      { at: '2026-10-07T18:00:00.000Z', ok: false, failedSources: ['ats-ch'] },
      { at: '2026-10-08T00:00:00.000Z', ok: true, failedSources: [] },
    ],
    PERIOD_START,
    COLLECTED_AT,
  );
  assert.equal(recovering.verdict, 'warn');
  assert.match(recovering.summary, /ats-ch/);
});

test('refresh: runs before the owner-selected period start are ignored', () => {
  const old = checkRefresh(
    [
      { at: '2026-09-20T00:00:00.000Z', ok: false, failedSources: ['ats-ch'] },
      { at: '2026-10-08T00:00:00.000Z', ok: true, failedSources: [] },
    ],
    PERIOD_START,
    COLLECTED_AT,
  );
  assert.equal(old.verdict, 'pass');
});

test('backup: age thresholds follow the Litestream sync interval', () => {
  const collected = Date.parse(COLLECTED_AT);
  const at = (ageMs: number) => new Date(collected - ageMs).toISOString();
  assert.equal(checkBackup({ lastReplicaAt: at(5 * 60_000) }, COLLECTED_AT).verdict, 'pass');
  assert.equal(checkBackup({ lastReplicaAt: at(2 * HOUR) }, COLLECTED_AT).verdict, 'warn');
  const failed = checkBackup({ lastReplicaAt: at(25 * HOUR) }, COLLECTED_AT);
  assert.equal(failed.verdict, 'fail');
  assert.match(failed.summary, /Do not cut over or retire/);
  assert.equal(
    checkBackup({ lastReplicaAt: at(-HOUR) }, COLLECTED_AT).verdict,
    'fail',
  );
});

test('storage: database growth and free-disk floors alert separately', () => {
  const base = healthy().storage;
  assert.equal(checkStorage(base).verdict, 'pass');

  assert.equal(
    checkStorage({ ...base, dbBytes: 600 * 1_048_576 }).verdict,
    'warn',
  );
  assert.equal(
    checkStorage({ ...base, dbBytes: 3 * 1_073_741_824 }).verdict,
    'fail',
  );
  const lowDisk = checkStorage({ ...base, freeBytes: 500 * 1_048_576 });
  assert.equal(lowDisk.verdict, 'fail');
  assert.match(lowDisk.summary, /free on the database volume/);
  assert.equal(
    checkStorage({ ...base, freeBytes: 3 * 1_073_741_824 }).verdict,
    'warn',
  );
  assert.throws(() => checkStorage({ ...base, dbBytes: -1 }), /dbBytes/);
});

test('sanitization: secret-like keys reject the whole evidence file', () => {
  assert.throws(
    () => assertSanitized({ backup: { lastReplicaAt: COLLECTED_AT }, SESSION_SECRET: 'x' }),
    /secret-like key/,
  );
  assert.throws(
    () => evaluateOpsEvidence({ ...healthy(), storage: { dbBytes: 1, freeBytes: 1, apiKey: 'x' } } as unknown as OpsEvidence),
    /secret-like key/,
  );
  // Honest values pass through untouched.
  assert.doesNotThrow(() => evaluateOpsEvidence(healthy()));
});

test('timestamps that are not ISO are rejected, not silently compared', () => {
  assert.throws(() => checkBackup({ lastReplicaAt: 'soon' }, COLLECTED_AT), /Invalid backup/);
  assert.throws(() => checkServices(healthy().services, 'yesterday'), /Invalid periodStart/);
});

test('deploy artifacts: the committed units match what the evaluator assumes', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const names = [
    'deploy/ikbeneenappel-refresh.timer',
    'deploy/litestream.yml',
    'deploy/ikbeneenappel-refresh.service',
    'deploy/ikbeneenappel-web.service',
    'deploy/nginx-ikbeneenappel.conf',
  ];
  const files: Record<string, string> = {};
  for (const name of names) files[name] = await readFile(join(root, name), 'utf8');
  const check = checkDeployArtifacts(files);
  assert.equal(check.verdict, 'pass');

  const shortened = {
    ...files,
    'deploy/litestream.yml': files['deploy/litestream.yml'].replace('720h', '24h'),
  };
  const drifted = checkDeployArtifacts(shortened);
  assert.equal(drifted.verdict, 'fail');
  assert.match(drifted.summary, /720h/);

  assert.equal(checkDeployArtifacts({}).verdict, 'fail');
});

test('overall verdict is the worst of its checks', () => {
  assert.equal(overallVerdict([]), 'pass');
  assert.equal(
    overallVerdict([
      { area: 'backup', verdict: 'pass', summary: '' },
      { area: 'storage', verdict: 'warn', summary: '' },
    ]),
    'warn',
  );
  assert.equal(
    overallVerdict([
      { area: 'backup', verdict: 'warn', summary: '' },
      { area: 'storage', verdict: 'fail', summary: '' },
    ]),
    'fail',
  );
});

test('default thresholds are pinned to their documented rationale', () => {
  assert.equal(DEFAULT_OPS_THRESHOLDS.refreshCadenceMs, 6 * 3_600_000);
  assert.equal(DEFAULT_OPS_THRESHOLDS.backupWarnAgeMs, 3_600_000);
  assert.equal(DEFAULT_OPS_THRESHOLDS.backupFailAgeMs, 24 * 3_600_000);
  assert.equal(DEFAULT_OPS_THRESHOLDS.dbWarnBytes, 500 * 1_048_576);
  assert.equal(DEFAULT_OPS_THRESHOLDS.dbFailBytes, 2 * 1_073_741_824);
});
