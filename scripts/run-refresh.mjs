#!/usr/bin/env node
/**
 * VPS-04 (#197): self-hosted replacement for the Cloudflare Cron Trigger.
 *
 * The refresh handler itself (`handlePublicRefreshCron` in
 * `lib/public-refresh-scheduler.ts`) is already runtime-agnostic — it takes
 * its `db`, `enabled` and `terms` as plain inputs. Only the delivery
 * mechanism was Cloudflare-specific (`worker/entry.ts`'s `scheduled` export,
 * fired by the `0 *\/6 * * *` trigger in `vite.config.ts`). This script is the
 * other delivery mechanism: open the SQLite adapter, ensure the schema, run
 * one tick, and exit non-zero on failure so the systemd timer surfaces it.
 *
 * Run with: `npm run refresh` (which supplies `--import tsx`, needed for the
 * `.ts` imports below — the same pattern as `bootstrap:prod-admin`).
 *
 * Configuration comes from the environment, normally a root-owned `0600`
 * systemd `EnvironmentFile`:
 * - `SQLITE_PATH` (required): path to the self-hosted SQLite file. Unset
 *   means "Cloudflare path", where `DB` is a real binding — this script
 *   refuses instead of guessing.
 * - `PUBLIC_REFRESH_ENABLED` (required to do anything): exactly `'true'`
 *   runs the tick; anything else (including unset) is a deliberate no-op
 *   that still exits 0. Disabled by default.
 * - `PUBLIC_REFRESH_TERMS`: comma-separated role keywords. Empty wires no
 *   fetchers — the run keeps locks, cursors and freshness truthful but
 *   contacts no upstream source.
 *
 * Overlap safety is two layers: the systemd service is `Type=oneshot`, so a
 * firing while the previous run is still active does not start a second copy,
 * and the 5-minute `PUBLIC_REFRESH_LEASE_MS` database lease means that even a
 * manually overlapping run reports `busy` instead of duplicating upstream
 * calls. The 6-hour window and per-source cooldowns are durable rows carried
 * over from the D1 export, so a migrated database does not perform a full
 * refresh on its first tick.
 *
 * `worker/entry.ts`'s `scheduled` export stays for the Cloudflare path until
 * cutover (#201) — do not delete it here.
 */
import { bindings, ensureSchema } from '../db/runtime.ts';
import {
  handlePublicRefreshCron,
  parseRefreshTerms,
} from '../lib/public-refresh-scheduler.ts';

const databasePath = process.env.SQLITE_PATH;
if (typeof databasePath !== 'string' || databasePath === '') {
  console.error('SQLITE_PATH is not set. This is the self-hosted refresh; point it at the SQLite file.');
  process.exit(1);
}

const enabled = process.env.PUBLIC_REFRESH_ENABLED === 'true';
const terms = parseRefreshTerms(process.env.PUBLIC_REFRESH_TERMS);

try {
  await ensureSchema();
  const { db } = bindings();
  const outcome = await handlePublicRefreshCron({ db, enabled, terms });
  console.log(JSON.stringify({
    enabled: outcome.enabled,
    claimedQueue: outcome.claimedQueue,
    results: outcome.report.results.map((entry) => ({
      sourceKey: entry.sourceKey,
      status: entry.status,
    })),
    ignoredKeys: outcome.report.ignoredKeys,
  }));
} catch (error) {
  console.error(`Public refresh tick failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
