import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELETION_STEPS,
  deletionStatus,
  evaluateRetirementReadiness,
  type RetirementEvidence,
} from '../lib/retirement-readiness';

// T25 (F8): the retirement checklist gates, all on synthetic fixtures. The
// evaluator never touches production — it judges an assembled evidence
// object, so every case below builds one by hand.

function passingEvidence(): RetirementEvidence {
  return {
    observationDays: 14,
    stability: {
      searchFailures: { reviewedAt: '2026-10-01', vpsCausedUnfixed: 0 },
      restarts: { reviewedAt: '2026-10-01', unexplainedRestarts: 0 },
      backupAge: { reviewedAt: '2026-10-01', youngestBackupMinutesAgo: 4, maxAcceptedBackupMinutes: 60 },
      storageGrowth: { reviewedAt: '2026-10-01', headroomOk: true },
    },
    recovery: {
      restore: {
        ranAt: '2026-09-30',
        withinObservationPeriod: true,
        integrityOk: true,
        countsMatch: true,
        dashboardServedFromScratch: true,
      },
      vpsEvidence: {
        verifiedAt: '2026-09-30',
        versionMatchesDeploy: true,
        dashboardOk: true,
        headersOk: true,
      },
    },
    inventory: { recordedAt: '2026-09-30' },
    deletions: [],
  };
}

test('all-green synthetic evidence is ready for a decision, but deletes nothing', () => {
  const { readyForDecision, gates } = evaluateRetirementReadiness(passingEvidence());
  assert.equal(readyForDecision, true);
  assert.ok(gates.every((gate) => gate.pass), 'every gate passes');
  // Readiness authorizes deciding, never deleting: without instructions every
  // D-step stays blocked.
  assert.deepEqual(deletionStatus(passingEvidence()).map((s) => s.allowed), [false, false, false, false, false]);
});

test('unset observation period blocks everything else from mattering', () => {
  const evidence = { ...passingEvidence(), observationDays: null };
  const { readyForDecision, gates } = evaluateRetirementReadiness(evidence);
  assert.equal(readyForDecision, false);
  assert.equal(gates.find((gate) => gate.id === 'observation-period-set')?.pass, false);
});

test('each unreviewed stability metric fails its own gate, not the others', () => {
  for (const key of ['searchFailures', 'restarts', 'backupAge', 'storageGrowth'] as const) {
    const evidence = passingEvidence();
    (evidence.stability[key] as { reviewedAt: string | null }).reviewedAt = null;
    const { readyForDecision, gates } = evaluateRetirementReadiness(evidence);
    assert.equal(readyForDecision, false, key);
    const failed = gates.filter((gate) => !gate.pass).map((gate) => gate.id);
    assert.equal(failed.length, 1, `${key}: only its own gate fails, got ${failed.join(',')}`);
  }
});

test('unfixed VPS-caused failures, unexplained restarts, stale backups and no headroom each block', () => {
  const cases: { mutate: (e: RetirementEvidence) => void; gate: string }[] = [
    { mutate: (e) => { e.stability.searchFailures.vpsCausedUnfixed = 2; }, gate: 'stability-search-failures' },
    { mutate: (e) => { e.stability.restarts.unexplainedRestarts = 1; }, gate: 'stability-restarts' },
    { mutate: (e) => { e.stability.backupAge.youngestBackupMinutesAgo = 4000; }, gate: 'stability-backup-age' },
    { mutate: (e) => { e.stability.backupAge.youngestBackupMinutesAgo = null; }, gate: 'stability-backup-age' },
    { mutate: (e) => { e.stability.storageGrowth.headroomOk = false; }, gate: 'stability-storage-growth' },
  ];
  for (const { mutate, gate } of cases) {
    const evidence = passingEvidence();
    mutate(evidence);
    const result = evaluateRetirementReadiness(evidence);
    assert.equal(result.readyForDecision, false, gate);
    assert.equal(result.gates.find((g) => g.id === gate)?.pass, false, gate);
  }
});

test('a restore outside the observation period, or an incomplete one, blocks recovery', () => {
  const stale = passingEvidence();
  stale.recovery.restore.withinObservationPeriod = false;
  assert.equal(evaluateRetirementReadiness(stale).readyForDecision, false);

  const partial = passingEvidence();
  partial.recovery.restore.countsMatch = false;
  const result = evaluateRetirementReadiness(partial);
  assert.equal(result.readyForDecision, false);
  assert.match(
    result.gates.find((g) => g.id === 'recovery-restore')?.reasons.join(';') ?? '',
    /per-table counts/,
  );
});

test('wrong VPS evidence and a missing private inventory each block', () => {
  const wrongHost = passingEvidence();
  wrongHost.recovery.vpsEvidence.versionMatchesDeploy = false;
  assert.equal(evaluateRetirementReadiness(wrongHost).readyForDecision, false);

  const noInventory = passingEvidence();
  noInventory.inventory.recordedAt = null;
  const result = evaluateRetirementReadiness(noInventory);
  assert.equal(result.readyForDecision, false);
  assert.equal(result.gates.find((g) => g.id === 'inventory')?.pass, false);
});

test('deletion steps are individually gated on explicit owner instruction', () => {
  const evidence = passingEvidence();
  evidence.deletions = [
    { step: 'D2', ownerInstruction: '2026-10-02, tracker: "delete the Worker"' },
    { step: 'D9', ownerInstruction: '2026-10-02, tracker: "delete everything"' },
  ];
  const status = deletionStatus(evidence);
  assert.deepEqual(status.map((s) => s.step), [...DELETION_STEPS]);
  assert.equal(status.find((s) => s.step === 'D2')?.allowed, true);
  // D1, D3–D5 stay blocked, and the unknown D9 grants nothing.
  assert.deepEqual(
    status.filter((s) => s.step !== 'D2').map((s) => s.allowed),
    [false, false, false, false],
  );
  // An empty instruction is not an instruction.
  const empty = passingEvidence();
  empty.deletions = [{ step: 'D1', ownerInstruction: '' }];
  assert.equal(deletionStatus(empty).find((s) => s.step === 'D1')?.allowed, false);
});
