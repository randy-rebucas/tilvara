import { loadWorkerEnv } from '@1pos/config';
import { hostname } from 'node:os';
import pg from 'pg';
import { buildHandlers, DevWorkerMailer } from './handlers.js';
import { OutboxProcessor, type Logger } from './outbox-processor.js';

const logger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta, at: new Date().toISOString() })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...meta, at: new Date().toISOString() })),
};

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const workerId = env.WORKER_ID ?? `${hostname()}:${process.pid}`;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
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
