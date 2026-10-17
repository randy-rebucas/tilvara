import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { expectedMigrationHead, type MigrationHead } from '@1pos/database';
import { startMetricsServer, type MetricsServer } from '@1pos/observability';
import { DatabasePool } from './database.provider.js';
import { ENV } from './env.provider.js';
import { ApiMetrics, BUSINESS_GAUGES, type BusinessGauge } from './metrics.js';
import { RateLimitStore } from './rate-limit.store.js';

/** Business gauges are queried at most this often, however often (or by how many) the port is scraped. */
const GAUGE_TTL_MS = 10_000;
const GAUGE_QUERY_TIMEOUT_MS = 3_000;
// pg honours a per-query (client-side) query_timeout; @types/pg declares it only on the pool config.
const timed = (text: string) => ({ text, query_timeout: GAUGE_QUERY_TIMEOUT_MS }) as { text: string };

export type SchemaState = 'up' | 'behind' | 'unknown';

/**
 * Fills the API's gauges on scrape (pool sizes, Redis, business gauges from `platform_metrics()`),
 * checks the migration head for readiness, and serves the internal metrics port (ADR-0016 slice 3).
 */
@Injectable()
export class MonitoringService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Monitoring');
  private readonly expected: MigrationHead = expectedMigrationHead();
  private schemaAtHead = false;
  private gaugesAt = 0;
  private gaugesInFlight: Promise<void> | null = null;
  private server: MetricsServer | null = null;

  constructor(
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
    @Inject(DatabasePool) private readonly db: DatabasePool,
    @Inject(RateLimitStore) private readonly rateLimits: RateLimitStore,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    const m = this.metrics;
    m.registry.onCollect(() => {
      const p = this.db.pool;
      m.dbPool.set({ state: 'total' }, p.totalCount);
      m.dbPool.set({ state: 'idle' }, p.idleCount);
      m.dbPool.set({ state: 'waiting' }, p.waitingCount);
    });
    m.registry.onCollect(async () => {
      if (this.rateLimits.backend === 'redis') m.redisUp.set(undefined, (await this.rateLimits.ping()) ? 1 : 0);
    });
    m.registry.onCollect(() => this.refreshGauges());
    m.registry.onCollect(async () => {
      await this.schemaState();
    });
  }

  /**
   * `up` when the database has every migration this build expects (a newer schema is fine:
   * expand-then-contract deploys); `behind` otherwise. Once up it stays up for this process.
   */
  async schemaState(): Promise<SchemaState> {
    if (this.schemaAtHead) return 'up';
    try {
      const { rows } = await this.db.pool.query<{ applied: number; last_created_at: string | null }>(
        timed('SELECT applied, last_created_at FROM platform_migration_head()'),
      );
      const last = Number(rows[0]?.last_created_at ?? 0);
      this.schemaAtHead = last >= this.expected.lastWhen;
      this.metrics.migrationsBehind.set(undefined, this.schemaAtHead ? 0 : Math.max(1, this.expected.count - Number(rows[0]?.applied ?? 0)));
      return this.schemaAtHead ? 'up' : 'behind';
    } catch (e) {
      // 42883: platform_migration_head() itself is missing, i.e. the schema predates this build.
      if ((e as { code?: string }).code === '42883') {
        this.metrics.migrationsBehind.set(undefined, 1);
        return 'behind';
      }
      return 'unknown';
    }
  }

  private refreshGauges(): Promise<void> {
    if (Date.now() - this.gaugesAt < GAUGE_TTL_MS) return Promise.resolve();
    // Concurrent scrapes share one query.
    this.gaugesInFlight ??= this.queryGauges().finally(() => {
      this.gaugesInFlight = null;
    });
    return this.gaugesInFlight;
  }

  private async queryGauges(): Promise<void> {
    const m = this.metrics;
    const started = process.hrtime.bigint();
    try {
      const { rows } = await this.db.pool.query<{ metric: string; label: string; value: number }>(
        timed('SELECT metric, label, value FROM platform_metrics()'),
      );
      for (const r of rows) {
        const def = BUSINESS_GAUGES[r.metric as BusinessGauge];
        if (!def) continue;
        m.business[r.metric as BusinessGauge].set('label' in def ? { [def.label]: r.label } : undefined, Number(r.value));
      }
      m.dbUp.set(undefined, 1);
      this.gaugesAt = Date.now();
    } catch (e) {
      // Stale business values stay as they were; onepos_db_up says they are stale.
      m.dbUp.set(undefined, 0);
      this.logger.warn({ msg: 'business gauges unavailable', code: (e as { code?: string }).code, message: (e as Error).message?.slice(0, 200) });
    } finally {
      m.gaugeScrape.set(undefined, Number(process.hrtime.bigint() - started) / 1e9);
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.API_METRICS_PORT === 0) return;
    this.server = await startMetricsServer({ registry: this.metrics.registry, port: this.env.API_METRICS_PORT, host: this.env.METRICS_HOST });
    this.logger.log({ msg: 'metrics listening', host: this.env.METRICS_HOST, port: this.server.port });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server?.close();
  }
}
