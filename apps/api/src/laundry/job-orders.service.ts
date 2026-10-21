import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  jobOrderLines,
  jobOrderNotices,
  jobOrders,
  jobOrderTrips,
  sql,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type {
  CancelJobOrderInput,
  CreateJobOrderInput,
  DisposeJobOrderInput,
  JobOrderItemsInput,
  JobOrderLinesInput,
  JobOrderListQuery,
  JobOrderLookupQuery,
  JobOrderStatusInput,
  UpdateJobOrderInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertLaundry } from '../billing/entitlements.js';
import { nextNumber } from '../common/sequence.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { activeCustomer } from '../customers/customers.service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { TaxService, unprocessable } from '../tax/tax.service.js';
import { DEPOSIT_CONFLICTS, JobDepositsService } from './deposits.service.js';
import {
  assertEditable,
  branchLaundrySettings,
  depositsHeld,
  insertItems,
  isOpen,
  jobEnded,
  jobNumber,
  jobScope,
  jobView,
  liveTrip,
  loadJob,
  lockJobDeposits,
  newClaimCode,
  priceJob,
  recordStatus,
  storeLines,
  type JobRow,
} from './job.js';

const STEPS = ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY'] as const;
const peso = (v: string) => `₱${toDec(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/**
 * Laundry job orders (ADR-0024 §3, §4, §6, §9): taken in with their lines priced and frozen, items and
 * condition counted, a claim code for the stub; moved through washing, drying and folding to READY
 * (which queues the "ready for pickup" notice); cancelled, or disposed of when unclaimed. The claim
 * itself is a sale (`SalesService.createFromJobOrder`).
 */
@Injectable()
export class JobOrdersService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    ...DEPOSIT_CONFLICTS,
    job_orders_claim_code_unique: ['CLAIM_CODE_TAKEN', 'Try again'],
    job_order_trips_live_once: ['TRIP_EXISTS', 'This job order already has one scheduled'],
    job_orders_status_move: ['INVALID_STATUS_MOVE', 'A job order cannot move that way'],
    job_orders_status_final: ['JOB_ORDER_ENDED', 'This job order has ended'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(JobDepositsService) private readonly deposits: JobDepositsService,
  ) {
    super(tenantDb);
  }

  create(auth: AuthContext, input: CreateJobOrderInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'laundry.manage', scope);
      await assertLaundry(db);
      if (branch.archivedAt) throw new AppError('ARCHIVED', 'Branch is archived', HttpStatus.CONFLICT);
      const tenantId = tenantOf(auth).tenantId;
      const customer = input.customerId ? await activeCustomer(db, input.customerId) : null;
      const settings = await branchLaundrySettings(db, branch.id);
      const hours = input.serviceLevel === 'EXPRESS' ? settings.expressHours : settings.regularHours;
      const number = await nextNumber(db, tenantId, branch.id, 'JOB_ORDER');
      const [job] = await db
        .insert(jobOrders)
        .values({
          tenantId, legalEntityId: branch.legalEntityId, branchId: branch.id, number, claimCode: await newClaimCode(db),
          customerId: customer?.id ?? null, customerName: input.customerName ?? null, customerPhone: input.customerPhone ?? null,
          serviceLevel: input.serviceLevel, promisedAt: input.promisedAt ? new Date(input.promisedAt) : sql`now() + make_interval(hours => ${hours})`,
          weightKg: input.weightKg ?? null, bagCount: input.bagCount, specialInstructions: input.specialInstructions ?? null,
          conditionNotes: input.conditionNotes ?? null, pickupRequested: input.pickup !== undefined, deliveryRequested: input.delivery !== undefined,
          notify: input.notify, receivedBy: auth.userId, updatedBy: auth.userId,
        })
        .returning();
      await recordStatus(db, job!, null, 'RECEIVED', auth.userId);
      const priced = await priceJob(this.tax, db, auth, job!, input.lines, settings);
      const stored = await storeLines(db, job!, priced, auth.userId);
      await insertItems(db, stored, input.items);
      for (const [kind, trip] of [['PICKUP', input.pickup], ['DELIVERY', input.delivery]] as const) {
        if (!trip) continue;
        await this.insertTrip(db, auth, stored, kind, trip);
      }
      await this.audit(db, auth, 'job_order.created', 'job_order', stored.id, {
        reference: jobNumber(number), branchId: branch.id, lines: input.lines.length, amountDue: toDec(stored.amountDue).toFixed(2), serviceLevel: input.serviceLevel,
        ...(input.pickup && { pickup: true }), ...(input.delivery && { delivery: true }),
      });
      return jobView(db, stored);
    });
  }

  list(auth: AuthContext, q: JobOrderListQuery) {
    return this.read(auth, async (db) => {
      if (q.branchId) this.assertCan(auth, 'laundry.read', (await branchScope(db, q.branchId)).scope);
      else this.assertHolds(auth, 'laundry.read');
      const term = q.q?.toUpperCase();
      const num = term && /^J?-?0*(\d{1,9})$/.exec(term)?.[1];
      const rows = await db
        .select()
        .from(jobOrders)
        .where(
          and(
            q.branchId ? eq(jobOrders.branchId, q.branchId) : undefined,
            q.status ? eq(jobOrders.status, q.status) : undefined,
            q.open ? inArray(jobOrders.status, ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY', 'OUT_FOR_DELIVERY']) : undefined,
            q.overdue ? sql`${jobOrders.promisedAt} < now() AND ${jobOrders.status} IN ('RECEIVED','WASHING','DRYING','FOLDING')` : undefined,
            q.unclaimed
              ? sql`${jobOrders.status} = 'READY' AND ${jobOrders.readyAt} + make_interval(days => coalesce((SELECT s.unclaimed_days FROM laundry_settings s WHERE s.branch_id = ${jobOrders.branchId}), 30)) <= now()`
              : undefined,
            q.customerId ? eq(jobOrders.customerId, q.customerId) : undefined,
            term
              ? sql`(${jobOrders.claimCode} = ${term} ${num ? sql`OR ${jobOrders.number} = ${Number(num)}` : sql``}
                    OR ${jobOrders.customerName} ILIKE ${`%${q.q}%`} OR ${jobOrders.customerPhone} ILIKE ${`%${q.q}%`}
                    OR ${jobOrders.customerId} IN (SELECT id FROM customers WHERE display_name ILIKE ${`%${q.q}%`} OR phone ILIKE ${`%${q.q}%`}))`
              : undefined,
            q.cursor ? sql`${jobOrders.id} < ${q.cursor}` : undefined,
          ),
        )
        .orderBy(desc(jobOrders.id))
        .limit(q.limit + 1);
      const page = [];
      for (const j of rows) {
        if (page.length === q.limit) break;
        if (q.branchId || this.can(auth, 'laundry.read', jobScope(j))) page.push(j);
      }
      const ids = page.map((j) => j.id);
      const { rows: held } = ids.length
        ? await db.execute<{ id: string; v: string }>(sql`SELECT job_order_id AS id, sum(amount)::text AS v FROM job_order_deposits WHERE job_order_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) GROUP BY 1`)
        : { rows: [] };
      const { rows: names } = ids.length
        ? await db.execute<{ id: string; name: string }>(sql`SELECT j.id, c.display_name AS name FROM job_orders j JOIN customers c ON c.id = j.customer_id WHERE j.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
        : { rows: [] };
      const { rows: [now] } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
      return {
        data: page.map((j) => {
          const h = toDec(held.find((x) => x.id === j.id)?.v ?? '0');
          return {
            ...j,
            reference: jobNumber(j.number),
            customerDisplayName: names.find((n) => n.id === j.id)?.name ?? j.customerName,
            weightKg: j.weightKg === null ? null : toDec(j.weightKg).toString(),
            amountDue: toDec(j.amountDue).toFixed(2),
            depositHeld: h.toFixed(2),
            balance: Dec.max(toDec(j.amountDue).minus(h), 0).toFixed(2),
            overdue: j.promisedAt.getTime() < new Date(now!.now).getTime() && ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING'].includes(j.status),
          };
        }),
        nextCursor: rows.length > page.length && page.length > 0 ? page.at(-1)!.id : null,
      };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const job = await loadJob(db, id);
      this.assertCanRead(auth, job);
      return jobView(db, job);
    });
  }

  /** The claim screen's search: by the stub's code, or a branch's job number. */
  lookup(auth: AuthContext, q: JobOrderLookupQuery) {
    return this.read(auth, async (db) => {
      const [job] = await db
        .select()
        .from(jobOrders)
        .where(q.claimCode ? eq(jobOrders.claimCode, q.claimCode) : and(eq(jobOrders.branchId, q.branchId!), eq(jobOrders.number, q.number!)));
      if (!job) throw notFound('Job order');
      this.assertCanRead(auth, job);
      return jobView(db, job);
    });
  }

  update(auth: AuthContext, id: string, input: UpdateJobOrderInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, id, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      assertEditable(job);
      if (input.customerId) await activeCustomer(db, input.customerId);
      const customerId = input.customerId !== undefined ? input.customerId : job.customerId;
      const customerName = input.customerName !== undefined ? input.customerName : job.customerName;
      if (!customerId && !customerName) throw unprocessable('VALIDATION_FAILED', 'A customer or a name', { path: ['customerName'] });
      const [row] = await db
        .update(jobOrders)
        .set({
          ...(input.customerId !== undefined && { customerId: input.customerId }),
          ...(input.customerName !== undefined && { customerName: input.customerName }),
          ...(input.customerPhone !== undefined && { customerPhone: input.customerPhone }),
          ...(input.promisedAt !== undefined && { promisedAt: new Date(input.promisedAt) }),
          ...(input.bagCount !== undefined && { bagCount: input.bagCount }),
          ...(input.specialInstructions !== undefined && { specialInstructions: input.specialInstructions }),
          ...(input.conditionNotes !== undefined && { conditionNotes: input.conditionNotes }),
          ...(input.notify !== undefined && { notify: input.notify }),
          updatedBy: auth.userId,
          updatedAt: sql`now()`,
        })
        .where(eq(jobOrders.id, id))
        .returning();
      // Field names only: names, phones and notes are personal data.
      await this.audit(db, auth, 'job_order.updated', 'job_order', id, { fields: Object.keys(input) });
      return jobView(db, row!);
    });
  }

  /** A re-weigh, or an add-on found while washing: the lines are priced again and frozen (audited). */
  replaceLines(auth: AuthContext, id: string, input: JobOrderLinesInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, id, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      assertEditable(job);
      const before = toDec(job.amountDue).toFixed(2);
      let current = job;
      if (input.weightKg !== undefined) {
        [current] = (await db.update(jobOrders).set({ weightKg: input.weightKg, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrders.id, id)).returning()) as [JobRow];
      }
      const priced = await priceJob(this.tax, db, auth, current, input.lines, await branchLaundrySettings(db, job.branchId));
      if (!priced) {
        // Nothing left to charge (only the automatic express/delivery lines named) would trap a down payment.
        await lockJobDeposits(db, job.id);
        const held = await depositsHeld(db, job.id);
        if (held.gt(0)) throw new AppError('DEPOSIT_HELD', 'A down payment is held on this job order; give it back or cancel the job order instead', HttpStatus.CONFLICT, { held: held.toFixed(2) });
      }
      const stored = await storeLines(db, current, priced, auth.userId);
      // A down payment never stays above the total: the claim gives back what is left over.
      await this.audit(db, auth, 'job_order.lines_changed', 'job_order', id, { from: before, to: toDec(stored.amountDue).toFixed(2), lines: input.lines.length });
      return jobView(db, stored);
    });
  }

  replaceItems(auth: AuthContext, id: string, input: JobOrderItemsInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, id, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      assertEditable(job);
      await insertItems(db, job, input.items);
      await this.audit(db, auth, 'job_order.items_changed', 'job_order', id, { items: input.items.length, pieces: input.items.reduce((a, i) => a + i.count, 0) });
      return jobView(db, job);
    });
  }

  /**
   * Move a job through the shop (§3): forward through washing, drying and folding (steps may be skipped),
   * or back from READY to FOLDING. READY queues the "ready for pickup" notice (§6), once per job.
   */
  setStatus(auth: AuthContext, id: string, input: JobOrderStatusInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, id, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      const from = STEPS.indexOf(job.status as (typeof STEPS)[number]);
      const to = STEPS.indexOf(input.status);
      if (from < 0) throw isOpen(job.status) ? new AppError('INVALID_STATUS_MOVE', `A job order ${job.status.toLowerCase().replace(/_/g, ' ')} does not go back to ${input.status.toLowerCase()}`, HttpStatus.CONFLICT) : jobEnded(job);
      if (to === from) return jobView(db, job);
      if (to < from && !(job.status === 'READY' && input.status === 'FOLDING')) {
        throw new AppError('INVALID_STATUS_MOVE', `A job order ${job.status.toLowerCase()} does not go back to ${input.status.toLowerCase()}`, HttpStatus.CONFLICT);
      }
      if (input.status === 'READY' && !job.pricedAt) throw unprocessable('JOB_NOT_PRICED', 'Weigh and price the job order before it is ready');
      if (job.status === 'READY' && !input.note) throw unprocessable('VALIDATION_FAILED', 'Say why it goes back', { path: ['note'] });
      const [row] = await db
        .update(jobOrders)
        .set({ status: input.status, ...(input.status === 'READY' && { readyAt: sql`now()` }), updatedBy: auth.userId, updatedAt: sql`now()` })
        .where(eq(jobOrders.id, id))
        .returning();
      await recordStatus(db, job, job.status, input.status, auth.userId, input.note);
      if (input.status === 'READY') {
        const [notice] = await db
          .insert(jobOrderNotices)
          .values({ tenantId: job.tenantId, jobOrderId: job.id, kind: 'READY', step: 0 })
          .onConflictDoNothing()
          .returning({ id: jobOrderNotices.id });
        if (notice && job.notify) {
          await emitEvent(db, { tenantId: job.tenantId, topic: 'job_order.notice', payload: { noticeId: notice.id, jobOrderId: job.id }, correlationId: auth.correlationId });
        }
        await emitEvent(db, { tenantId: job.tenantId, topic: 'job_order.ready', payload: { jobOrderId: job.id, branchId: job.branchId }, correlationId: auth.correlationId });
      }
      await this.audit(db, auth, 'job_order.status_changed', 'job_order', id, { from: job.status, to: input.status });
      return jobView(db, row!);
    });
  }

  /**
   * Cancel before the claim (§9): the down payment is given back (`refund` says how) or kept, which needs
   * `laundry.dispose`. Laundry already processed that the customer pays for is claimed, not cancelled.
   */
  cancel(auth: AuthContext, id: string, input: CancelJobOrderInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, id, true);
      const scope = jobScope(job);
      this.assertCan(auth, 'laundry.manage', scope);
      await assertLaundry(db);
      if (!isOpen(job.status)) throw jobEnded(job);
      await lockJobDeposits(db, job.id);
      const held = await depositsHeld(db, job.id);
      if (held.gt(0)) {
        if (input.deposit === 'forfeit') {
          this.assertCan(auth, 'laundry.dispose', scope);
          await this.deposits.forfeitHeld(db, auth, job, `Job order ${jobNumber(job.number)} cancelled: ${input.reason}`);
        } else {
          if (!input.refund) throw unprocessable('REFUND_METHOD_REQUIRED', 'Say how the down payment is given back', { path: ['refund'], held: held.toFixed(2) });
          await this.deposits.refundHeld(db, auth, job, { refund: input.refund, reason: `Job order ${jobNumber(job.number)} cancelled`, amount: held });
        }
      }
      const [row] = await db
        .update(jobOrders)
        .set({ status: 'CANCELLED', cancelledAt: sql`now()`, cancelReason: input.reason, updatedBy: auth.userId, updatedAt: sql`now()` })
        .where(eq(jobOrders.id, id))
        .returning();
      await recordStatus(db, job, job.status, 'CANCELLED', auth.userId, input.reason);
      await db.update(jobOrderTrips).set({ status: 'CANCELLED', failReason: 'Job order cancelled', updatedAt: sql`now()` }).where(and(eq(jobOrderTrips.jobOrderId, id), eq(jobOrderTrips.status, 'SCHEDULED')));
      await this.audit(db, auth, 'job_order.cancelled', 'job_order', id, { reason: input.reason, deposit: held.gt(0) ? input.deposit : null, held: held.toFixed(2) });
      return jobView(db, row!);
    });
  }

  /**
   * Unclaimed laundry (§9): after the branch's unclaimed days from READY and the final notice (or with no
   * way to reach the customer), a manager records it donated or discarded; the down payment is kept.
   */
  dispose(auth: AuthContext, id: string, input: DisposeJobOrderInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, id, true);
      this.assertCan(auth, 'laundry.dispose', jobScope(job));
      await assertLaundry(db);
      if (job.status !== 'READY') throw new AppError('JOB_NOT_UNCLAIMED', 'Only finished laundry waiting at the shop can be disposed of', HttpStatus.CONFLICT, { status: job.status });
      const settings = await branchLaundrySettings(db, job.branchId);
      const { rows: [due] } = await db.execute<{ due: boolean; at: string }>(sql`
        SELECT ${job.readyAt!.toISOString()}::timestamptz + make_interval(days => ${settings.unclaimedDays}) <= now() AS due,
               (${job.readyAt!.toISOString()}::timestamptz + make_interval(days => ${settings.unclaimedDays}))::text AS at`);
      if (!due!.due) throw new AppError('NOT_YET_UNCLAIMED', 'This laundry is not unclaimed yet', HttpStatus.CONFLICT, { unclaimedFrom: due!.at });
      // Decision A4: the final notice must have reached the customer (SENT), or the manager records that
      // the customer cannot be reached and why (audited). A queued, skipped or failed notice is not enough.
      const { rows: [reach] } = await db.execute<{ final: string | null }>(sql`
        SELECT (SELECT n.status FROM job_order_notices n WHERE n.job_order_id = ${job.id} AND n.kind = 'FINAL' ORDER BY (n.status = 'SENT') DESC, n.created_at DESC LIMIT 1) AS final`);
      const finalSent = reach!.final === 'SENT';
      if (!finalSent && !input.customerUnreachable) {
        throw new AppError(
          reach!.final === null || reach!.final === 'QUEUED' ? 'FINAL_NOTICE_PENDING' : 'FINAL_NOTICE_NOT_SENT',
          reach!.final === null || reach!.final === 'QUEUED'
            ? 'The customer has not been sent the final notice yet'
            : 'The final notice did not reach the customer; try to reach them, or record that they cannot be reached',
          HttpStatus.CONFLICT,
          { finalNotice: reach!.final },
        );
      }
      const kept = await this.deposits.forfeitHeld(db, auth, job, `Unclaimed laundry ${jobNumber(job.number)} ${input.reason.toLowerCase()}`);
      const [row] = await db
        .update(jobOrders)
        .set({ status: 'DISPOSED', disposedAt: sql`now()`, disposedReason: input.reason, disposedNote: input.note ?? null, updatedBy: auth.userId, updatedAt: sql`now()` })
        .where(eq(jobOrders.id, id))
        .returning();
      await recordStatus(db, job, job.status, 'DISPOSED', auth.userId, input.reason);
      await this.audit(db, auth, 'job_order.disposed', 'job_order', id, {
        reason: input.reason, depositKept: kept ? toDec(kept.amount).negated().toFixed(2) : '0.00', finalNotice: reach!.final,
        ...(!finalSent && { customerUnreachable: true, unreachableReason: input.unreachableReason }),
      });
      return jobView(db, row!);
    });
  }

  /** The customer's stub and the bag tag (§4), printable; the stub carries the claim code. */
  ticket(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const job = await loadJob(db, id);
      this.assertCanRead(auth, job);
      const view = await jobView(db, job);
      const settings = await branchLaundrySettings(db, job.branchId);
      const { rows: [who] } = await db.execute<{ business: string; entity: string; trade: string | null; address: string | null; branch: string; branch_address: string | null; tz: string }>(sql`
        SELECT t.name AS business, e.registered_name AS entity, e.trade_name AS trade, e.registered_address AS address, b.name AS branch, b.address AS branch_address, b.timezone AS tz
          FROM tenants t, legal_entities e, branches b WHERE e.id = ${job.legalEntityId} AND b.id = ${job.branchId}`);
      const pieces = view.items.reduce((a, i) => a + i.count, 0);
      return {
        stub: {
          business: who!.trade ?? who!.business, legalName: who!.entity, branch: who!.branch, branchAddress: who!.branch_address, timezone: who!.tz,
          reference: view.reference, claimCode: job.claimCode, receivedAt: job.createdAt, promisedAt: job.promisedAt, serviceLevel: job.serviceLevel,
          customer: view.customerDisplayName, weightKg: view.weightKg, bagCount: job.bagCount,
          lines: view.lines.map((l) => ({ name: l.name, measuredQuantity: l.measuredQuantity, quantity: l.quantity, unit: l.laundryUnit, unitPrice: l.unitPrice, amountDue: l.amountDue, packageSession: l.customerPackageId !== null })),
          amountDue: view.amountDue, depositHeld: view.depositHeld, balance: view.balance,
          items: view.items.map((i) => ({ label: i.label, count: i.count, note: i.note })), pieces,
          specialInstructions: job.specialInstructions, conditionNotes: job.conditionNotes,
          claimPolicy: settings.claimPolicyText,
          notice: 'Claim stub — not an official receipt',
        },
        tag: {
          reference: view.reference, customer: view.customerDisplayName, bagCount: job.bagCount, serviceLevel: job.serviceLevel, promisedAt: job.promisedAt,
          specialInstructions: job.specialInstructions, pieces,
        },
      };
    });
  }

  /** The "ready for pickup" text (§6), for a shop that texts from its own phone ("Copy message"). */
  message(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const job = await loadJob(db, id);
      this.assertCanRead(auth, job);
      return { text: await readyMessage(db, job), phone: job.customerPhone ?? (await customerPhone(db, job.customerId)) };
    });
  }

  notices(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const job = await loadJob(db, id);
      this.assertCanRead(auth, job);
      return { data: await db.select().from(jobOrderNotices).where(eq(jobOrderNotices.jobOrderId, id)).orderBy(jobOrderNotices.createdAt) };
    });
  }

  // ---------------------------------------------------------------- helpers

  private assertCanRead(auth: AuthContext, job: JobRow) {
    const scope = jobScope(job);
    if (!this.can(auth, 'laundry.read', scope) && !this.can(auth, 'laundry.deliver', scope)) this.assertCan(auth, 'laundry.read', scope);
  }

  /**
   * Delivery asked for or called off after drop-off (§8): the flag changes and, on a priced job, the lines
   * are priced again and frozen in the caller's transaction, so the branch's delivery fee is added or
   * dropped. The caller holds the job's row lock and checked the job is still open.
   */
  async setDelivery(db: Database, auth: AuthContext, job: JobRow, requested: boolean): Promise<JobRow> {
    const [flagged] = (await db
      .update(jobOrders)
      .set({ deliveryRequested: requested, updatedBy: auth.userId, updatedAt: sql`now()` })
      .where(eq(jobOrders.id, job.id))
      .returning()) as [JobRow];
    if (requested === job.deliveryRequested || !job.pricedAt) return flagged;
    const settings = await branchLaundrySettings(db, job.branchId);
    if (!settings.deliveryVariantId) return flagged;
    const auto = new Set([settings.expressVariantId, settings.deliveryVariantId].filter((x): x is string => x !== null));
    const lines = await db.select().from(jobOrderLines).where(eq(jobOrderLines.jobOrderId, job.id)).orderBy(jobOrderLines.lineNo);
    const input = lines
      .filter((l) => !auto.has(l.variantId))
      .map((l) => ({ variantId: l.variantId, quantity: toDec(l.measuredQuantity).toString(), ...(l.customerPackageId && { packageId: l.customerPackageId }) }));
    const priced = await priceJob(this.tax, db, auth, flagged, input, settings);
    const stored = await storeLines(db, flagged, priced, auth.userId);
    await this.audit(db, auth, 'job_order.lines_changed', 'job_order', job.id, {
      from: toDec(job.amountDue).toFixed(2), to: toDec(stored.amountDue).toFixed(2), lines: input.length, delivery: requested,
    });
    return stored;
  }

  async insertTrip(db: Database, auth: AuthContext, job: JobRow, kind: 'PICKUP' | 'DELIVERY', t: CreateJobOrderInput['pickup'] & object) {
    if (await liveTrip(db, job.id, kind)) throw new AppError('TRIP_EXISTS', `This job order already has a ${kind.toLowerCase()} scheduled`, HttpStatus.CONFLICT);
    if (t.riderMemberId) {
      const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM tenant_memberships WHERE id = ${t.riderMemberId} AND status = 'ACTIVE'`);
      if (!Number(rows[0]!.n)) throw new AppError('NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND, { path: ['riderMemberId'] });
    }
    const [row] = await db
      .insert(jobOrderTrips)
      .values({
        tenantId: job.tenantId, jobOrderId: job.id, branchId: job.branchId, kind, address: t.address, contactPhone: t.contactPhone, contactName: t.contactName ?? null,
        windowStart: t.windowStart ? new Date(t.windowStart) : null, windowEnd: t.windowEnd ? new Date(t.windowEnd) : null,
        riderMemberId: t.riderMemberId ?? null, riderName: t.riderName ?? null, notes: t.notes ?? null, createdBy: auth.userId,
      })
      .returning();
    return row!;
  }
}

async function customerPhone(db: Database, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const { rows } = await db.execute<{ phone: string | null }>(sql`SELECT phone FROM customers WHERE id = ${customerId} AND anonymised_at IS NULL`);
  return rows[0]?.phone ?? null;
}

/** "<Business>: your laundry J-000123 is ready for pickup at <branch>. Balance ₱<amount>." No items, no claim code. */
export async function readyMessage(db: Database, job: JobRow): Promise<string> {
  const { rows: [who] } = await db.execute<{ business: string; trade: string | null; branch: string }>(sql`
    SELECT t.name AS business, e.trade_name AS trade, b.name AS branch FROM tenants t, legal_entities e, branches b WHERE e.id = ${job.legalEntityId} AND b.id = ${job.branchId}`);
  const balance = toDec(job.amountDue).minus(await depositsHeld(db, job.id));
  const pay = balance.gt(0) ? ` Balance ${peso(balance.toString())}.` : ' Fully paid.';
  return `${who!.trade ?? who!.business}: your laundry ${jobNumber(job.number)} is ready for pickup at ${who!.branch}.${pay} Please bring your claim stub.`;
}
