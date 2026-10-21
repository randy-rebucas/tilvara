import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { eq, jobOrders, jobOrderTrips, sql, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { CreateTripInput, TripListQuery, TripReasonInput, UpdateTripInput } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';
import { assertLaundry } from '../billing/entitlements.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { isOpen, jobEnded, jobNumber, jobScope, loadJob, recordStatus } from './job.js';
import { JobOrdersService } from './job-orders.service.js';

type TripRow = typeof jobOrderTrips.$inferSelect;

/**
 * Pickups and deliveries (ADR-0024 §8): scheduled with a job order or later, a rider takes them; a
 * delivery leaving the shop puts the job OUT_FOR_DELIVERY, a failed one brings it back READY. A
 * delivery is done only by the claim at the door (the sale records the payment and the release).
 */
@Injectable()
export class TripsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    job_order_trips_live_once: ['TRIP_EXISTS', 'This job order already has one scheduled'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(JobOrdersService) private readonly jobs: JobOrdersService,
  ) {
    super(tenantDb);
  }

  list(auth: AuthContext, q: TripListQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      if (!this.can(auth, 'laundry.deliver', scope)) this.assertCan(auth, 'laundry.read', scope);
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        SELECT t.*, j.number AS job_number, j.status AS job_status, j.bag_count, j.amount_due::text AS amount_due,
               (j.amount_due - coalesce((SELECT sum(d.amount) FROM job_order_deposits d WHERE d.job_order_id = j.id), 0))::text AS balance,
               coalesce(c.display_name, j.customer_name) AS customer
          FROM job_order_trips t
          JOIN job_orders j ON j.id = t.job_order_id
          LEFT JOIN customers c ON c.id = j.customer_id
          JOIN branches b ON b.id = t.branch_id
         WHERE t.branch_id = ${q.branchId}
           ${q.status ? sql`AND t.status = ${q.status}` : sql``}
           ${q.date ? sql`AND (coalesce(t.window_start, t.created_at) AT TIME ZONE b.timezone)::date = ${q.date}::date` : sql``}
         ORDER BY t.window_start NULLS LAST, t.created_at`);
      return {
        data: rows.map((r) => ({
          id: r.id, jobOrderId: r.job_order_id, jobReference: jobNumber(Number(r.job_number)), jobStatus: r.job_status, kind: r.kind, status: r.status,
          customer: r.customer, address: r.address, contactPhone: r.contact_phone, contactName: r.contact_name, windowStart: r.window_start, windowEnd: r.window_end,
          riderMemberId: r.rider_member_id, riderName: r.rider_name, notes: r.notes, failReason: r.fail_reason, doneAt: r.done_at, bagCount: r.bag_count,
          amountDue: toDec(r.amount_due as string).toFixed(2), balance: Dec.max(toDec(r.balance as string), 0).toFixed(2),
        })),
      };
    });
  }

  create(auth: AuthContext, jobId: string, input: CreateTripInput) {
    return this.mutate(auth, async (db) => {
      const job = await loadJob(db, jobId, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      if (!isOpen(job.status)) throw jobEnded(job);
      if (input.kind === 'PICKUP' && job.status !== 'RECEIVED') throw new AppError('JOB_ALREADY_AT_SHOP', 'This laundry is already at the shop', HttpStatus.CONFLICT);
      const trip = await this.jobs.insertTrip(db, auth, job, input.kind, input);
      // Asking for delivery later: the flag follows and the branch's delivery fee is added to the frozen lines now.
      if (input.kind === 'DELIVERY') await this.jobs.setDelivery(db, auth, job, true);
      else await db.update(jobOrders).set({ pickupRequested: true, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrders.id, job.id));
      await this.audit(db, auth, 'job_order.trip_scheduled', 'job_order', job.id, { tripId: trip.id, kind: input.kind });
      return trip;
    });
  }

  update(auth: AuthContext, id: string, input: UpdateTripInput) {
    return this.mutate(auth, async (db) => {
      const trip = await this.trip(db, id);
      this.assertCan(auth, 'laundry.manage', (await branchScope(db, trip.branchId)).scope);
      await assertLaundry(db);
      if (trip.status !== 'SCHEDULED') throw this.tripEnded(trip);
      const [row] = await db
        .update(jobOrderTrips)
        .set({
          ...(input.address !== undefined && { address: input.address }),
          ...(input.contactPhone !== undefined && { contactPhone: input.contactPhone }),
          ...(input.contactName !== undefined && { contactName: input.contactName }),
          ...(input.windowStart !== undefined && { windowStart: input.windowStart ? new Date(input.windowStart) : null }),
          ...(input.windowEnd !== undefined && { windowEnd: input.windowEnd ? new Date(input.windowEnd) : null }),
          ...(input.riderMemberId !== undefined && { riderMemberId: input.riderMemberId }),
          ...(input.riderName !== undefined && { riderName: input.riderName }),
          ...(input.notes !== undefined && { notes: input.notes }),
          updatedAt: sql`now()`,
        })
        .where(eq(jobOrderTrips.id, id))
        .returning();
      await this.audit(db, auth, 'job_order.trip_updated', 'job_order', trip.jobOrderId, { tripId: id, fields: Object.keys(input) });
      return row!;
    });
  }

  /** The rider leaves with a finished job: it is OUT_FOR_DELIVERY until the claim at the door or a failure. */
  start(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const trip = await this.trip(db, id);
      const job = await loadJob(db, trip.jobOrderId, true);
      this.assertDeliver(auth, job);
      await assertLaundry(db);
      if (trip.status !== 'SCHEDULED') throw this.tripEnded(trip);
      if (trip.kind !== 'DELIVERY') throw new AppError('NOT_A_DELIVERY', 'Only a delivery goes out with laundry', HttpStatus.CONFLICT);
      if (job.status !== 'READY') throw new AppError('JOB_NOT_READY', 'Only finished laundry goes out for delivery', HttpStatus.CONFLICT, { status: job.status });
      await db.update(jobOrders).set({ status: 'OUT_FOR_DELIVERY', updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrders.id, job.id));
      await recordStatus(db, job, job.status, 'OUT_FOR_DELIVERY', auth.userId);
      await this.audit(db, auth, 'job_order.out_for_delivery', 'job_order', job.id, { tripId: id });
      return { ...trip, jobStatus: 'OUT_FOR_DELIVERY' };
    });
  }

  /** A pickup collected. A delivery is completed by the claim at the door (POST …/claim, releasedVia DELIVERY). */
  done(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const trip = await this.trip(db, id);
      const job = await loadJob(db, trip.jobOrderId, true);
      this.assertDeliver(auth, job);
      await assertLaundry(db);
      if (trip.status !== 'SCHEDULED') throw this.tripEnded(trip);
      if (trip.kind === 'DELIVERY') throw new AppError('CLAIM_AT_THE_DOOR', 'Record the claim at the door to complete a delivery', HttpStatus.CONFLICT);
      const [row] = await db.update(jobOrderTrips).set({ status: 'DONE', doneAt: sql`now()`, doneBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrderTrips.id, id)).returning();
      await this.audit(db, auth, 'job_order.trip_done', 'job_order', job.id, { tripId: id, kind: trip.kind });
      return row!;
    });
  }

  /** Nobody home, wrong address: a delivery brings the job back READY at the shop. */
  failed(auth: AuthContext, id: string, input: TripReasonInput) {
    return this.mutate(auth, async (db) => {
      const trip = await this.trip(db, id);
      const job = await loadJob(db, trip.jobOrderId, true);
      this.assertDeliver(auth, job);
      await assertLaundry(db);
      if (trip.status !== 'SCHEDULED') throw this.tripEnded(trip);
      const [row] = await db.update(jobOrderTrips).set({ status: 'FAILED', failReason: input.reason, doneBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrderTrips.id, id)).returning();
      if (trip.kind === 'DELIVERY' && job.status === 'OUT_FOR_DELIVERY') {
        await db.update(jobOrders).set({ status: 'READY', updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrders.id, job.id));
        await recordStatus(db, job, job.status, 'READY', auth.userId, input.reason);
      }
      await this.audit(db, auth, 'job_order.trip_failed', 'job_order', job.id, { tripId: id, kind: trip.kind, reason: input.reason });
      return row!;
    });
  }

  cancel(auth: AuthContext, id: string, input: TripReasonInput) {
    return this.mutate(auth, async (db) => {
      const trip = await this.trip(db, id);
      const job = await loadJob(db, trip.jobOrderId, true);
      this.assertCan(auth, 'laundry.manage', jobScope(job));
      await assertLaundry(db);
      if (trip.status !== 'SCHEDULED') throw this.tripEnded(trip);
      if (job.status === 'OUT_FOR_DELIVERY' && trip.kind === 'DELIVERY') throw new AppError('TRIP_UNDER_WAY', 'The rider has the laundry; mark the delivery failed instead', HttpStatus.CONFLICT);
      const [row] = await db.update(jobOrderTrips).set({ status: 'CANCELLED', failReason: input.reason, updatedAt: sql`now()` }).where(eq(jobOrderTrips.id, id)).returning();
      // A claimed (or otherwise ended) job keeps its lines and flags; only the stale trip is called off.
      if (isOpen(job.status)) {
        if (trip.kind === 'DELIVERY') await this.jobs.setDelivery(db, auth, job, false);
        else await db.update(jobOrders).set({ pickupRequested: false, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(jobOrders.id, job.id));
      }
      await this.audit(db, auth, 'job_order.trip_cancelled', 'job_order', job.id, { tripId: id, kind: trip.kind });
      return row!;
    });
  }

  private assertDeliver(auth: AuthContext, job: { branchId: string; legalEntityId: string }) {
    const scope = jobScope(job);
    if (!this.can(auth, 'laundry.deliver', scope)) this.assertCan(auth, 'laundry.manage', scope);
  }

  private tripEnded(trip: TripRow) {
    return new AppError('TRIP_ENDED', `This ${trip.kind.toLowerCase()} is ${trip.status.toLowerCase()}`, HttpStatus.CONFLICT, { status: trip.status });
  }

  private async trip(db: Database, id: string): Promise<TripRow> {
    const [row] = await db.select().from(jobOrderTrips).where(eq(jobOrderTrips.id, id)).for('update');
    if (!row) throw notFound('Trip');
    return row;
  }
}
