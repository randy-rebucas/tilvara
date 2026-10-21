import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  appointments,
  appointmentServices,
  asc,
  branches,
  customers,
  eq,
  inArray,
  products,
  productVariants,
  serviceStaff,
  serviceStaffServices,
  sql,
  inSequence,
  type Database,
} from '@1pos/database';
import type { AppointmentListQuery, AppointmentStatusInput, AvailabilityQuery, CreateAppointmentInput, UpdateAppointmentInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertAppointments } from '../billing/entitlements.js';
import { dbNow } from '../common/clock.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { activeCustomer } from '../customers/customers.service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';

type AppointmentRow = typeof appointments.$inferSelect;
type ServiceInput = CreateAppointmentInput['services'][number];
type PlannedService = { variantId: string; staffId: string; startsAt: Date; endsAt: Date };

const OPEN = ['BOOKED', 'ARRIVED'] as const;
const MINUTE = 60_000;
/** Free-time suggestions step through the day at this interval. */
const SLOT_STEP_MINUTES = 15;
/** Free times suggested for staff with no hours set: 08:00–20:00 local (DST-free calendars). */
const DEFAULT_OPEN_HOURS = [8, 20] as const;

const doubleBooked = (details?: Record<string, unknown>) =>
  new AppError('STAFF_DOUBLE_BOOKED', 'This staff member is already booked at that time', HttpStatus.CONFLICT, details);

/**
 * Ring up an appointment with its sale (ADR-0022 §4), in `record()`'s transaction: it must be BOOKED or
 * ARRIVED at the sale's branch and not rung up yet; it becomes COMPLETED with the sale's id.
 */
export async function completeAppointment(db: Database, a: { appointmentId: string; branchId: string; saleId: string; userId: string; customerId: string | null }) {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, a.appointmentId)).for('update');
  if (!row) throw notFound('Appointment');
  if (row.branchId !== a.branchId) throw unprocessable('WRONG_BRANCH', 'Ring up an appointment at its own branch');
  if (!(OPEN as readonly string[]).includes(row.status)) {
    throw new AppError('APPOINTMENT_NOT_OPEN', `This appointment is ${row.status.toLowerCase().replace('_', ' ')}`, HttpStatus.CONFLICT, { status: row.status });
  }
  if (row.customerId && a.customerId && row.customerId !== a.customerId) {
    throw unprocessable('APPOINTMENT_CUSTOMER_MISMATCH', 'The sale is for another customer than the appointment');
  }
  await db.update(appointments).set({ status: 'COMPLETED', saleId: a.saleId, updatedBy: a.userId, updatedAt: sql`now()` }).where(eq(appointments.id, row.id));
  return row;
}

/**
 * Appointments (ADR-0022 §4): bookings per branch, for a customer or a guest, each service with its
 * staff member and time. `appointments.read` at the branch sees the calendar; `appointments.manage`
 * books, changes, marks arrivals and no-shows, cancels. A staff member is never booked twice at once
 * (checked here, and by the exclusion constraint for two bookings at the same moment).
 */
@Injectable()
export class AppointmentsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    appointment_services_no_double_booking: ['STAFF_DOUBLE_BOOKED', 'This staff member is already booked at that time'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  list(auth: AuthContext, q: AppointmentListQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'appointments.read', scope);
      const from = new Date(q.from);
      const to = new Date(q.to);
      const rows = await db
        .select()
        .from(appointments)
        .where(and(
          eq(appointments.branchId, q.branchId),
          sql`${appointments.startsAt} < ${to} AND ${appointments.endsAt} > ${from}`,
          q.staffId ? sql`EXISTS (SELECT 1 FROM appointment_services s WHERE s.appointment_id = ${appointments.id} AND s.staff_id = ${q.staffId})` : undefined,
        ))
        .orderBy(asc(appointments.startsAt), asc(appointments.id));
      return { data: await this.views(db, rows) };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const row = await this.load(db, id);
      const { scope } = await branchScope(db, row.branchId);
      this.assertCan(auth, 'appointments.read', scope);
      return (await this.views(db, [row]))[0]!;
    });
  }

  create(auth: AuthContext, input: CreateAppointmentInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'appointments.manage', scope);
      await assertAppointments(db);
      if (branch.archivedAt) throw archived('Branch');
      const customer = input.customerId ? await activeCustomer(db, input.customerId) : null;
      const planned = await this.plan(db, branch, input.services, input.outsideHours, null);
      const span = spanOf(planned);
      const [row] = await db
        .insert(appointments)
        .values({
          tenantId: tenantOf(auth).tenantId,
          branchId: branch.id,
          customerId: customer?.id ?? null,
          guestName: customer ? null : (input.guestName ?? null),
          startsAt: span.startsAt,
          endsAt: span.endsAt,
          notes: input.notes ?? null,
          // A reminder by default when there is an address to send it to (ADR-0022 §10).
          remind: input.remind ?? Boolean(customer?.email),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await this.insertServices(db, auth, row!.id, planned);
      await this.audit(db, auth, 'appointment.booked', 'appointment', row!.id, {
        branchId: branch.id, startsAt: span.startsAt.toISOString(), services: planned.length, ...(input.outsideHours && { outsideHours: true }),
      });
      return (await this.views(db, [row!]))[0]!;
    });
  }

  update(auth: AuthContext, id: string, input: UpdateAppointmentInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id, true);
      const { branch, scope } = await branchScope(db, current.branchId);
      this.assertCan(auth, 'appointments.manage', scope);
      await assertAppointments(db);
      this.assertOpen(current);
      const customer = input.customerId ? await activeCustomer(db, input.customerId) : null;
      const set: Partial<typeof appointments.$inferInsert> = { updatedBy: auth.userId };
      if (input.customerId !== undefined) set.customerId = customer?.id ?? null;
      if (input.guestName !== undefined || customer) set.guestName = customer ? null : (input.guestName ?? null);
      if (input.notes !== undefined) set.notes = input.notes;
      if (input.remind !== undefined) set.remind = input.remind;
      if (input.services) {
        // The appointment's own services make way for their replacements.
        await db.delete(appointmentServices).where(eq(appointmentServices.appointmentId, id));
        const planned = await this.plan(db, branch, input.services, input.outsideHours, id);
        await this.insertServices(db, auth, id, planned);
        Object.assign(set, spanOf(planned));
        // A new time is a new reminder.
        if (spanOf(planned).startsAt.getTime() !== current.startsAt.getTime()) set.remindedAt = null;
      }
      const [row] = await db.update(appointments).set({ ...set, updatedAt: sql`now()` }).where(eq(appointments.id, id)).returning();
      if (!row!.customerId && !row!.guestName) throw unprocessable('APPOINTMENT_NEEDS_NAME', 'Name the customer or a guest');
      await this.audit(db, auth, 'appointment.changed', 'appointment', id, {
        fields: Object.keys(input).filter((k) => k !== 'outsideHours'), ...(input.outsideHours && { outsideHours: true }),
      });
      return (await this.views(db, [row!]))[0]!;
    });
  }

  setStatus(auth: AuthContext, id: string, input: AppointmentStatusInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id, true);
      const { scope } = await branchScope(db, current.branchId);
      this.assertCan(auth, 'appointments.manage', scope);
      await assertAppointments(db);
      if (current.status === input.status) return (await this.views(db, [current]))[0]!;
      this.assertOpen(current);
      if (input.status === 'ARRIVED' && current.status !== 'BOOKED') throw new AppError('APPOINTMENT_NOT_OPEN', 'Only a booked appointment can arrive', HttpStatus.CONFLICT, { status: current.status });
      const [row] = await db
        .update(appointments)
        .set({ status: input.status, cancelReason: input.status === 'CANCELLED' ? input.reason : null, updatedBy: auth.userId, updatedAt: sql`now()` })
        .where(eq(appointments.id, id))
        .returning();
      // A cancelled booking or a no-show frees the staff's time.
      if (input.status !== 'ARRIVED') await db.update(appointmentServices).set({ active: false }).where(eq(appointmentServices.appointmentId, id));
      await this.audit(db, auth, `appointment.${input.status.toLowerCase()}`, 'appointment', id, input.status === 'CANCELLED' ? { reason: input.reason } : undefined);
      return (await this.views(db, [row!]))[0]!;
    });
  }

  /**
   * Free times for a service on a branch day, per staff member who does it: every start (on a
   * 15-minute step) at which the whole service fits in their hours, outside time off and bookings.
   */
  availability(auth: AuthContext, q: AvailabilityQuery) {
    return this.read(auth, async (db) => {
      const { branch, scope } = await branchScope(db, q.branchId);
      this.assertCan(auth, 'appointments.read', scope);
      const service = (await this.services(db, [q.variantId]))[0]!;
      const minutes = service.serviceMinutes;
      if (!minutes) throw unprocessable('SERVICE_HAS_NO_DURATION', 'Give this service a duration before booking it');
      const staff = await this.eligibleStaff(db, branch.id, q.variantId, q.staffId);
      const { rows: [day] } = await db.execute<{ start: Date | string; end: Date | string; weekday: number }>(sql`
        SELECT (${q.date}::date::timestamp AT TIME ZONE ${branch.timezone}) AS start,
               ((${q.date}::date + 1)::timestamp AT TIME ZONE ${branch.timezone}) AS end,
               extract(dow FROM ${q.date}::date)::int AS weekday`);
      const dayStart = new Date(day!.start);
      // Staff without hours can be booked any time, but free times are only suggested within ordinary opening hours.
      const openFrom = dayStart.getTime() + DEFAULT_OPEN_HOURS[0] * 3_600_000;
      const openUntil = dayStart.getTime() + DEFAULT_OPEN_HOURS[1] * 3_600_000;
      const dayEnd = new Date(day!.end);
      const ids = staff.map((s) => s.id);
      if (!ids.length) return { date: q.date, minutes, staff: [] };
      const [{ rows: hours }, { rows: busy }] = await inSequence(
        () => db.execute<{ staff_id: string; start: Date | string; end: Date | string }>(sql`
          SELECT staff_id, ((${q.date}::date + starts_at) AT TIME ZONE ${branch.timezone}) AS start, ((${q.date}::date + ends_at) AT TIME ZONE ${branch.timezone}) AS end
            FROM service_staff_hours WHERE weekday = ${day!.weekday} AND staff_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
        () => db.execute<{ staff_id: string; start: Date | string; end: Date | string }>(sql`
          SELECT staff_id, starts_at AS start, ends_at AS end FROM appointment_services
           WHERE active AND starts_at < ${dayEnd} AND ends_at > ${dayStart} AND staff_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
          UNION ALL
          SELECT staff_id, starts_at, ends_at FROM service_staff_time_off
           WHERE starts_at < ${dayEnd} AND ends_at > ${dayStart} AND staff_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
      );
      const earliest = (await dbNow(db)).getTime();
      const anyHours = new Set(hours.map((h) => h.staff_id));
      return {
        date: q.date,
        minutes,
        staff: staff.map((s) => {
          // No hours set: suggest within 08:00–20:00 of the branch day (the business has not planned shifts).
          const spans = anyHours.has(s.id)
            ? hours.filter((h) => h.staff_id === s.id).map((h) => [new Date(h.start).getTime(), new Date(h.end).getTime()] as const)
            : [[openFrom, openUntil] as const];
          const taken = busy.filter((b) => b.staff_id === s.id).map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()] as const);
          const slots: string[] = [];
          for (const [a, b] of spans) {
            for (let t = a; t + minutes * MINUTE <= b; t += SLOT_STEP_MINUTES * MINUTE) {
              const end = t + minutes * MINUTE;
              if (t < earliest) continue;
              if (taken.some(([x, y]) => x < end && y > t)) continue;
              slots.push(new Date(t).toISOString());
            }
          }
          return { staffId: s.id, displayName: s.displayName, color: s.color, slots };
        }),
      };
    });
  }

  private assertOpen(row: AppointmentRow) {
    if (!(OPEN as readonly string[]).includes(row.status)) {
      throw new AppError('APPOINTMENT_NOT_OPEN', `This appointment is ${row.status.toLowerCase().replace('_', ' ')}`, HttpStatus.CONFLICT, { status: row.status });
    }
  }

  private async load(db: Database, id: string, lock = false) {
    const q = db.select().from(appointments).where(eq(appointments.id, id));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw notFound('Appointment');
    return row;
  }

  private services(db: Database, ids: string[]) {
    return db
      .select({ id: productVariants.id, serviceMinutes: productVariants.serviceMinutes, archivedAt: productVariants.archivedAt, productArchivedAt: products.archivedAt, type: products.productType })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(inArray(productVariants.id, ids))
      .then((rows) => {
        for (const id of ids) {
          const r = rows.find((x) => x.id === id);
          if (!r) throw new AppError('NOT_FOUND', 'Service not found', HttpStatus.NOT_FOUND, { variantId: id });
          if (r.type !== 'SERVICE') throw unprocessable('NOT_A_SERVICE', 'Only services can be booked', { variantId: id });
          if (r.archivedAt || r.productArchivedAt) throw archived('Service');
        }
        return ids.map((id) => rows.find((x) => x.id === id)!);
      });
  }

  /** Active staff of the branch who do this service (none listed = every service). */
  private async eligibleStaff(db: Database, branchId: string, variantId: string, staffId?: string) {
    return db
      .select({ id: serviceStaff.id, displayName: serviceStaff.displayName, color: serviceStaff.color })
      .from(serviceStaff)
      .where(and(
        eq(serviceStaff.branchId, branchId),
        sql`${serviceStaff.archivedAt} IS NULL`,
        staffId ? eq(serviceStaff.id, staffId) : undefined,
        sql`(NOT EXISTS (SELECT 1 FROM service_staff_services x WHERE x.staff_id = ${serviceStaff.id})
             OR EXISTS (SELECT 1 FROM service_staff_services x WHERE x.staff_id = ${serviceStaff.id} AND x.variant_id = ${variantId}))`,
      ))
      .orderBy(asc(serviceStaff.displayName));
  }

  /**
   * Check and time the services: each a bookable service, done by an active staff member of the branch
   * who does it, inside their hours and outside their time off (unless squeezed in), and free.
   */
  private async plan(db: Database, branch: typeof branches.$inferSelect, input: ServiceInput[], outsideHours: boolean, appointmentId: string | null): Promise<PlannedService[]> {
    const services = await this.services(db, input.map((s) => s.variantId));
    const staffIds = [...new Set(input.map((s) => s.staffId))];
    const [staff, own] = await inSequence(
      () => db.select().from(serviceStaff).where(inArray(serviceStaff.id, staffIds)).for('update'),
      () => db.select().from(serviceStaffServices).where(inArray(serviceStaffServices.staffId, staffIds)),
    );
    const planned = input.map((s, i) => {
      const member = staff.find((x) => x.id === s.staffId);
      if (!member) throw new AppError('NOT_FOUND', 'Staff member not found', HttpStatus.NOT_FOUND, { path: ['services', i, 'staffId'] });
      if (member.archivedAt) throw archived('Staff member');
      if (member.branchId !== branch.id) throw unprocessable('WRONG_BRANCH', 'This staff member works at another branch', { path: ['services', i, 'staffId'] });
      const theirs = own.filter((o) => o.staffId === member.id);
      if (theirs.length && !theirs.some((o) => o.variantId === s.variantId)) {
        throw unprocessable('STAFF_DOES_NOT_DO_SERVICE', `${member.displayName} does not do this service`, { path: ['services', i, 'staffId'] });
      }
      const minutes = s.minutes ?? services[i]!.serviceMinutes;
      if (!minutes) throw unprocessable('SERVICE_HAS_NO_DURATION', 'Give this service a duration before booking it', { path: ['services', i, 'variantId'] });
      const startsAt = new Date(s.startsAt);
      return { variantId: s.variantId, staffId: s.staffId, startsAt, endsAt: new Date(startsAt.getTime() + minutes * MINUTE), name: member.displayName };
    });
    for (const [i, p] of planned.entries()) {
      for (const [j, o] of planned.entries()) {
        if (j > i && o.staffId === p.staffId && o.startsAt < p.endsAt && p.startsAt < o.endsAt) throw doubleBooked({ path: ['services', j] });
      }
      const { rows: [c] } = await db.execute<{ no_hours: boolean; within: boolean; off: boolean; clash: string | null }>(sql`
        WITH local AS (SELECT (${p.startsAt}::timestamptz AT TIME ZONE ${branch.timezone}) AS s, (${p.endsAt}::timestamptz AT TIME ZONE ${branch.timezone}) AS e)
        SELECT NOT EXISTS (SELECT 1 FROM service_staff_hours WHERE staff_id = ${p.staffId}) AS no_hours,
               EXISTS (SELECT 1 FROM service_staff_hours h, local
                        WHERE h.staff_id = ${p.staffId} AND h.weekday = extract(dow FROM local.s)::int
                          AND h.starts_at <= local.s::time AND local.e <= local.s::date + h.ends_at) AS within,
               EXISTS (SELECT 1 FROM service_staff_time_off t WHERE t.staff_id = ${p.staffId} AND t.starts_at < ${p.endsAt} AND t.ends_at > ${p.startsAt}) AS off,
               (SELECT s.appointment_id::text FROM appointment_services s
                 WHERE s.staff_id = ${p.staffId} AND s.active AND s.starts_at < ${p.endsAt} AND s.ends_at > ${p.startsAt}
                   ${appointmentId ? sql`AND s.appointment_id <> ${appointmentId}` : sql``}
                 LIMIT 1) AS clash`);
      if (c!.clash) throw doubleBooked({ path: ['services', i], appointmentId: c!.clash });
      if (!outsideHours && ((!c!.no_hours && !c!.within) || c!.off)) {
        throw unprocessable('OUTSIDE_WORKING_HOURS', c!.off ? `${p.name} is off at that time` : `That is outside ${p.name}'s hours`, { path: ['services', i] });
      }
    }
    return planned.map(({ name: _name, ...p }) => p);
  }

  private async insertServices(db: Database, auth: AuthContext, appointmentId: string, planned: PlannedService[]) {
    const tenantId = tenantOf(auth).tenantId;
    await db.insert(appointmentServices).values(planned.map((p, i) => ({ tenantId, appointmentId, position: i + 1, ...p })));
  }

  private async views(db: Database, rows: AppointmentRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const services = await db
      .select({
        s: appointmentServices,
        productName: products.name,
        variantName: productVariants.name,
        staffName: serviceStaff.displayName,
        staffColor: serviceStaff.color,
      })
      .from(appointmentServices)
      .innerJoin(productVariants, eq(productVariants.id, appointmentServices.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(serviceStaff, eq(serviceStaff.id, appointmentServices.staffId))
      .where(inArray(appointmentServices.appointmentId, ids))
      .orderBy(asc(appointmentServices.position));
    const customerIds = [...new Set(rows.flatMap((r) => (r.customerId ? [r.customerId] : [])))];
    const people = customerIds.length
      ? await db.select({ id: customers.id, name: customers.displayName, phone: customers.phone, email: customers.email }).from(customers).where(inArray(customers.id, customerIds))
      : [];
    return rows.map((r) => {
      const c = people.find((p) => p.id === r.customerId);
      return {
        id: r.id,
        branchId: r.branchId,
        status: r.status,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        customerId: r.customerId,
        customerName: c?.name ?? null,
        customerPhone: c?.phone ?? null,
        hasEmail: Boolean(c?.email),
        guestName: r.guestName,
        notes: r.notes,
        remind: r.remind,
        remindedAt: r.remindedAt,
        saleId: r.saleId,
        cancelReason: r.cancelReason,
        createdAt: r.createdAt,
        services: services
          .filter((x) => x.s.appointmentId === r.id)
          .map((x) => ({
            id: x.s.id, variantId: x.s.variantId, name: x.variantName ? `${x.productName} — ${x.variantName}` : x.productName,
            staffId: x.s.staffId, staffName: x.staffName, staffColor: x.staffColor, startsAt: x.s.startsAt, endsAt: x.s.endsAt,
          })),
      };
    });
  }
}

function spanOf(planned: PlannedService[]) {
  return {
    startsAt: new Date(Math.min(...planned.map((p) => p.startsAt.getTime()))),
    endsAt: new Date(Math.max(...planned.map((p) => p.endsAt.getTime()))),
  };
}
