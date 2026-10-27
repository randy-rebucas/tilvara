import { loadWorkerEnv } from '@1pos/config';
import { createLogger, startMetricsServer, type MetricsServer } from '@1pos/observability';
import { hostname } from 'node:os';
import { DevFileStorage } from '@1pos/database';
import pg from 'pg';
import { checkoutExpirerFor } from './billing-checkouts.js';
import { buildHandlers, DevWorkerMailer } from './handlers.js';
import { runHourly } from './hourly.js';
import { WorkerMonitor } from './monitoring.js';
import { OutboxProcessor, type Logger } from './outbox-processor.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const log = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const logger: Logger = {
    info: (msg, meta) => log.info(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
  const workerId = env.WORKER_ID ?? `${hostname()}:${process.pid}`;
  const pool = new pg.Pool({ connectionString: env.WORKER_DATABASE_URL ?? env.DATABASE_URL, max: 5 });
  // Idle connections dropped by the server (DB restart) surface here; unhandled, they would exit the worker.
  pool.on('error', (err) => logger.error('idle database connection lost', { error: err.message.slice(0, 200) }));
  // Only the dev adapter exists until D1 (production refuses FILE_STORAGE_DRIVER=dev at boot).
  const storage = new DevFileStorage(env.FILE_STORAGE_DIR);
  const monitor = new WorkerMonitor(pool, workerId, process.env.ONEPOS_VERSION ?? 'dev');
  const processor = new OutboxProcessor({
    pool,
    workerId,
    handlers: buildHandlers(new DevWorkerMailer(logger), { storage, retentionDays: env.DATA_EXPORT_RETENTION_DAYS }, { checkouts: checkoutExpirerFor(env), logger }),
    batchSize: env.OUTBOX_BATCH,
    leaseSeconds: env.OUTBOX_LEASE_SECONDS,
    logger,
  });
  const webhooks = new WebhookDispatcher({
    pool, workerId, signingKey: env.WEBHOOK_SIGNING_KEY, allowInsecure: env.WEBHOOK_ALLOW_INSECURE, timeoutMs: env.WEBHOOK_TIMEOUT_MS, logger,
  });
  let metrics: MetricsServer | null = null;
  if (env.WORKER_METRICS_PORT !== 0) {
    metrics = await startMetricsServer({ registry: monitor.registry, port: env.WORKER_METRICS_PORT, host: env.METRICS_HOST, token: env.METRICS_TOKEN });
    logger.info('metrics listening', { host: env.METRICS_HOST, port: metrics.port });
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  logger.info('worker started', { workerId });

  let lastPurge = 0;
  while (!stopping) {
    try {
      await monitor.beat();
      const r = await processor.runOnce();
      monitor.recordBatch(r);
      if (r.claimed > 0) logger.info('outbox batch', { ...r });
      const w = await webhooks.runOnce();
      monitor.recordWebhooks(w);
      if (w.claimed > 0) logger.info('webhook batch', { ...w });
      if (Date.now() - lastPurge > 3_600_000) {
        // Each step on its own: one failing never stops the others (audit 45 #5); counted and alerted.
        lastPurge = Date.now();
        await runHourly(pool, storage, monitor, logger);
      }
      if (r.claimed === 0 && w.claimed === 0) await new Promise((res) => setTimeout(res, env.OUTBOX_POLL_MS));
    } catch (err) {
      monitor.loopErrors.inc();
      logger.error('worker loop error', { error: err instanceof Error ? err.message.split('\nparams:')[0] : 'unknown' });
      await new Promise((res) => setTimeout(res, env.OUTBOX_POLL_MS * 5));
    }
  }
  // In-flight events keep their lease; another worker reclaims them after expiry if needed.
  await monitor.stop();
  await metrics?.close();
  await pool.end();
  logger.info('worker stopped', { workerId });
}

void main();
