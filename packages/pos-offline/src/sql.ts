/**
 * The smallest SQL surface the offline store needs, so one store runs on `node:sqlite` (tests, tools)
 * and on the Tauri SQL plugin (the desktop app, ADR-0006). Async, because the plugin is.
 */
export interface SqlDriver {
  /** Statements without results (DDL, INSERT, UPDATE). */
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  select<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /**
   * Run `fn` atomically: everything it executes commits together or not at all. The store never runs
   * two transactions at once on one driver (the engine serializes its work).
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type SqlValue = string | number | null;
