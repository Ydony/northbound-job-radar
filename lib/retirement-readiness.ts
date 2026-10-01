/**
 * F8 / T25: post-stability retirement gate evaluator.
 *
 * Pure logic over an assembled evidence object — it never touches production,
 * a database, or the network. The checklist itself is
 * `docs/CLOUDFLARE_RETIREMENT_CHECKLIST.md`; this module is the machine
 * half of gate 0 ("the script checks the shape of the evidence").
 *
 * Vocabulary, kept deliberate:
 * - `readyForDecision` means the owner may *decide* on retirement. It never
 *   authorizes a deletion.
 * - Each deletion step (D1–D5) is allowed only with its own explicit owner
 *   instruction, quoted as `{date, channel}`. `deletionStatus()` reports
 *   every step as `allowed` or `blocked`; a step without an instruction is
 *   `blocked`, which is the safe state, not an error.
 */

export interface StabilityItem {
  /** ISO date the owner (or reviewer) reviewed this metric; null = never. */
  reviewedAt: string | null;
}

export interface RetirementEvidence {
  /** Owner-selected observation period in days; null = the owner never set one. */
  observationDays: number | null;
  stability: {
    searchFailures: StabilityItem & { vpsCausedUnfixed: number };
    restarts: StabilityItem & { unexplainedRestarts: number };
    backupAge: StabilityItem & {
      youngestBackupMinutesAgo: number | null;
      maxAcceptedBackupMinutes: number;
    };
    storageGrowth: StabilityItem & { headroomOk: boolean };
  };
  recovery: {
    restore: {
      /** ISO date the real off-box drill ran; null = never. */
      ranAt: string | null;
      /** The drill ran inside the observation window (checked by the reviewer). */
      withinObservationPeriod: boolean;
      integrityOk: boolean;
      countsMatch: boolean;
      dashboardServedFromScratch: boolean;
    };
    vpsEvidence: {
      verifiedAt: string | null;
      versionMatchesDeploy: boolean;
      dashboardOk: boolean;
      headersOk: boolean;
    };
  };
  /** The private Cloudflare-side inventory exists; only its date is recorded. */
  inventory: { recordedAt: string | null };
  deletions: { step: string; ownerInstruction: string | null }[];
}

export interface GateResult {
  id: string;
  pass: boolean;
  reasons: string[];
}

function fail(id: string, reason: string): GateResult {
  return { id, pass: false, reasons: [reason] };
}

function reviewed(item: StabilityItem): boolean {
  return typeof item.reviewedAt === 'string' && item.reviewedAt.length > 0;
}

export const DELETION_STEPS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const;

export function evaluateRetirementReadiness(evidence: RetirementEvidence): {
  readyForDecision: boolean;
  gates: GateResult[];
} {
  const gates: GateResult[] = [];

  if (
    typeof evidence.observationDays !== 'number' ||
    !Number.isFinite(evidence.observationDays) ||
    evidence.observationDays <= 0
  ) {
    gates.push(fail('observation-period-set', 'no owner-selected observation period recorded'));
  } else {
    gates.push({ id: 'observation-period-set', pass: true, reasons: [] });
  }

  const s = evidence.stability;
  if (!reviewed(s.searchFailures)) {
    gates.push(fail('stability-search-failures', 'search failures were not reviewed for the period'));
  } else if (s.searchFailures.vpsCausedUnfixed > 0) {
    gates.push(fail('stability-search-failures', `${s.searchFailures.vpsCausedUnfixed} VPS-caused search failure(s) still unfixed`));
  } else {
    gates.push({ id: 'stability-search-failures', pass: true, reasons: [] });
  }

  if (!reviewed(s.restarts)) {
    gates.push(fail('stability-restarts', 'restarts were not reviewed for the period'));
  } else if (s.restarts.unexplainedRestarts > 0) {
    gates.push(fail('stability-restarts', `${s.restarts.unexplainedRestarts} unexplained restart(s) in the period`));
  } else {
    gates.push({ id: 'stability-restarts', pass: true, reasons: [] });
  }

  if (!reviewed(s.backupAge)) {
    gates.push(fail('stability-backup-age', 'backup age was not reviewed for the period'));
  } else if (
    s.backupAge.youngestBackupMinutesAgo === null ||
    s.backupAge.youngestBackupMinutesAgo > s.backupAge.maxAcceptedBackupMinutes
  ) {
    gates.push(fail(
      'stability-backup-age',
      `youngest backup is ${s.backupAge.youngestBackupMinutesAgo ?? 'unknown'} min old, older than the accepted ${s.backupAge.maxAcceptedBackupMinutes} min`,
    ));
  } else {
    gates.push({ id: 'stability-backup-age', pass: true, reasons: [] });
  }

  if (!reviewed(s.storageGrowth)) {
    gates.push(fail('stability-storage-growth', 'storage growth was not reviewed for the period'));
  } else if (!s.storageGrowth.headroomOk) {
    gates.push(fail('stability-storage-growth', 'storage headroom does not cover the retention window'));
  } else {
    gates.push({ id: 'stability-storage-growth', pass: true, reasons: [] });
  }

  const r = evidence.recovery.restore;
  if (typeof r.ranAt !== 'string' || r.ranAt.length === 0) {
    gates.push(fail('recovery-restore', 'no real off-box restore drill has been run'));
  } else if (!r.withinObservationPeriod) {
    gates.push(fail('recovery-restore', 'the last restore drill is older than the observation period'));
  } else if (!r.integrityOk || !r.countsMatch || !r.dashboardServedFromScratch) {
    const missing = [
      !r.integrityOk ? 'integrity_check' : null,
      !r.countsMatch ? 'per-table counts' : null,
      !r.dashboardServedFromScratch ? 'scratch dashboard load' : null,
    ].filter((part): part is string => part !== null);
    gates.push(fail('recovery-restore', `restore drill incomplete: ${missing.join(', ')} not confirmed`));
  } else {
    gates.push({ id: 'recovery-restore', pass: true, reasons: [] });
  }

  const v = evidence.recovery.vpsEvidence;
  if (typeof v.verifiedAt !== 'string' || v.verifiedAt.length === 0) {
    gates.push(fail('recovery-vps-evidence', 'VPS production evidence was not verified'));
  } else if (!v.versionMatchesDeploy || !v.dashboardOk || !v.headersOk) {
    gates.push(fail('recovery-vps-evidence', 'VPS production evidence is incorrect (version, dashboard or headers)'));
  } else {
    gates.push({ id: 'recovery-vps-evidence', pass: true, reasons: [] });
  }

  if (typeof evidence.inventory.recordedAt !== 'string' || evidence.inventory.recordedAt.length === 0) {
    gates.push(fail('inventory', 'no private secrets/resources inventory is recorded'));
  } else {
    gates.push({ id: 'inventory', pass: true, reasons: [] });
  }

  return { readyForDecision: gates.every((gate) => gate.pass), gates };
}

export function deletionStatus(evidence: RetirementEvidence): {
  step: string;
  allowed: boolean;
  reason: string;
}[] {
  const known = new Map(evidence.deletions.map((entry) => [entry.step, entry.ownerInstruction]));
  return DELETION_STEPS.map((step) => {
    const instruction = known.get(step);
    if (typeof instruction === 'string' && instruction.length > 0) {
      return { step, allowed: true, reason: `explicit owner instruction: ${instruction}` };
    }
    return { step, allowed: false, reason: 'blocked: no explicit owner instruction recorded' };
  });
}
