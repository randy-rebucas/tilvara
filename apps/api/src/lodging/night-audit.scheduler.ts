import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { sql, withTenant } from '@1pos/database';
import { readOnlyReason } from '../billing/entitlements.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { ENV } from '../infrastructure/env.provider.js';
import { ApiMetrics } from '../infrastructure/metrics.js';
import { TaxService } from '../tax/tax.service.js';
import { inHouseStays, postDueNights } from './night-audit.js';

const sqlTenantStatus = sql`SELECT status FROM tenants`;

/** Session-level advisory lock key: one API instance runs the night audit at a time. */
export const NIGHT_AUDIT_LOCK = 230_023_007;

/**
 * The night audit (ADR-0023 §7): every `NIGHT_AUDIT_INTERVAL_MS` (0 = off), one API instance (advisory
 * lock) asks `platform_lodging_due_tenants()` which businesses have nights due, then, inside each
 * business, posts each in-house stay's due nights in its own transaction (audit actor SYSTEM). A
 * read-only business is skipped; its nights stay due and are posted, exactly, once it can write again.
 */
@Injectable()
export class NightAuditScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('NightAudit');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(DatabasePool) private readonly database: DatabasePool,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
  ) {}

  onApplicationBootstrap() {
    if (this.env.NIGHT_AUDIT_INTERVAL_MS <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.env.NIGHT_AUDIT_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  private tick() {
    if (this.running) return this.running;
    this.running = this.runOnce().catch((e: Error) => {
      this.metrics.nightAudit.inc({ outcome: 'failed' });
      this.logger.warn({ msg: 'night audit failed', message: e.message.slice(0, 200) });
    }).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** One pass over every business with nights due. Returns the nights posted per tenant (tests call it directly). */
  async runOnce(): Promise<{ tenantId: string; nights: number; overstays: number; failed: number; skipped?: string }[]> {
    const client = await this.database.pool.connect();
    try {
      const { rows: [lock] } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [NIGHT_AUDIT_LOCK]);
      if (!lock?.ok) return [];
      try {
        const { rows } = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM platform_lodging_due_tenants()');
        const out: { tenantId: string; nights: number; overstays: number; failed: number; skipped?: string }[] = [];
        for (const { tenant_id: tenantId } of rows) {
          const r = await this.runTenant(tenantId);
          // Counts only, outcome from a fixed set (no tenant or stay ids as labels).
          if (r.skipped) this.metrics.nightAudit.inc({ outcome: 'skipped' });
          if (r.nights) this.metrics.nightAudit.inc({ outcome: 'posted' }, r.nights);
          if (r.failed) this.metrics.nightAudit.inc({ outcome: 'failed' }, r.failed);
          out.push(r);
        }
        return out;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [NIGHT_AUDIT_LOCK]);
      }
    } finally {
      client.release();
    }
  }

  private async runTenant(tenantId: string): Promise<{ tenantId: string; nights: number; overstays: number; failed: number; skipped?: string }> {
    const pool = this.database.pool;
    const { stays, readOnly } = await withTenant(pool, tenantId, async (db) => {
      const { rows } = await db.execute<{ status: string }>(sqlTenantStatus);
      const reason = await readOnlyReason(db, rows[0]?.status ?? 'ACTIVE');
      return { stays: reason ? [] : await inHouseStays(db), readOnly: reason?.code ?? null };
    });
    if (readOnly) return { tenantId, nights: 0, overstays: 0, failed: 0, skipped: readOnly };
    let nights = 0;
    let failed = 0;
    for (const s of stays) {
      try {
        nights += (await withTenant(pool, tenantId, (db) => postDueNights(db, this.tax, s.id, {
          tenantId, userId: null, through: 'DUE', production: this.env.NODE_ENV === 'production',
        }))).length;
      } catch (e) {
        // Ids only (logging rules): the stay stays due and is tried again on the next pass.
        failed += 1;
        this.logger.warn({ msg: 'night audit could not post a stay', tenantId, stayId: s.id, message: (e as Error).message.slice(0, 200) });
      }
    }
    // Overstays: in house past the departure date; no night past it is charged until check-out extends the stay.
    return { tenantId, nights, overstays: stays.filter((s) => s.overstay).length, failed };
  }
}
