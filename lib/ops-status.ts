/**
 * F8/T24: sanitized operational evaluation for the self-hosted target.
 *
 * F8 keeps the old Cloudflare deployment as a rollback until the new service
 * has demonstrated stable operation over an owner-selected observation period.
 * This module is the shape of that review: it takes owner-collected,
 * secret-free evidence (service states, refresh outcomes, replica age, disk
 * figures) and returns a PASS/WARN/FAIL verdict per area. It never touches a
 * host, a credential, or production data itself — the owner collects the
 * evidence on the VPS with the commands `scripts/check-ops-status.mjs
 * --print-collection` prints, and that script evaluates a pasted JSON file.
 * Every value below is synthetic in tests and owner-supplied in use.
 *
 * Thresholds and why (all overridable via `OpsThresholds`):
 * - Refresh cadence 6h matches `deploy/ikbeneenappel-refresh.timer` and the
 *   `0 *\/6 * * *` trigger in `vite.config.ts`. No successful tick within
 *   twice the cadence means scheduled collection is broken, not merely late.
 * - Litestream `sync-interval` is 10s (`deploy/litestream.yml`), so a replica
 *   older than 1h means replication has stopped; older than 24h means it
 *   stopped more than a daily attention cycle ago.
 * - Full advertisement text is ~5 KB (`docs/HOSTING_COST_ANALYSIS.md` §3), so
 *   500 MB is ~100k adverts — five times the 20k catalogue model — and worth
 *   a look; 2 GB means the growth assumption behind the VPS disk sizing no
 *   longer holds.
 * - 5 GB / 1 GB free-disk floors leave room for WAL, Litestream staging and
 *   one restore-drill scratch copy on the 80 GB start tier.
 */

export type OpsVerdict = 'pass' | 'warn' | 'fail';

export interface OpsCheck {
  area: 'services' | 'refresh' | 'backup' | 'storage' | 'deploy';
  verdict: OpsVerdict;
  summary: string;
}

/** One systemd unit as reported by the owner for the observation period. */
export interface OpsServiceState {
  /** Unit name, e.g. `ikbeneenappel-web.service`. */
  name: string;
  /** Whether the unit is active at collection time. */
  active: boolean;
  /** Restarts counted within the observation period (from `systemctl show`). */
  restarts: number;
}

/** One refresh tick outcome as printed by `scripts/run-refresh.mjs`. */
export interface OpsRefreshRun {
  /** ISO timestamp of the tick. */
  at: string;
  /** Whether the tick exited 0 (even a deliberate no-op when disabled). */
  ok: boolean;
  /** Source keys that reported `failed` on this tick, if any. */
  failedSources: string[];
}

/** Replica freshness: the newest snapshot/WAL timestamp in the bucket. */
export interface OpsBackupState {
  /** ISO timestamp of the newest replica object (UTC, from the bucket listing). */
  lastReplicaAt: string;
}

/** Disk figures from `df` / `stat` on the VPS (bytes, never paths with data). */
export interface OpsStorageState {
  /** Current size of the live SQLite file. */
  dbBytes: number;
  /** Free bytes on the database volume. */
  freeBytes: number;
}

export interface OpsEvidence {
  /** ISO start of the owner-selected observation period (F8 gate). */
  periodStart: string;
  /** ISO collection time; backup age is measured against this, defaulting to now. */
  collectedAt: string;
  services: OpsServiceState[];
  refreshRuns: OpsRefreshRun[];
  backup: OpsBackupState;
  storage: OpsStorageState;
}

export interface OpsThresholds {
  refreshCadenceMs: number;
  backupWarnAgeMs: number;
  backupFailAgeMs: number;
  dbWarnBytes: number;
  dbFailBytes: number;
  diskWarnFreeBytes: number;
  diskFailFreeBytes: number;
}

export const DEFAULT_OPS_THRESHOLDS: OpsThresholds = {
  refreshCadenceMs: 6 * 3_600_000,
  backupWarnAgeMs: 3_600_000,
  backupFailAgeMs: 24 * 3_600_000,
  dbWarnBytes: 500 * 1_048_576,
  dbFailBytes: 2 * 1_073_741_824,
  diskWarnFreeBytes: 5 * 1_073_741_824,
  diskFailFreeBytes: 1 * 1_073_741_824,
};

/** Units this deployment owns. Anything else on the box is out of scope. */
export const EXPECTED_UNITS = [
  'ikbeneenappel-web.service',
  'ikbeneenappel-refresh.service',
  'ikbeneenappel-litestream.service',
] as const;

const SECRET_LIKE = /secret|password|passwd|token|api[_-]?key|session[_-]?secret|private[_-]?key|credential/i;

function worst(left: OpsVerdict, right: OpsVerdict): OpsVerdict {
  if (left === 'fail' || right === 'fail') return 'fail';
  if (left === 'warn' || right === 'warn') return 'warn';
  return 'pass';
}

export function overallVerdict(checks: OpsCheck[]): OpsVerdict {
  return checks.reduce<OpsVerdict>((acc, check) => worst(acc, check.verdict), 'pass');
}

/**
 * Sanitization gate: evidence must never carry secrets. Any secret-like key
 * at any depth rejects the whole file before evaluation, so a pasted
 * EnvironmentFile can never become a "passing check" — or a leak into a
 * transcript. Values are never printed by the evaluator either.
 */
export function assertSanitized(value: unknown, path = 'evidence'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSanitized(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_LIKE.test(key)) {
        throw new Error(`Refusing ${path}: secret-like key "${key}" must never enter ops evidence.`);
      }
      assertSanitized(entry, `${path}.${key}`);
    }
  }
}

function parseTime(value: string, field: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`Invalid ${field}: not an ISO timestamp: ${value}`);
  return time;
}

export function checkServices(
  services: OpsServiceState[],
  periodStart: string,
): OpsCheck {
  parseTime(periodStart, 'periodStart');
  const missing = EXPECTED_UNITS.filter(
    (unit) => !services.some((service) => service.name === unit),
  );
  const inactive = services.filter((service) => !service.active);
  const restarted = services.filter((service) => service.restarts > 0);
  if (missing.length > 0) {
    return {
      area: 'services',
      verdict: 'fail',
      summary: `Missing evidence for ${missing.join(', ')}; every owned unit must report.`,
    };
  }
  if (inactive.length > 0) {
    return {
      area: 'services',
      verdict: 'fail',
      summary: `${inactive.map((service) => service.name).join(', ')} not active.`,
    };
  }
  if (restarted.length > 0) {
    return {
      area: 'services',
      verdict: 'warn',
      summary: `All units active, but restarts in period: ${restarted
        .map((service) => `${service.name}=${service.restarts}`)
        .join(', ')}. Review with journalctl before the retirement decision.`,
    };
  }
  return { area: 'services', verdict: 'pass', summary: 'All three units active, no restarts in period.' };
}

export function checkRefresh(
  runs: OpsRefreshRun[],
  periodStart: string,
  collectedAt: string,
  thresholds: OpsThresholds = DEFAULT_OPS_THRESHOLDS,
): OpsCheck {
  const start = parseTime(periodStart, 'periodStart');
  const now = parseTime(collectedAt, 'collectedAt');
  const inPeriod = runs.filter((run) => parseTime(run.at, 'refreshRuns[].at') >= start);
  if (inPeriod.length === 0) {
    return {
      area: 'refresh',
      verdict: 'fail',
      summary: 'No refresh tick evidence inside the observation period.',
    };
  }
  const successes = inPeriod.filter((run) => run.ok);
  const lastSuccess = successes.length > 0
    ? Math.max(...successes.map((run) => Date.parse(run.at)))
    : Number.NaN;
  const failures = inPeriod.filter((run) => !run.ok);
  const failedSources = [...new Set(inPeriod.flatMap((run) => run.failedSources))].sort();
  if (Number.isNaN(lastSuccess) || now - lastSuccess > 2 * thresholds.refreshCadenceMs) {
    return {
      area: 'refresh',
      verdict: 'fail',
      summary: Number.isNaN(lastSuccess)
        ? `${inPeriod.length} tick(s) in period, none successful.`
        : `Last successful tick ${new Date(lastSuccess).toISOString()} is over two cadences old.`,
    };
  }
  if (failures.length > 0 || failedSources.length > 0) {
    return {
      area: 'refresh',
      verdict: 'warn',
      summary: `Recovering: last success ${new Date(lastSuccess).toISOString()}, but `
        + `${failures.length} failed tick(s)${failedSources.length > 0 ? ` (sources: ${failedSources.join(', ')})` : ''} in period.`,
    };
  }
  return {
    area: 'refresh',
    verdict: 'pass',
    summary: `${inPeriod.length} tick(s) in period, all successful; latest ${new Date(lastSuccess).toISOString()}.`,
  };
}

export function checkBackup(
  backup: OpsBackupState,
  collectedAt: string,
  thresholds: OpsThresholds = DEFAULT_OPS_THRESHOLDS,
): OpsCheck {
  const now = parseTime(collectedAt, 'collectedAt');
  const replica = parseTime(backup.lastReplicaAt, 'backup.lastReplicaAt');
  const ageMs = now - replica;
  if (ageMs < 0) {
    return { area: 'backup', verdict: 'fail', summary: 'Replica timestamp is in the future; check clock sync (chrony) and re-collect.' };
  }
  const ageMinutes = Math.round(ageMs / 60_000);
  if (ageMs > thresholds.backupFailAgeMs) {
    return {
      area: 'backup',
      verdict: 'fail',
      summary: `Newest replica is ${ageMinutes} min old — replication has been still for over a day. Do not cut over or retire until a restore passes.`,
    };
  }
  if (ageMs > thresholds.backupWarnAgeMs) {
    return {
      area: 'backup',
      verdict: 'warn',
      summary: `Newest replica is ${ageMinutes} min old; Litestream syncs every 10s, so replication may have stalled.`,
    };
  }
  return { area: 'backup', verdict: 'pass', summary: `Newest replica is ${ageMinutes} min old.` };
}

export function checkStorage(
  storage: OpsStorageState,
  thresholds: OpsThresholds = DEFAULT_OPS_THRESHOLDS,
): OpsCheck {
  if (!Number.isFinite(storage.dbBytes) || storage.dbBytes < 0) {
    throw new Error('Invalid storage.dbBytes: must be a non-negative byte count.');
  }
  if (!Number.isFinite(storage.freeBytes) || storage.freeBytes < 0) {
    throw new Error('Invalid storage.freeBytes: must be a non-negative byte count.');
  }
  const dbMb = Math.round(storage.dbBytes / 1_048_576);
  const freeGb = (storage.freeBytes / 1_073_741_824).toFixed(1);
  if (storage.freeBytes < thresholds.diskFailFreeBytes) {
    return {
      area: 'storage',
      verdict: 'fail',
      summary: `Only ${freeGb} GB free on the database volume (db ${dbMb} MB). Restore drills and WAL staging need headroom; grow the disk before cutover.`,
    };
  }
  if (storage.dbBytes >= thresholds.dbFailBytes) {
    return {
      area: 'storage',
      verdict: 'fail',
      summary: `Database file is ${dbMb} MB — the growth model behind the disk sizing no longer holds. Review before cutover.`,
    };
  }
  if (storage.freeBytes < thresholds.diskWarnFreeBytes || storage.dbBytes >= thresholds.dbWarnBytes) {
    return {
      area: 'storage',
      verdict: 'warn',
      summary: `Database file ${dbMb} MB, ${freeGb} GB free. Watch growth across the observation period.`,
    };
  }
  return { area: 'storage', verdict: 'pass', summary: `Database file ${dbMb} MB, ${freeGb} GB free.` };
}

export function evaluateOpsEvidence(
  evidence: OpsEvidence,
  thresholds: OpsThresholds = DEFAULT_OPS_THRESHOLDS,
): { checks: OpsCheck[]; verdict: OpsVerdict } {
  assertSanitized(evidence);
  const checks = [
    checkServices(evidence.services, evidence.periodStart),
    checkRefresh(evidence.refreshRuns, evidence.periodStart, evidence.collectedAt, thresholds),
    checkBackup(evidence.backup, evidence.collectedAt, thresholds),
    checkStorage(evidence.storage, thresholds),
  ];
  return { checks, verdict: overallVerdict(checks) };
}

/**
 * Static coherence of the service tooling itself: the timer must fire at the
 * cadence the evaluator assumes, Litestream must retain the 30-day window the
 * restore story promises, the collector must stay oneshot and the web unit
 * restart-on-failure, and nginx must keep the auth burst brake. Takes file
 * contents (not paths) so tests can use fixtures and the CLI reads the repo.
 */
export function checkDeployArtifacts(files: Record<string, string>): OpsCheck {
  const problems: string[] = [];
  const timer = files['deploy/ikbeneenappel-refresh.timer'] ?? '';
  if (!/OnCalendar=\*-\*-\* 00,06,12,18:00/.test(timer)) {
    problems.push('refresh.timer is not on the 00,06,12,18 6-hour cadence the evaluator assumes');
  }
  const litestream = files['deploy/litestream.yml'] ?? '';
  if (!/retention:\s*720h/.test(litestream)) problems.push('litestream.yml does not retain 720h (30 days)');
  if (!/sync-interval:\s*10s/.test(litestream)) problems.push('litestream.yml does not sync every 10s');
  const refresh = files['deploy/ikbeneenappel-refresh.service'] ?? '';
  if (!/^Type=oneshot/m.test(refresh)) problems.push('refresh.service is not Type=oneshot (overlap guard)');
  const web = files['deploy/ikbeneenappel-web.service'] ?? '';
  if (!/^Restart=on-failure/m.test(web)) problems.push('web.service is not Restart=on-failure');
  const nginx = files['deploy/nginx-ikbeneenappel.conf'] ?? '';
  if (!/limit_req_zone/.test(nginx) || !/limit_req_status 503/.test(nginx)) {
    problems.push('nginx conf is missing the auth limit_req brake (refuse with 503)');
  }
  if (Object.keys(files).length === 0) problems.push('no deploy artifacts supplied');
  if (problems.length > 0) {
    return { area: 'deploy', verdict: 'fail', summary: problems.join('; ') + '.' };
  }
  return { area: 'deploy', verdict: 'pass', summary: 'Timer cadence, retention, unit guards and the nginx brake all match.' };
}
