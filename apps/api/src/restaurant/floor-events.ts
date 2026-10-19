import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import pg from 'pg';
import { ENV } from '../infrastructure/env.provider.js';

const CHANNEL = 'onepos_floor';
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Changes on the floor and in the kitchen, pushed (session 16). Database triggers notify
 * `onepos_floor` with "<tenant>:<branch>" when a transaction touching orders, items, tickets or
 * bills commits. Each API process keeps one LISTEN connection (opened with the first stream, so
 * processes nobody streams from hold none) and calls the subscribers of that tenant and branch.
 * Notifications carry ids only; subscribers re-read through their normal, authorized routes.
 * After a lost connection every subscriber is called once, as changes may have been missed.
 */
@Injectable()
export class FloorEvents implements OnApplicationShutdown {
  private readonly logger = new Logger('FloorEvents');
  private readonly subs = new Map<string, Set<() => void>>();
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private failures = 0;
  private retry: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(@Inject(ENV) private readonly env: ServerEnv) {}

  /** Call `fn` whenever something changes at this branch. Returns the unsubscribe function. */
  subscribe(tenantId: string, branchId: string, fn: () => void): () => void {
    const key = `${tenantId}:${branchId}`;
    const set = this.subs.get(key) ?? new Set();
    set.add(fn);
    this.subs.set(key, set);
    void this.ensure();
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(key);
    };
  }

  /** Open streams now (for tests and metrics). */
  get listeners(): number {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }

  /** Resolves once the LISTEN connection is up (tests wait on it before changing anything). */
  async ready(): Promise<void> {
    await this.ensure();
  }

  private ensure(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = new pg.Client({ connectionString: this.env.DATABASE_URL });
      c.on('notification', (m) => {
        if (m.channel === CHANNEL && m.payload) this.dispatch(m.payload);
      });
      c.on('error', (e: Error & { code?: string }) => {
        this.logger.warn({ msg: 'floor events connection lost', code: e.code });
        this.lost(c);
      });
      c.on('end', () => this.lost(c));
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      const reconnected = this.failures > 0;
      this.client = c;
      this.failures = 0;
      if (reconnected) for (const set of this.subs.values()) for (const fn of set) fn();
    })()
      .catch((e: Error & { code?: string }) => {
        this.logger.warn({ msg: 'floor events could not listen', code: e.code });
        this.failures++;
        this.schedule();
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private lost(c: pg.Client) {
    if (this.client !== c) return;
    this.client = null;
    c.end().catch(() => undefined);
    this.failures++;
    this.schedule();
  }

  private schedule() {
    if (this.closed || this.retry || this.subs.size === 0) return;
    const wait = RETRY_MS[Math.min(this.failures - 1, RETRY_MS.length - 1)] ?? 1_000;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.ensure();
    }, wait);
    this.retry.unref();
  }

  private dispatch(payload: string) {
    for (const fn of this.subs.get(payload) ?? []) {
      try {
        fn();
      } catch {
        // A closed stream's callback; it unsubscribes itself.
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }
}
