import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  branches,
  eq,
  gt,
  inArray,
  isNull,
  products,
  productVariants,
  serviceStaff,
  serviceStaffHours,
  serviceStaffServices,
  serviceStaffTimeOff,
  sql,
  tenantMemberships,
  users,
  inSequence,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type {
  CreateServiceStaffInput,
  CreateTimeOffInput,
  ServiceStaffListQuery,
  SetStaffHoursInput,
  SetStaffServicesInput,
  UpdateServiceStaffInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertAppointments } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { unprocessable } from '../tax/tax.service.js';

type StaffRow = typeof serviceStaff.$inferSelect;
const scopeOf = (s: { branchId: string }, legalEntityId: string) => ({ branchId: s.branchId, legalEntityId });
const rate = (v: string | null) => (v === null ? null : toDec(v).toString());

/** A staff member of this business, with their branch's legal entity (for scope checks). */
export async function loadStaff(db: Database, id: string, lock = false) {
  const q = db
    .select({ staff: serviceStaff, legalEntityId: branches.legalEntityId, timezone: branches.timezone })
    .from(serviceStaff)
    .innerJoin(branches, eq(branches.id, serviceStaff.branchId))
    .where(eq(serviceStaff.id, id));
  const [row] = lock ? await q.for('update', { of: serviceStaff }) : await q;
  if (!row) throw notFound('Staff member');
  return row;
}

/**
 * The commission rate a staff member earns on an item (ADR-0022 §5): the rate set for that service,
 * else their own rate. Read at the sale and kept on the line.
 */
export async function commissionRates(db: Database, pairs: { staffId: string; variantId: string }[]): Promise<Map<string, string>> {
  if (!pairs.length) return new Map();
  const staffIds = [...new Set(pairs.map((p) => p.staffId))];
  const [staff, own] = await inSequence(
    () => db.select({ id: serviceStaff.id, rate: serviceStaff.commissionRate }).from(serviceStaff).where(inArray(serviceStaff.id, staffIds)),
    () => db.select().from(serviceStaffServices).where(inArray(serviceStaffServices.staffId, staffIds)),
  );
  const out = new Map<string, string>();
  for (const p of pairs) {
    const special = own.find((o) => o.staffId === p.staffId && o.variantId === p.variantId)?.commissionRate;
    const base = staff.find((s) => s.id === p.staffId)?.rate;
    out.set(`${p.staffId}:${p.variantId}`, special ?? base ?? '0');
  }
  return out;
}

/**
 * Service staff (ADR-0022 §2): the people who perform services at a branch, signed in or not.
 * `staff.manage` at the branch changes them; `appointments.read` (or selling there) lists them.
 * Commission rates are shown only to those who manage staff.
 */
@Injectable()
export class StaffService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    service_staff_membership_once: ['MEMBER_ALREADY_STAFF', 'This member is already linked to another staff member'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  private canSee(auth: AuthContext, scope: { branchId: string; legalEntityId: string }) {
    return this.can(auth, 'appointments.read', scope) || this.can(auth, 'staff.manage', scope) || this.can(auth, 'sales.create', scope);
  }

  list(auth: AuthContext, q: ServiceStaffListQuery) {
    return this.read(auth, async (db) => {
      if (q.branchId) {
        const { scope } = await branchScope(db, q.branchId);
        if (!this.canSee(auth, scope)) this.assertCan(auth, 'appointments.read', scope);
      }
      const rows = await db
        .select({ staff: serviceStaff, legalEntityId: branches.legalEntityId })
        .from(serviceStaff)
        .innerJoin(branches, eq(branches.id, serviceStaff.branchId))
        .where(and(q.branchId ? eq(serviceStaff.branchId, q.branchId) : undefined, q.includeArchived ? undefined : isNull(serviceStaff.archivedAt)))
        .orderBy(asc(serviceStaff.displayName), asc(serviceStaff.id));
      const visible = rows.filter((r) => this.canSee(auth, scopeOf(r.staff, r.legalEntityId)));
      return { data: await this.views(db, auth, visible) };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const row = await loadStaff(db, id);
      const scope = scopeOf(row.staff, row.legalEntityId);
      if (!this.canSee(auth, scope)) this.assertCan(auth, 'appointments.read', scope);
      const [view] = await this.views(db, auth, [row]);
      const timeOff = await db
        .select()
        .from(serviceStaffTimeOff)
        .where(and(eq(serviceStaffTimeOff.staffId, id), gt(serviceStaffTimeOff.endsAt, sql`now() - interval '30 days'`)))
        .orderBy(asc(serviceStaffTimeOff.startsAt));
      return { ...view!, timeOff: timeOff.map((t) => ({ id: t.id, startsAt: t.startsAt, endsAt: t.endsAt, reason: t.reason })) };
    });
  }

  create(auth: AuthContext, input: CreateServiceStaffInput) {
    return this.mutate(auth, async (db) => {
      const { branch, scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'staff.manage', scope);
      await assertAppointments(db);
      if (branch.archivedAt) throw archived('Branch');
      if (input.membershipId) await this.member(db, input.membershipId);
      const [row] = await db
        .insert(serviceStaff)
        .values({
          tenantId: tenantOf(auth).tenantId, branchId: branch.id, displayName: input.displayName, membershipId: input.membershipId ?? null,
          commissionRate: input.commissionRate, color: input.color ?? null,
        })
        .returning();
      await this.audit(db, auth, 'service_staff.created', 'service_staff', row!.id, { branchId: branch.id, commissionRate: input.commissionRate, linked: Boolean(input.membershipId) });
      return (await this.views(db, auth, [{ staff: row!, legalEntityId: branch.legalEntityId }]))[0]!;
    });
  }

  update(auth: AuthContext, id: string, input: UpdateServiceStaffInput) {
    return this.mutate(auth, async (db) => {
      const row = await loadStaff(db, id, true);
      this.assertCan(auth, 'staff.manage', scopeOf(row.staff, row.legalEntityId));
      await assertAppointments(db);
      if (row.staff.archivedAt && input.archived !== false) throw archived('Staff member');
      if (input.membershipId) await this.member(db, input.membershipId);
      const { archived: archive, ...fields } = input;
      const [after] = await db
        .update(serviceStaff)
        .set({ ...fields, ...(archive !== undefined && { archivedAt: archive ? sql`now()` : null }), updatedAt: sql`now()` })
        .where(eq(serviceStaff.id, id))
        .returning();
      // Names and colours are not personal detail worth logging; the rate is (it is pay).
      await this.audit(db, auth, archive ? 'service_staff.archived' : 'service_staff.updated', 'service_staff', id, {
        fields: Object.keys(input), ...(input.commissionRate !== undefined && { commissionRate: input.commissionRate, before: rate(row.staff.commissionRate) }),
      });
      return (await this.views(db, auth, [{ staff: after!, legalEntityId: row.legalEntityId }]))[0]!;
    });
  }

  /** The services they do, replaced as a whole (none = every service). Only SERVICE items. */
  setServices(auth: AuthContext, id: string, input: SetStaffServicesInput) {
    return this.mutate(auth, async (db) => {
      const row = await loadStaff(db, id, true);
      this.assertCan(auth, 'staff.manage', scopeOf(row.staff, row.legalEntityId));
      await assertAppointments(db);
      const ids = input.services.map((s) => s.variantId);
      if (ids.length) {
        const found = await db
          .select({ id: productVariants.id, type: products.productType })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(inArray(productVariants.id, ids));
        for (const [i, vid] of ids.entries()) {
          const v = found.find((f) => f.id === vid);
          if (!v) throw new AppError('NOT_FOUND', 'Service not found', HttpStatus.NOT_FOUND, { path: ['services', i, 'variantId'] });
          if (v.type !== 'SERVICE') throw unprocessable('NOT_A_SERVICE', 'Only services can be assigned to staff', { path: ['services', i, 'variantId'] });
        }
      }
      const tenantId = tenantOf(auth).tenantId;
      await db.delete(serviceStaffServices).where(eq(serviceStaffServices.staffId, id));
      if (ids.length) {
        await db.insert(serviceStaffServices).values(input.services.map((s) => ({ tenantId, staffId: id, variantId: s.variantId, commissionRate: s.commissionRate ?? null })));
      }
      await this.audit(db, auth, 'service_staff.services_set', 'service_staff', id, { services: ids.length });
      return (await this.views(db, auth, [row]))[0]!;
    });
  }

  /** Weekly hours, replaced as a whole. */
  setHours(auth: AuthContext, id: string, input: SetStaffHoursInput) {
    return this.mutate(auth, async (db) => {
      const row = await loadStaff(db, id, true);
      this.assertCan(auth, 'staff.manage', scopeOf(row.staff, row.legalEntityId));
      await assertAppointments(db);
      const tenantId = tenantOf(auth).tenantId;
      await db.delete(serviceStaffHours).where(eq(serviceStaffHours.staffId, id));
      if (input.hours.length) {
        await db.insert(serviceStaffHours).values(input.hours.map((h) => ({ tenantId, staffId: id, weekday: h.weekday, startsAt: h.startsAt, endsAt: h.endsAt })));
      }
      await this.audit(db, auth, 'service_staff.hours_set', 'service_staff', id, { spans: input.hours.length });
      return (await this.views(db, auth, [row]))[0]!;
    });
  }

  /** Leave or a break; the front desk (appointments.manage) may record it too. */
  addTimeOff(auth: AuthContext, id: string, input: CreateTimeOffInput) {
    return this.mutate(auth, async (db) => {
      const row = await loadStaff(db, id, true);
      const scope = scopeOf(row.staff, row.legalEntityId);
      if (!this.can(auth, 'staff.manage', scope)) this.assertCan(auth, 'appointments.manage', scope);
      await assertAppointments(db);
      if (row.staff.archivedAt) throw archived('Staff member');
      const [t] = await db
        .insert(serviceStaffTimeOff)
        .values({ tenantId: tenantOf(auth).tenantId, staffId: id, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), reason: input.reason ?? null, createdBy: auth.userId })
        .returning();
      await this.audit(db, auth, 'service_staff.time_off_added', 'service_staff', id, { timeOffId: t!.id });
      return { id: t!.id, startsAt: t!.startsAt, endsAt: t!.endsAt, reason: t!.reason };
    });
  }

  removeTimeOff(auth: AuthContext, id: string, timeOffId: string) {
    return this.mutate(auth, async (db) => {
      const row = await loadStaff(db, id, true);
      const scope = scopeOf(row.staff, row.legalEntityId);
      if (!this.can(auth, 'staff.manage', scope)) this.assertCan(auth, 'appointments.manage', scope);
      await assertAppointments(db);
      const deleted = await db.delete(serviceStaffTimeOff).where(and(eq(serviceStaffTimeOff.id, timeOffId), eq(serviceStaffTimeOff.staffId, id))).returning({ id: serviceStaffTimeOff.id });
      if (!deleted.length) throw notFound('Time off');
      await this.audit(db, auth, 'service_staff.time_off_removed', 'service_staff', id, { timeOffId });
      return { removed: true };
    });
  }

  private async member(db: Database, membershipId: string) {
    const [m] = await db.select().from(tenantMemberships).where(eq(tenantMemberships.id, membershipId));
    if (!m) throw notFound('Member');
    if (m.status === 'REMOVED') throw unprocessable('MEMBER_REMOVED', 'This member was removed from the business');
  }

  private async views(db: Database, auth: AuthContext, rows: { staff: StaffRow; legalEntityId: string }[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.staff.id);
    const memberIds = rows.flatMap((r) => (r.staff.membershipId ? [r.staff.membershipId] : []));
    const [services, hours, members] = await inSequence(
      () => db.select().from(serviceStaffServices).where(inArray(serviceStaffServices.staffId, ids)),
      () => db.select().from(serviceStaffHours).where(inArray(serviceStaffHours.staffId, ids)).orderBy(asc(serviceStaffHours.weekday), asc(serviceStaffHours.startsAt)),
      () => (memberIds.length
        ? db.select({ id: tenantMemberships.id, name: users.displayName }).from(tenantMemberships).innerJoin(users, eq(users.id, tenantMemberships.userId)).where(inArray(tenantMemberships.id, memberIds))
        : Promise.resolve([] as { id: string; name: string }[])),
    );
    return rows.map(({ staff: s, legalEntityId }) => {
      const manage = this.can(auth, 'staff.manage', scopeOf(s, legalEntityId));
      return {
        id: s.id,
        branchId: s.branchId,
        displayName: s.displayName,
        membershipId: s.membershipId,
        memberName: members.find((m) => m.id === s.membershipId)?.name ?? null,
        color: s.color,
        archivedAt: s.archivedAt,
        ...(manage && { commissionRate: rate(s.commissionRate) }),
        services: services.filter((x) => x.staffId === s.id).map((x) => ({ variantId: x.variantId, ...(manage && { commissionRate: rate(x.commissionRate) }) })),
        hours: hours.filter((h) => h.staffId === s.id).map((h) => ({ weekday: h.weekday, startsAt: h.startsAt.slice(0, 5), endsAt: h.endsAt.slice(0, 5) })),
        canManage: manage,
      };
    });
  }
}
