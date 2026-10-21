import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  appointments,
  appointmentServices,
  asc,
  branches,
  customerNotes,
  customers,
  desc,
  eq,
  inArray,
  products,
  productVariants,
  saleLines,
  sales,
  serviceStaff,
  servicePackageItems,
  sql,
  users,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type { CustomerNoteInput, SetPackageItemsInput, UpdateCustomerNoteInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { hasPermission } from '../auth/authorization.js';
import { assertAppointments } from '../billing/entitlements.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { customerPackageBalances } from './packages.js';

/** Customers are business-wide: a grant at any scope opens them (ADR-0018). */
const holds = (auth: AuthContext, perm: 'customers.read' | 'customers.manage' | 'catalog.read' | 'catalog.manage') => tenantOf(auth).grants.some((g) => g.permission === perm);
const forbidden = (perm: string) => new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: [perm] });

/**
 * Package contents (ADR-0022 §6) and a client's history (§8): their packages, visits (appointments
 * and the services they had, with staff) and service notes.
 */
@Injectable()
export class SalonService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- package contents

  packageItems(auth: AuthContext, variantId: string) {
    return this.read(auth, async (db) => {
      if (!holds(auth, 'catalog.read')) throw forbidden('catalog.read');
      const pkg = await this.packageVariant(db, variantId);
      return this.itemsView(db, pkg.id, pkg.validDays);
    });
  }

  /** Replace what a package holds. Packages already sold keep their own copy. */
  setPackageItems(auth: AuthContext, variantId: string, input: SetPackageItemsInput) {
    return this.mutate(auth, async (db) => {
      if (!holds(auth, 'catalog.manage')) throw forbidden('catalog.manage');
      await assertAppointments(db);
      const pkg = await this.packageVariant(db, variantId);
      if (pkg.archivedAt) throw archived('Package');
      const ids = input.items.map((i) => i.serviceVariantId);
      const found = await db
        .select({ id: productVariants.id, type: products.productType, archivedAt: productVariants.archivedAt })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(productVariants.id, ids));
      for (const [i, id] of ids.entries()) {
        const v = found.find((f) => f.id === id);
        if (!v) throw new AppError('NOT_FOUND', 'Service not found', HttpStatus.NOT_FOUND, { path: ['items', i, 'serviceVariantId'] });
        if (v.type !== 'SERVICE') throw unprocessable('NOT_A_SERVICE', 'A package holds services only', { path: ['items', i, 'serviceVariantId'] });
        if (v.archivedAt) throw unprocessable('ARCHIVED', 'This service is archived', { path: ['items', i, 'serviceVariantId'] });
      }
      const tenantId = tenantOf(auth).tenantId;
      await db.delete(servicePackageItems).where(eq(servicePackageItems.packageVariantId, variantId));
      await db.insert(servicePackageItems).values(input.items.map((i) => ({ tenantId, packageVariantId: variantId, serviceVariantId: i.serviceVariantId, sessions: i.sessions })));
      await this.audit(db, auth, 'package.contents_set', 'product_variant', variantId, { items: input.items.map((i) => ({ serviceVariantId: i.serviceVariantId, sessions: i.sessions })) });
      return this.itemsView(db, variantId, pkg.validDays);
    });
  }

  private async packageVariant(db: Database, variantId: string) {
    const [row] = await db
      .select({ id: productVariants.id, type: products.productType, archivedAt: productVariants.archivedAt, validDays: productVariants.packageValidDays })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, variantId));
    if (!row) throw notFound('Package');
    if (row.type !== 'PACKAGE') throw unprocessable('NOT_A_PACKAGE', 'This item is not a package');
    return row;
  }

  private async itemsView(db: Database, variantId: string, validDays: number | null) {
    const rows = await db
      .select({ i: servicePackageItems, productName: products.name, variantName: productVariants.name, sku: productVariants.sku })
      .from(servicePackageItems)
      .innerJoin(productVariants, eq(productVariants.id, servicePackageItems.serviceVariantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(servicePackageItems.packageVariantId, variantId))
      .orderBy(asc(products.name));
    return {
      variantId,
      validDays,
      items: rows.map((r) => ({ serviceVariantId: r.i.serviceVariantId, sku: r.sku, name: r.variantName ? `${r.productName} — ${r.variantName}` : r.productName, sessions: r.i.sessions })),
    };
  }

  // ---------------------------------------------------------------- client history

  private async customer(db: Database, id: string) {
    const [row] = await db.select().from(customers).where(eq(customers.id, id));
    if (!row) throw notFound('Customer');
    return row;
  }

  private assertRead(auth: AuthContext) {
    if (!holds(auth, 'customers.read') && !holds(auth, 'customers.manage')) throw forbidden('customers.read');
  }

  /** The customer's packages and what is left of each (`open=true`: usable ones only, for the till). */
  packages(auth: AuthContext, customerId: string, openOnly: boolean) {
    return this.read(auth, async (db) => {
      await this.customer(db, customerId);
      this.assertRead(auth);
      return { data: await customerPackageBalances(db, customerId, { openOnly }) };
    });
  }

  /**
   * Visits, newest first: appointments (any status) and the services they had on sales the person may
   * read, with the staff who did them. Up to 100 of each.
   */
  visits(auth: AuthContext, customerId: string) {
    return this.read(auth, async (db) => {
      await this.customer(db, customerId);
      this.assertRead(auth);
      const appts = await db
        .select({ a: appointments, branchName: branches.name, legalEntityId: branches.legalEntityId })
        .from(appointments)
        .innerJoin(branches, eq(branches.id, appointments.branchId))
        .where(eq(appointments.customerId, customerId))
        .orderBy(desc(appointments.startsAt))
        .limit(100);
      const apptServices = appts.length
        ? await db
            .select({ s: appointmentServices, productName: products.name, variantName: productVariants.name, staffName: serviceStaff.displayName })
            .from(appointmentServices)
            .innerJoin(productVariants, eq(productVariants.id, appointmentServices.variantId))
            .innerJoin(products, eq(products.id, productVariants.productId))
            .innerJoin(serviceStaff, eq(serviceStaff.id, appointmentServices.staffId))
            .where(inArray(appointmentServices.appointmentId, appts.map((a) => a.a.id)))
            .orderBy(asc(appointmentServices.position))
        : [];
      const lines = await db
        .select({ l: saleLines, sale: sales, staffName: serviceStaff.displayName, productType: products.productType })
        .from(saleLines)
        .innerJoin(sales, eq(sales.id, saleLines.saleId))
        .innerJoin(productVariants, eq(productVariants.id, saleLines.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .leftJoin(serviceStaff, eq(serviceStaff.id, saleLines.serviceStaffId))
        .where(and(eq(sales.customerId, customerId), sql`(${products.productType} <> 'STANDARD' OR ${saleLines.serviceStaffId} IS NOT NULL)`))
        .orderBy(desc(sales.completedAt), asc(saleLines.lineNo))
        .limit(100);
      const grants = tenantOf(auth).grants;
      const visible = lines.filter(({ sale: s }) => s.cashierUserId === auth.userId || hasPermission(grants, 'sales.read', { legalEntityId: s.legalEntityId, branchId: s.branchId, registerId: s.registerId }));
      return {
        appointments: appts
          .filter((a) => hasPermission(grants, 'appointments.read', { branchId: a.a.branchId, legalEntityId: a.legalEntityId }))
          .map(({ a, branchName }) => ({
            id: a.id, branchId: a.branchId, branchName, status: a.status, startsAt: a.startsAt, endsAt: a.endsAt, saleId: a.saleId, notes: a.notes,
            services: apptServices.filter((x) => x.s.appointmentId === a.id).map((x) => ({
              name: x.variantName ? `${x.productName} — ${x.variantName}` : x.productName, staffName: x.staffName, startsAt: x.s.startsAt,
            })),
          })),
        services: visible.map(({ l, sale, staffName, productType }) => ({
          saleId: sale.id, saleNumber: sale.saleNumber, completedAt: sale.completedAt, name: l.name, kind: productType,
          quantity: toDec(l.quantity).toString(), amountDue: toDec(l.amountDue).toFixed(2), staffName: staffName ?? null, fromPackage: l.customerPackageId !== null,
        })),
      };
    });
  }

  notes(auth: AuthContext, customerId: string) {
    return this.read(auth, async (db) => {
      await this.customer(db, customerId);
      this.assertRead(auth);
      const rows = await db
        .select({ n: customerNotes, author: users.displayName })
        .from(customerNotes)
        .leftJoin(users, eq(users.id, customerNotes.updatedBy))
        .where(eq(customerNotes.customerId, customerId))
        .orderBy(desc(customerNotes.pinned), desc(customerNotes.updatedAt));
      return { data: rows.map(({ n, author }) => noteView(n, author)) };
    });
  }

  addNote(auth: AuthContext, customerId: string, input: CustomerNoteInput) {
    return this.mutate(auth, async (db) => {
      const c = await this.customer(db, customerId);
      if (!holds(auth, 'customers.manage')) throw forbidden('customers.manage');
      if (c.anonymisedAt) throw new AppError('CUSTOMER_ANONYMISED', 'This customer was anonymised; nothing can be added back', HttpStatus.CONFLICT);
      const [n] = await db
        .insert(customerNotes)
        .values({ tenantId: tenantOf(auth).tenantId, customerId, body: input.body, pinned: input.pinned, createdBy: auth.userId, updatedBy: auth.userId })
        .returning();
      // Audited by id only: a note may hold health information.
      await this.audit(db, auth, 'customer.note_added', 'customer', customerId, { noteId: n!.id });
      return noteView(n!, null);
    });
  }

  updateNote(auth: AuthContext, customerId: string, noteId: string, input: UpdateCustomerNoteInput) {
    return this.mutate(auth, async (db) => {
      await this.customer(db, customerId);
      if (!holds(auth, 'customers.manage')) throw forbidden('customers.manage');
      const [n] = await db
        .update(customerNotes)
        .set({ ...input, updatedBy: auth.userId, updatedAt: sql`now()` })
        .where(and(eq(customerNotes.id, noteId), eq(customerNotes.customerId, customerId)))
        .returning();
      if (!n) throw notFound('Note');
      await this.audit(db, auth, 'customer.note_changed', 'customer', customerId, { noteId, fields: Object.keys(input) });
      return noteView(n, null);
    });
  }

  removeNote(auth: AuthContext, customerId: string, noteId: string) {
    return this.mutate(auth, async (db) => {
      await this.customer(db, customerId);
      if (!holds(auth, 'customers.manage')) throw forbidden('customers.manage');
      const gone = await db.delete(customerNotes).where(and(eq(customerNotes.id, noteId), eq(customerNotes.customerId, customerId))).returning({ id: customerNotes.id });
      if (!gone.length) throw notFound('Note');
      await this.audit(db, auth, 'customer.note_removed', 'customer', customerId, { noteId });
      return { removed: true };
    });
  }
}

function noteView(n: typeof customerNotes.$inferSelect, author: string | null) {
  return { id: n.id, body: n.body, pinned: n.pinned, createdAt: n.createdAt, updatedAt: n.updatedAt, updatedByName: author };
}
