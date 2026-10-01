#!/usr/bin/env node
/**
 * F8/T24: sanitized operational checks and backup-age/storage alerts.
 *
 * The old Cloudflare deployment stays as a rollback until the VPS has shown
 * stable operation over an owner-selected observation period (F8). This is
 * the review instrument — and it is deliberately host-free: it never shells
 * out, never reads EnvironmentFiles, and never sees a credential. The owner
 * collects the evidence on the VPS with the commands printed by
 * `--print-collection`, pastes the numbers (timestamps, restart counts, byte
 * counts — never secrets) into a JSON file, and evaluates it here:
 *
 *   npm run check:ops -- --evidence /tmp/ops-evidence.json
 *
 * Exit codes: 0 all pass, 2 warnings only, 1 any failure or bad input.
 * `--now <iso>` overrides collectedAt for reproducible verification.
 * `--no-check-deploy` skips the static deploy-artifact coherence check.
 *
 * Evidence schema (all synthetic in tests, owner-supplied in use):
 * {
 *   "periodStart": "2026-10-01T00:00:00.000Z",
 *   "collectedAt": "2026-10-08T00:00:00.000Z",
 *   "services": [
 *     { "name": "ikbeneenappel-web.service", "active": true, "restarts": 0 },
 *     { "name": "ikbeneenappel-refresh.service", "active": true, "restarts": 0 },
 *     { "name": "ikbeneenappel-litestream.service", "active": true, "restarts": 0 }
 *   ],
 *   "refreshRuns": [ { "at": "...", "ok": true, "failedSources": [] } ],
 *   "backup": { "lastReplicaAt": "..." },
 *   "storage": { "dbBytes": 12345678, "freeBytes": 60000000000 }
 * }
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkDeployArtifacts,
  evaluateOpsEvidence,
  overallVerdict,
} from '../lib/ops-status.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const COLLECTION_COMMANDS = `# F8 ops-evidence collection — run on the VPS, paste NUMBERS only (never secrets).
# Observation period start is the owner's choice (F8 gate); keep it in the evidence file.

# 1. Unit states (ActiveState + restart counts for the period):
systemctl show ikbeneenappel-web.service ikbeneenappel-refresh.service ikbeneenappel-litestream.service \\
  --property=Id,ActiveState,NRestarts --timestamp=utc

# 2. Recent refresh outcomes (exit status per tick; detail only on failure):
systemctl list-timers ikbeneenappel-refresh.timer --all
journalctl -u ikbeneenappel-refresh.service --since "7 days ago" -o json | grep -o '"MESSAGE":"[^"]*"' | tail -30

# 3. Backup age: newest object in the off-box replica prefix (bucket listing, NOT a restore):
#    (R2/B2/S3 — list the replica prefix sorted by modification time, newest first)
#    Record its timestamp as backup.lastReplicaAt (UTC).

# 4. Storage: live database size + free space on its volume:
stat -c %s "$SQLITE_PATH"; df --output=avail -B1 "$(dirname "$SQLITE_PATH")" | tail -1

# 5. A real off-box restore is still a separate drill (docs/DEPLOY.md) — its
#    version/counts/integrity/dashboard evidence goes on the F8 record, not here.`;

function usageError(message) {
  console.error(`Usage: node scripts/check-ops-status.mjs [--print-collection] --evidence <path> [--now <iso>] [--root <dir>] [--no-check-deploy]`);
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--print-collection')) {
  console.log(COLLECTION_COMMANDS);
  process.exit(0);
}

const evidenceIndex = args.indexOf('--evidence');
if (evidenceIndex === -1 || !args[evidenceIndex + 1]) usageError('Missing --evidence <path>.');
const evidencePath = resolve(args[evidenceIndex + 1]);

const nowIndex = args.indexOf('--now');
const nowOverride = nowIndex === -1 ? undefined : args[nowIndex + 1];
if (nowIndex !== -1 && !nowOverride) usageError('Missing value for --now.');

const rootIndex = args.indexOf('--root');
const deployRoot = rootIndex === -1 ? root : resolve(args[rootIndex + 1]);
if (rootIndex !== -1 && !args[rootIndex + 1]) usageError('Missing value for --root.');

const checkDeploy = !args.includes('--no-check-deploy');

let evidence;
try {
  evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
} catch (error) {
  console.error(`Cannot read evidence file ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (nowOverride) evidence = { ...evidence, collectedAt: nowOverride };

try {
    const { checks } = evaluateOpsEvidence(evidence);
  const all = [...checks];
  if (checkDeploy) {
    const names = [
      'deploy/ikbeneenappel-refresh.timer',
      'deploy/litestream.yml',
      'deploy/ikbeneenappel-refresh.service',
      'deploy/ikbeneenappel-web.service',
      'deploy/nginx-ikbeneenappel.conf',
    ];
    const files = {};
    for (const name of names) {
      try {
        files[name] = readFileSync(join(deployRoot, name), 'utf8');
      } catch {
        // Absent file: the artifact check reports it as a failure itself.
      }
    }
    all.push(checkDeployArtifacts(files));
  }
  const overall = overallVerdict(all);
  for (const check of all) {
    console.log(`${check.verdict.toUpperCase().padEnd(4)} [${check.area}] ${check.summary}`);
  }
  console.log(JSON.stringify({ verdict: overall, periodStart: evidence.periodStart, collectedAt: evidence.collectedAt }, null, 2));
  process.exit(overall === 'pass' ? 0 : overall === 'warn' ? 2 : 1);
} catch (error) {
  console.error(`Evidence rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
