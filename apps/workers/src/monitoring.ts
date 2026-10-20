import { MetricsRegistry, registerProcessMetrics } from '@1pos/observability';
import type { Pool } from 'pg';
import type { RunResult } from './outbox-processor.js';

/** Heartbeats are written at most this often; the API counts a worker alive for 60 s after one. */
export const HEARTBEAT_EVERY_MS = 15_000;

/**
 * The worker's metrics (its own internal port) and its heartbeat row (ADR-0016 slice 3). The API
 * exports the heartbeat's age, so a worker that is down still raises an alert.
 */
export class WorkerMonitor {
  readonly registry = new MetricsRegistry();
  readonly events = this.registry.counter({
    name: 'onepos_worker_outbox_events_total',
    help: 'Outbox events processed by this worker, by outcome: done, retried, dead.',
    labelNames: ['outcome'],
  });
  readonly batches = this.registry.counter({ name: 'onepos_worker_batches_total', help: 'Non-empty batches claimed.' });
  /** Outbound webhooks (ADR-0019): delivered, retried later, or given up on (DEAD). */
  readonly webhooks = this.registry.counter({
    name: 'onepos_worker_webhook_deliveries_total',
    help: 'Webhook deliveries attempted by this worker, by outcome: delivered, retried, dead.',
    labelNames: ['outcome'],
  });
  readonly loopErrors = this.registry.counter({
    name: 'onepos_worker_loop_errors_total',
    help: 'Worker loop iterations that failed (database unreachable, claim failed…).',
  });
  readonly lastLoop = this.registry.gauge({
    name: 'onepos_worker_last_loop_timestamp_seconds',
    help: 'When the worker loop last completed an iteration, Unix seconds.',
  });
  readonly lastHeartbeat = this.registry.gauge({
    name: 'onepos_worker_last_heartbeat_timestamp_seconds',
    help: 'When this worker last wrote its heartbeat row, Unix seconds.',
  });
  readonly heartbeatFailures = this.registry.counter({
    name: 'onepos_worker_heartbeat_failures_total',
    help: 'Heartbeat writes that failed.',
  });
  private readonly pool = this.registry.gauge({
    name: 'onepos_worker_db_pool_connections',
    help: 'Worker pool connections: total, idle, and requests waiting for one.',
    labelNames: ['state'],
  });
  private beatAt = 0;
  private readonly startedAt = new Date();

  constructor(
    private readonly db: Pool,
    private readonly workerId: string,
    private readonly version: string,
  ) {
    registerProcessMetrics(this.registry);
    this.registry.onCollect(() => {
      this.pool.set({ state: 'total' }, db.totalCount);
      this.pool.set({ state: 'idle' }, db.idleCount);
      this.pool.set({ state: 'waiting' }, db.waitingCount);
    });
  }

  recordWebhooks(r: { delivered: number; retried: number; dead: number }): void {
    if (r.delivered) this.webhooks.inc({ outcome: 'delivered' }, r.delivered);
    if (r.retried) this.webhooks.inc({ outcome: 'retried' }, r.retried);
    if (r.dead) this.webhooks.inc({ outcome: 'dead' }, r.dead);
  }

  recordBatch(r: RunResult): void {
    if (r.claimed > 0) this.batches.inc();
    if (r.done) this.events.inc({ outcome: 'done' }, r.done);
    if (r.retried) this.events.inc({ outcome: 'retried' }, r.retried);
    if (r.dead) this.events.inc({ outcome: 'dead' }, r.dead);
    this.lastLoop.set(undefined, Date.now() / 1000);
  }

  /** Write the heartbeat row unless one was written in the last HEARTBEAT_EVERY_MS. Never throws. */
  async beat(now = Date.now()): Promise<boolean> {
    if (now - this.beatAt < HEARTBEAT_EVERY_MS) return false;
    try {
      await this.db.query('SELECT worker_heartbeat($1, $2, $3)', [this.workerId, this.startedAt, this.version]);
      this.beatAt = now;
      this.lastHeartbeat.set(undefined, now / 1000);
      return true;
    } catch {
      this.heartbeatFailures.inc();
      return false;
    }
  }

  /** A clean stop removes the row at once (no wait for the 60 s window). */
  async stop(): Promise<void> {
    try {
      await this.db.query('SELECT worker_heartbeat_stop($1)', [this.workerId]);
    } catch {
      // The row ages out; the alert then reflects that no worker is running.
    }
  }
}
