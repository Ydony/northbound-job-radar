#!/usr/bin/env node
/**
 * T25 (F8): check the Cloudflare retirement evidence against the checklist.
 *
 * The evidence file is assembled by hand from VPS-side observations (see
 * `docs/CLOUDFLARE_RETIREMENT_CHECKLIST.md`) — this script judges its shape,
 * never production. A pass means the owner may *decide* on retirement; every
 * deletion step (D1–D5) still needs its own explicit owner instruction, which
 * the report lists as allowed/blocked.
 *
 * Usage:
 *   npm run verify:retirement-readiness -- <evidence.json>
 *   npm run verify:retirement-readiness -- --example-pass     # synthetic, must pass
 *   npm run verify:retirement-readiness -- --example-blocked  # synthetic, must fail
 *
 * Prints a JSON report on stdout; exits 0 when ready for a decision, 1 otherwise.
 * Deletion steps blocked for lack of instruction do NOT fail the exit code —
 * blocked is their safe state. Pass `--require-deletion <D2>` to additionally
 * require one step to be allowed (used only to rehearse the gate, not to delete).
 */
import { readFileSync } from 'node:fs';
import { deletionStatus, evaluateRetirementReadiness } from '../lib/retirement-readiness.ts';

function example(pass) {
  const stability = pass
    ? {
        searchFailures: { reviewedAt: '2026-10-01', vpsCausedUnfixed: 0 },
        restarts: { reviewedAt: '2026-10-01', unexplainedRestarts: 0 },
        backupAge: { reviewedAt: '2026-10-01', youngestBackupMinutesAgo: 4, maxAcceptedBackupMinutes: 60 },
        storageGrowth: { reviewedAt: '2026-10-01', headroomOk: true },
      }
    : {
        searchFailures: { reviewedAt: null, vpsCausedUnfixed: 0 },
        restarts: { reviewedAt: '2026-10-01', unexplainedRestarts: 1 },
        backupAge: { reviewedAt: '2026-10-01', youngestBackupMinutesAgo: null, maxAcceptedBackupMinutes: 60 },
        storageGrowth: { reviewedAt: '2026-10-01', headroomOk: true },
      };
  return {
    observationDays: pass ? 14 : null,
    stability,
    recovery: pass
      ? {
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
        }
      : {
          restore: {
            ranAt: null,
            withinObservationPeriod: false,
            integrityOk: false,
            countsMatch: false,
            dashboardServedFromScratch: false,
          },
          vpsEvidence: { verifiedAt: null, versionMatchesDeploy: false, dashboardOk: false, headersOk: false },
        },
    inventory: { recordedAt: pass ? '2026-09-30' : null },
    deletions: [],
  };
}

const args = process.argv.slice(2);
let evidence;
let requireDeletion = null;
if (args.includes('--example-pass')) {
  evidence = example(true);
} else if (args.includes('--example-blocked')) {
  evidence = example(false);
} else {
  const fileArg = args.find((a) => !a.startsWith('--'));
  const reqIdx = args.indexOf('--require-deletion');
  if (reqIdx !== -1) requireDeletion = args[reqIdx + 1] ?? null;
  if (!fileArg) {
    console.error('Usage: verify-retirement-readiness.mjs <evidence.json> [--require-deletion <D1..D5>]');
    process.exit(2);
  }
  evidence = JSON.parse(readFileSync(fileArg, 'utf8'));
}

const { readyForDecision, gates } = evaluateRetirementReadiness(evidence);
const deletions = deletionStatus(evidence);
const required = requireDeletion
  ? deletions.find((d) => d.step === requireDeletion)
  : null;
if (requireDeletion && !required) {
  console.error(`Unknown deletion step ${requireDeletion}; want one of D1..D5.`);
  process.exit(2);
}
const report = {
  readyForDecision,
  gates,
  deletions,
  requiredDeletion: required,
};
console.log(JSON.stringify(report, null, 2));

const blocked = gates.filter((g) => !g.pass).map((g) => g.id);
if (!readyForDecision) {
  console.error(`Retirement NOT ready: ${blocked.join(', ')}.`);
  process.exit(1);
}
if (required && !required.allowed) {
  console.error(`Deletion ${required.step} blocked: ${required.reason}.`);
  process.exit(1);
}
console.log(
  'Retirement evidence complete: the owner may decide. No deletion is authorized by this result.',
);
