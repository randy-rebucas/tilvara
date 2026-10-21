import { appointmentReminderMail, eq, expiryAlertMail, stockAlertMail, stockKeepers, users, withTenant, writeDataExport, WEBHOOK_TOPICS, type FileStorage } from '@1pos/database';
import { maskEmail } from '@1pos/observability';
import type { Pool } from 'pg';
import type { Logger, OutboxHandler, OutboxHandlerFn } from './outbox-processor.js';

export interface WorkerMailer {
  send(message: { to: string; subject: string; text: string; template: string }): Promise<void>;
}

/** Dev mailer for workers: logs the template and a masked recipient only. Refused in production by @1pos/config. */
export class DevWorkerMailer implements WorkerMailer {
  readonly sent: { to: string; subject: string; text: string; template: string }[] = [];
  constructor(private readonly logger: Logger) {}
  async send(message: { to: string; subject: string; text: string; template: string }): Promise<void> {
    this.sent.push(message);
    this.logger.info('[dev mail]', { template: message.template, to: maskEmail(message.to) });
  }
}

export interface ExportOptions {
  storage: FileStorage;
  /** Days a finished export stays downloadable. */
  retentionDays: number;
  /** After this many tries the export is marked FAILED (the owner can ask again) instead of retried. */
  maxAttempts?: number;
}

export const exportKey = (tenantId: string, exportId: string) => `exports/${tenantId}/${exportId}.zip`;

export function buildHandlers(mailer: WorkerMailer, exports?: ExportOptions): Record<string, OutboxHandler> {
  return withWebhooks({
    /** Welcome email to the owner. RLS guarantees we can only read users of this event's tenant. */
    'tenant.onboarded': async (event, db) => {
      const ownerUserId = String(event.payload.ownerUserId ?? '');
      const [owner] = await db.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, ownerUserId));
      if (!owner) throw new Error(`owner ${ownerUserId} not visible in tenant ${event.tenantId}`);
      await mailer.send({
        to: owner.email,
        template: 'tenant.welcome',
        subject: 'Welcome to Tilvara',
        text: `Hi ${owner.displayName}, your business is ready. Your 14-day trial has started.`,
      });
    },
    'stock.low': stockAlertHandler(mailer, 'low'),
    'stock.below_zero': stockAlertHandler(mailer, 'below_zero'),
    // Lots that came within the branch's expiry window (ADR-0020 §3), flagged by the hourly pass.
    'stock.expiring': async (event, _db, { client }) => {
      const mail = await expiryAlertMail(client, event.payload);
      if (!mail) return; // written off or sold since: nothing left to say
      for (const k of await stockKeepers(client, String(event.payload.branchId ?? ''))) {
        await mailer.send({ to: k.email, template: 'stock.expiring', ...mail });
      }
    },
    // A day-before reminder to the customer (ADR-0022 §10), flagged by the hourly pass. Ids only in the event.
    'appointment.reminder': async (event, _db, { client }) => {
      const mail = await appointmentReminderMail(client, event.payload);
      if (!mail) return; // cancelled, moved, turned off or no address since: nothing to send
      await mailer.send({ ...mail, template: 'appointment.reminder' });
    },
    ...(exports ? { 'data_export.requested': dataExportHandler(exports) } : {}),
  });
}

/**
 * Every event a webhook may listen for is also fanned out to the business's endpoints (ADR-0019), in
 * the handler's transaction: the delivery rows commit with the event's completion, once per endpoint.
 */
export function withWebhooks(handlers: Record<string, OutboxHandler>): Record<string, OutboxHandler> {
  const out = { ...handlers };
  for (const topic of WEBHOOK_TOPICS) {
    const inner = handlers[topic];
    const run = inner ? (typeof inner === 'function' ? inner : inner.run) : null;
    const fanOut: OutboxHandlerFn = async (event, db, ctx) => {
      if (run) await run(event, db, ctx);
      await ctx.client.query('SELECT webhook_enqueue($1)', [event.id]);
    };
    out[topic] = inner && typeof inner !== 'function' ? { isolation: inner.isolation, run: fanOut } : fanOut;
  }
  return out;
}

/**
 * Stock alerts written by the costing trigger (session 16): an item fell to its reorder point, or
 * below zero under a FLAG/BLOCK policy. One mail per keeper per crossing; the numbers are the
 * balance right after the movement that crossed (the item may have moved again since).
 */
function stockAlertHandler(mailer: WorkerMailer, kind: 'low' | 'below_zero'): OutboxHandler {
  return async (event, _db, { client }) => {
    const mail = await stockAlertMail(client, `stock.${kind}`, event.payload);
    if (!mail) throw new Error(`stock alert for an unknown branch or item (event ${event.id})`);
    for (const k of await stockKeepers(client, String(event.payload.branchId ?? ''))) {
      await mailer.send({ to: k.email, template: `stock.${kind}`, ...mail });
    }
  };
}

/**
 * A business's data export (ADR-0016 slice 6): one REPEATABLE READ snapshot inside the event's
 * tenant, written as a ZIP into private storage, then marked READY by data_export_finish() in the
 * same transaction. Idempotent: an export that is no longer REQUESTED is left alone, and a retry
 * rewrites the same file (it only appears once complete).
 */
function dataExportHandler(o: ExportOptions): OutboxHandler {
  const maxAttempts = o.maxAttempts ?? 3;
  return {
    isolation: 'REPEATABLE READ',
    run: async (event, _db, { client, pool }) => {
      const exportId = String(event.payload.exportId ?? '');
      const { rows: [row] } = await client.query<{ status: string; requested_by_name: string | null }>(
        `SELECT e.status, u.display_name AS requested_by_name FROM data_exports e LEFT JOIN users u ON u.id = e.requested_by WHERE e.id = $1`,
        [exportId],
      );
      if (!row || row.status !== 'REQUESTED') return;
      try {
        let rowCounts: Record<string, number> = {};
        const key = exportKey(event.tenantId, exportId);
        const file = await o.storage.put(key, async (out) => {
          rowCounts = (await writeDataExport(client, out, { exportId, requestedBy: row.requested_by_name })).rowCounts;
        });
        await client.query(`SELECT data_export_finish($1, $2, $3, $4, $5, now() + make_interval(days => $6))`, [
          exportId,
          key,
          file.sizeBytes,
          file.sha256,
          JSON.stringify(rowCounts),
          o.retentionDays,
        ]);
      } catch (e) {
        if (event.attempts < maxAttempts) throw e;
        // Out of tries: say so to the business (this transaction may be aborted, so use a new one).
        const message = e instanceof Error ? e.message.split('\nparams:')[0]!.slice(0, 300) : 'unknown error';
        await withTenant(pool, event.tenantId, async (_d, c) => {
          await c.query('SELECT data_export_fail($1, $2)', [exportId, message]);
        });
      }
    },
  };
}

/**
 * Delete export files past their date, then mark them EXPIRED (file first: a failed delete leaves
 * the row READY, so the next sweep tries again; the API already refuses links once the date passed).
 */
export async function expireDataExports(pool: Pool, storage: FileStorage, logger: Logger): Promise<number> {
  const { rows } = await pool.query<{ tenant_id: string; id: string; file_key: string | null }>('SELECT * FROM data_export_due_expiry(200)');
  let n = 0;
  for (const r of rows) {
    try {
      if (r.file_key) await storage.remove(r.file_key);
      const { rows: [m] } = await pool.query<{ ok: boolean }>('SELECT data_export_mark_expired($1, $2) AS ok', [r.tenant_id, r.id]);
      if (m?.ok) n++;
    } catch (e) {
      logger.error('could not expire a data export', { exportId: r.id, error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    }
  }
  return n;
}
