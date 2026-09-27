import { DatabaseSync } from 'node:sqlite';

/**
 * D1's interface, over SQLite, for the self-hosted target (VPS-02, #195).
 *
 * The point of this file is that nothing else changes. Roughly 197 `prepare()` call sites,
 * every migration in `db/migrations.ts`, and the whole test suite keep working untouched —
 * so the 538 tests that already exist are what prove the adapter is right, rather than a new
 * set of tests written to match whatever it happens to do.
 *
 * **`node:sqlite`, not `better-sqlite3`.** `docs/VPS_MIGRATION_PLAN.md` recommends the latter;
 * this deviates deliberately. `node:sqlite` is built into the runtime this project already
 * requires (`engines.node >= 22.13.0`), so it adds no dependency, needs no C++ toolchain on the
 * build machine, and cannot break on a Node upgrade the way a compiled native module does. It is
 * the same SQLite either way — which was the plan's actual argument for staying on SQLite at all.
 * The cost is that `node:sqlite` is still flagged experimental and prints a warning on load. If
 * that ever becomes unacceptable, `better-sqlite3` is a drop-in behind this same file: only the
 * three private methods at the bottom touch the driver.
 *
 * Only what the app uses is implemented. `exec()`, `dump()` and the Sessions API appear nowhere
 * in `app/`, `lib/`, `db/` or `worker/`, so they are absent rather than guessed at — a wrong
 * implementation of something unused is worse than its absence, because it looks available.
 */

/** Rows come back as plain objects; SQLite integers can exceed Number.MAX_SAFE_INTEGER. */
type Row = Record<string, unknown>;

/**
 * Does this statement return rows?
 *
 * `node:sqlite` splits reading from writing across two methods — `all()` yields rows but no
 * change count, `run()` yields a change count but no rows — while D1 has one statement that
 * does both. `batch()` therefore has to pick, and `.meta.changes` is read in 25 places, so
 * picking wrong is not cosmetic.
 */
function returnsRows(sql: string): boolean {
  return /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql);
}

/** SQLite hands back BigInt for large integers; D1 hands back numbers, and callers expect numbers. */
function plain(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

function plainRow(row: Row | undefined): Row | null {
  if (!row) return null;
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = plain(value);
  return out;
}

interface RunOutcome {
  results: Row[];
  changes: number;
  lastRowId: number;
}

class SqlitePreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}

  /** D1's `bind` returns a NEW statement rather than mutating this one; callers rely on that. */
  bind(...params: unknown[]): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.db, this.sql, params);
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = plainRow(this.execute().results[0]);
    if (row === null) return null;
    // `first('total')` returns that column's value, not the row. Used by the count queries.
    return (column === undefined ? row : row[column] ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const outcome = this.execute();
    return { results: outcome.results as T[], success: true, meta: { changes: outcome.changes } };
  }

  async run(): Promise<{ results: never[]; success: true; meta: { changes: number; last_row_id: number } }> {
    const outcome = this.execute();
    return { results: [], success: true, meta: { changes: outcome.changes, last_row_id: outcome.lastRowId } };
  }

  /** Synchronous, so `batch()` can run several inside one transaction without interleaving. */
  execute(): RunOutcome {
    const statement = this.db.prepare(this.sql);
    // `undefined` is not a SQLite value. D1 rejects it too, so surfacing it here keeps the two
    // runtimes failing the same way rather than one silently writing NULL.
    const bound = this.params.map((value) => {
      if (value === undefined) {
        throw new TypeError(`Cannot bind undefined in: ${this.sql.slice(0, 80)}`);
      }
      return value as never;
    });
    if (returnsRows(this.sql)) {
      const rows = statement.all(...bound) as Row[];
      return { results: rows.map((row) => plainRow(row) as Row), changes: 0, lastRowId: 0 };
    }
    const result = statement.run(...bound);
    return { results: [], changes: Number(result.changes ?? 0), lastRowId: Number(result.lastInsertRowid ?? 0) };
  }
}

class SqliteDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.db, sql);
  }

  /**
   * D1 has no interactive transactions — `batch` is the only atomic unit it offers, and this
   * codebase leans on that: account deletion, workspace reset and the catalogue writes all
   * depend on a batch being all-or-nothing. One SQLite transaction gives exactly that.
   */
  async batch<T = unknown>(
    statements: SqlitePreparedStatement[],
  ): Promise<{ results: T[]; success: true; meta: { changes: number; last_row_id: number } }[]> {
    this.db.exec('BEGIN');
    try {
      const outcomes = statements.map((statement) => statement.execute());
      this.db.exec('COMMIT');
      return outcomes.map((outcome) => ({
        results: outcome.results as T[],
        success: true as const,
        meta: { changes: outcome.changes, last_row_id: outcome.lastRowId },
      }));
    } catch (error) {
      // Leaving a transaction open would wedge every later write on this connection.
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back by SQLite */ }
      throw error;
    }
  }
}

let cached: { path: string; database: SqliteDatabase } | null = null;

/**
 * The SQLite-backed `DB` binding for the self-hosted target, cached per path.
 *
 * WAL because there is one writer (a collection run) and many readers (page loads), which is
 * precisely the case WAL exists for; without it a scrape blocks every reader for its duration.
 * `busy_timeout` so a reader waits for a write to finish instead of failing outright — D1 queues,
 * and code written against D1 does not expect SQLITE_BUSY.
 */
export function openSqliteDatabase(path: string): SqliteDatabase {
  if (cached && cached.path === path) return cached.database;
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA foreign_keys = ON');
  const database = new SqliteDatabase(raw);
  cached = { path, database };
  return database;
}

export type { SqliteDatabase, SqlitePreparedStatement };
