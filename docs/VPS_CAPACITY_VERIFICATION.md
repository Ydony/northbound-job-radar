# VPS capacity and search verification (T04)

This is the **procedure and blank evidence form**, not a claim that the selected VPS has passed. F1 remains gated on the owner's host, storage, provisioning and capacity walkthrough decisions. Run only on a disposable/scratch instance with synthetic or owner-authorized restored data. Never load-test DEV, TEST, Cloudflare production, or the public job providers by accident.

## What already exists

- `docs/FUNCTIONALITY_MAP.md` maps the collection and catalogue paths; `docs/VPS_MIGRATION_PLAN.md` explains the initial VPS sizing assumptions.
- `scripts/verify-selfhosted.mjs` boots an isolated empty SQLite standalone bundle and exercises registration, state, criteria **and `/api/scrape`**. Its current comment about “no provider calls” is unsafe: enabled public ATS/EURES/Job-Room/FreeHire adapters can contact providers even without credentials. **Do not run it on a networked host for this procedure.** It is usable only inside an independently verified egress-blocked sandbox, and a blocked search is not proof of provider throughput.
- `tests/catalogue-query.test.ts`, `tests/sqlite-adapter.test.ts`, `tests/public-refresh.test.ts` and `tests/collection-budgets.test.ts` use synthetic data to check serving, WAL, refresh and collection budgets.
- `scripts/measure-board-fetches.ts` contacts real ATS boards. **Do not use it for a VPS capacity run**: it measures provider reliability, not local CPU or SQLite throughput.

## Prepare the runner

1. Record the exact commit (`git rev-parse HEAD`), Node version, CPU/RAM/disk, operating system, SQLite file size and row counts. Use a separate instance and database, not the live file. Keep the web and refresh services independent as in `deploy/`; do not change the production timer for this test.
2. On the isolated checkout, run `npm ci`, `npm run build`, `npx tsx --test tests/sqlite-adapter.test.ts tests/catalogue-query.test.ts tests/public-refresh.test.ts tests/collection-budgets.test.ts`, and `node --test tests/capacity-probe.test.mjs`. These are synthetic/local checks. Do **not** include `npm run verify:selfhosted` unless an operator first proves outbound egress is blocked. The load probe needs a **different** scratch server that stays running for the walkthrough.
3. For an empty smoke instance, bootstrap a synthetic account by the local first-registration flow. For a **representative capacity decision**, use an **owner-approved restored backup into a separate scratch SQLite file**, never the live file. From `docs/DEPLOY.md`'s restore drill, use **step 2's distinct restore destination, step 3's integrity/schema check, and step 4's row-count comparison only**. Do not run that drill's live-service stop/start steps 1 or 6 merely for this capacity test. The owner signs in to the scratch copy with an existing account whose holdings represent the workload; a newly registered empty account would make the measurement invalid. The scratch server must use its own fresh session secret, so live cookies do not work there. This is the reproducible realistic data path; the synthetic catalogue tests above establish correctness but their fixture is intentionally disposable and is not exported into a standalone database. Record the backup snapshot identifier and exact row counts. An empty/small database is a smoke test, **not** capacity evidence.
   - Launch from the isolated checkout on the VPS with a **scratch** path (shown below). Confirm the path is not the live `SQLITE_PATH` from `/etc/ikbeneenappel/env` before starting. Do not load the live environment file: it contains provider credentials. Keep this process off public nginx routes; no refresh timer runs against it. The shell holding `CAPACITY_SECRET` is private and must not be logged.

     ```sh
     export CAPACITY_DB=/var/lib/ikbeneenappel/restore-drill.sqlite
     export CAPACITY_SECRET="$(openssl rand -base64 48)"
     HOST=127.0.0.1 PORT=3211 SQLITE_PATH="$CAPACITY_DB" \
       SESSION_SECRET="$CAPACITY_SECRET" ALLOW_SIGNUPS=false \
       node dist/standalone/server.js
     ```

   - Use a separate terminal for the probe and record this process's PID. Stop **only** this scratch process after measurement, then follow the restore-drill cleanup procedure. Never stop the live web/refresh units merely for a capacity probe.
   - Minimum dataset check for the **measured account** on the planned first-stage VPS: at least 2,000 held jobs, both countries, at least three source types and nonzero saved/applied/dismissed rows. Whole-database totals do not meet this check. If the approved backup does not have this shape for one account, record the shortfall and leave capacity acceptance open rather than inventing a passing synthetic result.
   - On the scratch SQLite file only, bind `:me` to the measured account's `users.id` in the local `sqlite3` session and record the following counts (do not copy the account identifier into review evidence):

     ```sql
     SELECT COUNT(*) FROM jobs WHERE user_id = :me;
     SELECT country, COUNT(*) FROM jobs WHERE user_id = :me GROUP BY country;
     SELECT source_key, COUNT(*) FROM jobs WHERE user_id = :me GROUP BY source_key;
     SELECT application_status, visibility_status, is_saved, COUNT(*)
       FROM user_vacancy_state WHERE user_id = :me
       GROUP BY application_status, visibility_status, is_saved;
     PRAGMA journal_mode;
     PRAGMA quick_check;
     ```

     A failed integrity check blocks the run.
4. Sign in to the measured scratch account. Put **that scratch session's** cookie as one `Cookie` header line in a local ignored file, with permissions `0600`; never paste it into an issue, PR, command line, or committed file. The file is read by the probe and is not printed. Set a shell variable such as `CAPACITY_COOKIE_FILE` to its absolute path. Delete the cookie file after the run. Never copy a live account's cookie into this file.
5. Check `curl -fsS http://127.0.0.1:3211/login` and one signed-in `/api/state` response before loading. A `401`, unexpected redirect, or empty catalogue invalidates the run. Do not treat the separate `verify:selfhosted` server as this scratch instance.

## Bounded run

`scripts/measure-vps-capacity.mjs` issues **GET `/api/state` only**. It does not trigger `/api/scrape`, refresh or any provider, and it refuses redirects instead of following them. It rejects more than 50 requests or five in flight, times each request out after 15 seconds, stops scheduling after the first failure (cancelling in-flight requests), and exits nonzero if any request fails. Its JSON separates requested, attempted, successful, failed and **cancelled sibling** requests; cancellations caused by the first failure are not counted as additional failures or latency samples. A remote HTTPS origin requires `--owner-host` as an explicit acknowledgment; use only the owner-approved scratch hostname.

```sh
# On the isolated host; cookie file contains only the scratch-session cookie.
node scripts/measure-vps-capacity.mjs --base http://127.0.0.1:3211 \
  --cookie-file "$CAPACITY_COOKIE_FILE" --requests 20 --parallel 1
node scripts/measure-vps-capacity.mjs --base http://127.0.0.1:3211 \
  --cookie-file "$CAPACITY_COOKIE_FILE" --requests 50 --parallel 5
```

Use the low-concurrency run as baseline, then the five-way run once. Do not loop the script. If the owner authorizes the real hostname walkthrough, use its HTTPS scratch origin with `--owner-host`; never use the live production origin. Record the probe JSON (which contains no cookie) in the evidence form. The browser search-results page must also be checked with the same measured scratch account: note first-page load, next-page load, filter change and whether counts agree. For a **real collection search**, the owner must separately authorize provider traffic and its source-specific request budget; this read-only probe does not prove provider throughput.

During each probe, sample the **scratch** web service (not the production unit or the whole host alone). Set `CAPACITY_WEB_PID` and `CAPACITY_SERVICE` to the scratch process and scratch unit after verifying their command line and database path; if the scratch process was started without systemd, use its recorded PID and its own log file instead of `journalctl`:

```sh
pidstat -u -r -p "$CAPACITY_WEB_PID" 1 60
vmstat 1 60
free -m
sudo journalctl -u "$CAPACITY_SERVICE" --since '10 minutes ago' --no-pager \
  | grep -Ei 'SQLITE_BUSY|database is locked|timeout|out.of.memory|fatal' || true
```

`pidstat` comes from `sysstat`; install it on the scratch host before the run if absent. Note whether a refresh or any other writer overlapped. If no writer overlapped, mark SQLite **write contention untested**, not “zero.” A safe owner-witnessed writer-overlap trial must use only scratch data and the existing refresh/collection controls; stop on any `SQLITE_BUSY`, failed request, or slow-write escalation. Do not create artificial write locks on the live database.

## Stop / sizing decision

Stop immediately for any non-200 response, timeout, SQLite busy/locked error, OOM, swap thrash, or unexpected provider request. Record the failure and leave the VPS acceptance open. As provisional review triggers, investigate p95 above 2 seconds, web process RSS above 75% of available RAM, or sustained CPU above 85% for a 60-second sample. These are **decision prompts**, not universal performance guarantees: the owner and reviewer set the final target for the selected host and representative data. Repeat only after a documented code/sizing change, with the same dataset and workload.

## Evidence form (copy into the T04/F1 review)

| Field | Observation |
|---|---|
| Date, operator, reviewer, owner authorization | |
| Git SHA, Node version, instance size/region, SQLite journal mode | |
| Scratch database provenance, size, catalogue/holding row counts | |
| Provider credentials absent; refresh disabled/controlled; cookie file removed | |
| Four focused test files + probe tests: pass/fail; `verify:selfhosted` only if egress-blocked | |
| Baseline `/api/state`: requested/attempted/aborted, parallelism, p50/p95/max, real failures | |
| Five-way `/api/state`: requested/attempted/aborted, parallelism, p50/p95/max, real failures | |
| Web CPU peak/sustained, RSS peak, host free RAM/swap, I/O wait | |
| Search-results page/next page/filter observations and count consistency | |
| Writer overlap? SQLite busy/locked count, lock waits, journal observations | |
| Real provider search authorized/run? Source budget, duration, failures | |
| Stop trigger, corrective action, rerun SHA and measured difference | |
| Decision: pass / resize / optimize / block; owner and reviewer sign-off | |

Do not mark F1 complete from this form alone: restore, HTTPS, restart, rollback and production-SHA gates have separate evidence.
