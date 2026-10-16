/**
 * `SqlDriver` over Node's built-in SQLite (Node ≥ 22.5). Used by tests and tools; the desktop app uses the
 * Tauri SQL plugin. WAL + synchronous=FULL: a committed sale survives a crash or power loss.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from './sql.js';

export function nodeSqliteDriver(path: string): SqlDriver {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  let open = true;
  return {
    async execute(sql, params = []) {
      const r = db.prepare(sql).run(...(params as SqlValue[]));
      return { changes: Number(r.changes) };
    },
    async select<T>(sql: string, params: readonly SqlValue[] = []) {
      return db.prepare(sql).all(...(params as SqlValue[])) as T[];
    },
    async transaction<T>(fn: () => Promise<T>) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async close() {
      if (open) db.close();
      open = false;
    },
  };
}
