import type { FileStorage } from '@1pos/database';
import type { Pool } from 'pg';
import { expireDataExports } from './handlers.js';
import type { HourlyStep, WorkerMonitor } from './monitoring.js';
import type { Logger } from './outbox-processor.js';

/**
 * The worker's hourly pass (audit 45 #5). Each step runs on its own: one that throws is logged and counted
 * (`onepos_worker_hourly_errors_total{step}`) and the others still run. The billing pass runs each business on its
 * own savepoint and returns how many it had to skip (`errors`, counted as `billing_business`); the time of its last
 * completed run is the gauge the OneposWorkerHourlyPassFailing alert watches.
 */
export async function runHourly(pool: Pool, storage: FileStorage, monitor: WorkerMonitor, logger: Logger, now = () => Date.now()): Promise<void> {
  const step = async (name: HourlyStep, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      monitor.hourlyFailed(name);
      logger.error('hourly step failed', { step: name, error: err instanceof Error ? err.message.split('\nparams:')[0]!.slice(0, 300) : 'unknown' });
    }
  };
  await step('purge_idempotency', async () => {
    const { rows } = await pool.query<{ n: number }>('SELECT platform_purge_expired_idempotency() AS n');
    if (rows[0]?.n) logger.info('purged idempotency records', { count: rows[0].n });
  });
  // Lots entering their branch's expiry window: one stock.expiring event per branch (ADR-0020 §3).
  await step('flag_expiring_lots', async () => {
    const { rows } = await pool.query<{ n: number }>('SELECT platform_flag_expiring_lots() AS n');
    if (rows[0]?.n) logger.info('flagged expiring lots', { count: rows[0].n });
  });
  // Subscription billing (ADR-0027): renewal and first bills, past due / canceled at the paid-until date.
  await step('billing_tick', async () => {
    const { rows: [billing] } = await pool.query<{ r: Record<string, number> }>('SELECT platform_billing_tick() AS r');
    const r = billing?.r ?? {};
    // Skipped: another worker is running the pass right now, which is as good as running it.
    monitor.lastBillingTick.set(undefined, now() / 1000);
    if (r.errors) {
      monitor.hourlyFailed('billing_business', r.errors);
      logger.error('billing pass skipped businesses (see the database log WARNINGs)', { count: r.errors });
    }
    if (Object.values(r).some((n) => n > 0)) logger.info('billing pass', r);
  });
  await step('expire_data_exports', async () => {
    const expired = await expireDataExports(pool, storage, logger);
    if (expired) logger.info('expired data exports', { count: expired });
  });
}
