import type { SqlDriver, SqlValue } from '@1pos/pos-offline';
import { invoke } from '@tauri-apps/api/core';
import type { ByteChannel } from './devices';

/**
 * The Tauri shell's native side (src-tauri, ADR-0015 slice 5): the till database, the printer byte
 * channel and the terminal credential. Browser mode has none of these (ADR-0006) — check `isDesktop`.
 */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The server a new till suggests at set-up (`VITE_API_URL` at build time). */
export const defaultApiUrl: string = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4320';

/**
 * Where the API is. Browser mode goes through its own origin (the Vite proxy). The desktop app is
 * served from tauri.localhost and calls the API directly (the API's CORS_ORIGINS must list it), at
 * the address saved at set-up.
 */
let base: string = isDesktop ? defaultApiUrl : '';
export const apiBase = () => base;
export function setApiBase(url: string) {
  if (isDesktop) base = url;
}

/**
 * A server address as the till keeps it: the origin only. HTTPS, or plain HTTP to this machine
 * (development); anything else is refused (null), so the terminal key never crosses a network unencrypted.
 */
export function normalizeApiUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u.origin;
  return null;
}

/**
 * `SqlDriver` over the shell's single SQLite connection (WAL, synchronous=FULL). The connection
 * outlives the page: a reload or a web view crash mid-transaction would leave it inside that
 * transaction, so a new page first rolls back whatever the previous one left open (it never committed).
 */
export function tauriSqlDriver(): SqlDriver {
  const ready = invoke('sql_rollback');
  return {
    execute: async (sql, params = []) => {
      await ready;
      return invoke<{ changes: number }>('sql_execute', { sql, params: params as SqlValue[] });
    },
    select: async <T>(sql: string, params: readonly SqlValue[] = []) => {
      await ready;
      return invoke<T[]>('sql_select', { sql, params });
    },
    async transaction<T>(fn: () => Promise<T>) {
      await ready;
      await invoke('sql_begin');
      try {
        const out = await fn();
        await invoke('sql_commit');
        return out;
      } catch (e) {
        await invoke('sql_rollback');
        throw e;
      }
    },
    async close() {
      // The shell owns the connection for the life of the window.
    },
  };
}

export type PrinterTarget = { kind: 'network'; host: string; port: number } | { kind: 'windows'; name: string };

/** Raw ESC/POS bytes to a network printer or a printer installed in Windows. */
export function tauriByteChannel(target: PrinterTarget, timeoutMs = 8_000): ByteChannel {
  return (bytes) => invoke('printer_send', { target, bytes: Array.from(bytes), timeoutMs });
}

export const windowsPrinters = () => invoke<string[]>('printer_list');

/** The terminal credential in Windows Credential Manager; only the shell can read it back. */
export const terminalSecret = {
  get: () => invoke<string | null>('secret_get', { key: 'terminal' }),
  set: (value: string) => invoke<void>('secret_set', { key: 'terminal', value }),
  clear: () => invoke<void>('secret_delete', { key: 'terminal' }),
};
