import { withTenant, type Database, type IsolationLevel } from '@1pos/database';
import { withLogContext } from '@1pos/observability';
import type { Pool, PoolClient } from 'pg';

export interface OutboxEvent {
  id: string;
  tenantId: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  correlationId: string | null;
}

/**
 * Handlers run inside `withTenant(event.tenantId)`: the tenant scope comes from the trusted
 * event row, never from the payload. Delivery is at-least-once, so handlers must be idempotent.
 */
export type OutboxHandlerFn = (event: OutboxEvent, db: Database, ctx: { client: PoolClient; pool: Pool }) => Promise<void>;
/** A plain function, or one that needs a stricter transaction (e.g. a data export reads one snapshot). */
export type OutboxHandler = OutboxHandlerFn | { isolation: IsolationLevel; run: OutboxHandlerFn };

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface OutboxProcessorOptions {
  pool: Pool;
  workerId: string;
  handlers: Record<string, OutboxHandler>;
  batchSize?: number;
  leaseSeconds?: number;
  logger?: Logger;
  /** Override for tests. Default: 5s · 2^(attempt-1), capped at 1h, ±20% jitter. */
  retryDelaySeconds?: (attempt: number) => number;
}

export interface RunResult {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}

export function defaultRetryDelay(attempt: number): number {
  const base = Math.min(3600, 5 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

const silent: Logger = { info: () => undefined, error: () => undefined };

export class OutboxProcessor {
  private readonly o: Required<Omit<OutboxProcessorOptions, 'logger' | 'retryDelaySeconds'>> & {
    logger: Logger;
    retryDelaySeconds: (attempt: number) => number;
  };

  constructor(options: OutboxProcessorOptions) {
    this.o = {
      batchSize: 50,
      leaseSeconds: 60,
      logger: silent,
      retryDelaySeconds: defaultRetryDelay,
      ...options,
    };
  }

  /** Claim one batch and process it. Returns counts for monitoring. */
  async runOnce(): Promise<RunResult> {
    const { rows } = await this.o.pool.query<{
      id: string;
      tenant_id: string;
      topic: string;
      payload: Record<string, unknown>;
      attempts: number;
      correlation_id: string | null;
    }>('SELECT * FROM outbox_claim($1, $2, $3)', [this.o.workerId, this.o.batchSize, this.o.leaseSeconds]);
    const result: RunResult = { claimed: rows.length, done: 0, retried: 0, dead: 0 };

    for (const r of rows) {
      const event: OutboxEvent = {
        id: r.id,
        tenantId: r.tenant_id,
        topic: r.topic,
        payload: r.payload,
        attempts: r.attempts,
        correlationId: r.correlation_id,
      };
      // Log lines from the handler and from this loop carry the originating request's ids.
      await withLogContext(
        { correlationId: event.correlationId ?? undefined, tenantId: event.tenantId, eventId: event.id },
        () => this.process(event, result),
      );
    }
    return result;
  }

  /** Renew this worker's lease on the event; false when another worker has taken it over. */
  private async extend(event: OutboxEvent): Promise<boolean> {
    const { rows } = await this.o.pool.query<{ ok: boolean }>('SELECT outbox_extend($1, $2, $3) AS ok', [event.id, this.o.workerId, this.o.leaseSeconds]);
    return rows[0]?.ok === true;
  }

  private async process(event: OutboxEvent, result: RunResult): Promise<void> {
    const handler = this.o.handlers[event.topic];
    // The batch was claimed at once, so a slow event earlier in it may have let this one's lease run
    // out and another worker claim it: renew first, and leave it alone if that worker holds it now.
    if (!(await this.extend(event))) {
      this.o.logger.info('outbox lease lost before start; another worker has the event', { eventId: event.id, topic: event.topic });
      return;
    }
    // While the handler runs, keep renewing (every third of the lease), so a long one (a large data
    // export) is not claimed and run a second time by another worker.
    const renew = setInterval(() => {
      this.extend(event).catch((e: unknown) => this.o.logger.error('outbox lease renewal failed', { eventId: event.id, error: (e as Error).name }));
    }, Math.max(1000, (this.o.leaseSeconds * 1000) / 3));
    try {
      if (handler) {
        const run = typeof handler === 'function' ? handler : handler.run;
        await withTenant(this.o.pool, event.tenantId, (db, client) => run(event, db, { client, pool: this.o.pool }), {
          correlationId: event.correlationId ?? undefined,
          ...(typeof handler === 'function' ? {} : { isolation: handler.isolation }),
        });
      }
      clearInterval(renew);
      // Events without a consumer yet are acknowledged; they stay in the table for future replay.
      const ok = await this.o.pool.query<{ ok: boolean }>('SELECT outbox_complete($1, $2) AS ok', [event.id, this.o.workerId]);
      if (ok.rows[0]?.ok) result.done++;
      else this.o.logger.error('outbox lease lost before completion', { eventId: event.id, topic: event.topic });
    } catch (err) {
      clearInterval(renew);
      const message = err instanceof Error ? `${err.name}: ${err.message.split('\nparams:')[0]}` : 'unknown error';
      const { rows: f } = await this.o.pool.query<{ status: string | null }>('SELECT outbox_fail($1, $2, $3, $4) AS status', [
        event.id,
        this.o.workerId,
        message,
        this.o.retryDelaySeconds(event.attempts),
      ]);
      if (f[0]?.status === 'DEAD') {
        result.dead++;
        this.o.logger.error('outbox event dead-lettered', { eventId: event.id, topic: event.topic, attempts: event.attempts });
      } else {
        result.retried++;
        this.o.logger.info('outbox event will retry', { eventId: event.id, topic: event.topic, attempts: event.attempts });
      }
    }
  }
}
