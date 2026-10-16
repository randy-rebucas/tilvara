import { loadWorkerEnv } from '@1pos/config';
import { createLogger } from '@1pos/observability';
import { hostname } from 'node:os';
import pg from 'pg';
import { buildHandlers, DevWorkerMailer } from './handlers.js';
import { OutboxProcessor, type Logger } from './outbox-processor.js';

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const log = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const logger: Logger = {
    info: (msg, meta) => log.info(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
  const workerId = env.WORKER_ID ?? `${hostname()}:${process.pid}`;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
  // Idle connections dropped by the server (DB restart) surface here; unhandled, they would exit the worker.
  pool.on('error', (err) => logger.error('idle database connection lost', { error: err.message.slice(0, 200) }));
  const processor = new OutboxProcessor({
    pool,
    workerId,
    handlers: buildHandlers(new DevWorkerMailer(logger)),
    batchSize: env.OUTBOX_BATCH,
    leaseSeconds: env.OUTBOX_LEASE_SECONDS,
    logger,
  });

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
      const r = await processor.runOnce();
      if (r.claimed > 0) logger.info('outbox batch', { ...r });
      if (Date.now() - lastPurge > 3_600_000) {
        const { rows } = await pool.query<{ n: number }>('SELECT platform_purge_expired_idempotency() AS n');
        lastPurge = Date.now();
        if (rows[0]?.n) logger.info('purged idempotency records', { count: rows[0].n });
      }
      if (r.claimed === 0) await new Promise((res) => setTimeout(res, env.OUTBOX_POLL_MS));
    } catch (err) {
      logger.error('worker loop error', { error: err instanceof Error ? err.message.split('\nparams:')[0] : 'unknown' });
      await new Promise((res) => setTimeout(res, env.OUTBOX_POLL_MS * 5));
    }
  }
  // In-flight events keep their lease; another worker reclaims them after expiry if needed.
  await pool.end();
  logger.info('worker stopped', { workerId });
}

void main();
