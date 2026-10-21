import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  branches,
  customers,
  dispenseApprovals,
  eq,
  pharmacistLicenses,
  pharmacySettings,
  prescriptionItems,
  prescriptions,
  sql,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type {
  CreateDispenseApprovalInput,
  CreatePrescriptionInput,
  PharmacistLicenseInput,
  PharmacySettingsInput,
  PrescriptionListQuery,
  UpdatePrescriptionInput,
  VoidPrescriptionInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { loadGrants } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { hasPermission } from '../auth/authorization.js';
import { assertPharmacy } from '../billing/entitlements.js';
import { dbNow } from '../common/clock.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { DatabasePool } from '../infrastructure/database.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';
import { hasValidLicence } from './dispensing.js';

/** How long a pharmacist's approval at the till waits for its sale (ADR-0025 §6). */
export const DISPENSE_APPROVAL_TTL_MINUTES = 30;

type PrescriptionRow = typeof prescriptions.$inferSelect;
type ListRow = {
  id: string; branch_id: string; legal_entity_id: string; customer_id: string | null; patient_name: string; prescriber_name: string; issued_on: string;
  yellow_form_no: string | null; created_at: string; voided_at: string | null; prescribed: string | null; filled: string;
};

type FillRow = {
  id: string;
  prescription_item_id: string;
  sale_id: string;
  sale_number: number;
  register_code: string;
  quantity: string;
  dispensed_by_name: string | null;
  needs_review: boolean;
  returned: boolean;
  created_at: string;
};

/**
 * Prescriptions (ADR-0025 §6): recorded at the till with a sale (through `record()`), or here beforehand
 * for a later fill; edited only until something is dispensed on them, voided only while nothing is. Health
 * data: the audit log names ids and fields, never what a prescription says. Also the pharmacist's approval
 * at the till, members' pharmacist licences and the business's pharmacy settings.
 */
@Injectable()
export class PrescriptionsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    prescriptions_yellow_form_once: ['YELLOW_FORM_USED', 'This yellow prescription form number is already on another prescription'],
    pharmacist_licenses_membership_once: ['LICENSE_EXISTS', 'This member already has a licence on record'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(DatabasePool) private readonly database: DatabasePool,
  ) {
    super(tenantDb);
  }

  // ---------------------------------------------------------------- prescriptions

  list(auth: AuthContext, q: PrescriptionListQuery) {
    return this.read(auth, async (db) => {
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { rows } = await db.execute<ListRow>(sql`
        SELECT p.id, p.branch_id, p.legal_entity_id, p.customer_id, p.patient_name, p.prescriber_name, p.issued_on::text, p.yellow_form_no, p.created_at, p.voided_at,
               (SELECT sum(i.quantity) FROM prescription_items i WHERE i.prescription_id = p.id)::text AS prescribed,
               coalesce((SELECT sum(f.quantity) FROM prescription_fills f WHERE f.prescription_id = p.id), 0)::text AS filled
          FROM prescriptions p
         WHERE true
           ${q.branchId ? sql`AND p.branch_id = ${q.branchId}` : sql``}
           ${q.customerId ? sql`AND p.customer_id = ${q.customerId}` : sql``}
           ${like ? sql`AND (p.patient_name ILIKE ${like} OR p.prescriber_name ILIKE ${like} OR p.yellow_form_no ILIKE ${like})` : sql``}
           ${q.open ? sql`AND p.voided_at IS NULL AND EXISTS (SELECT 1 FROM prescription_items i WHERE i.prescription_id = p.id
                            AND i.quantity > coalesce((SELECT sum(f.quantity) FROM prescription_fills f WHERE f.prescription_item_id = i.id), 0))` : sql``}
           ${q.cursor ? sql`AND p.id < ${q.cursor}` : sql``}
         ORDER BY p.id DESC
         LIMIT ${q.limit + 1}`);
      const visible = rows.filter((r) => this.canSee(auth, { branchId: r.branch_id, legalEntityId: r.legal_entity_id }));
      const page = visible.slice(0, q.limit);
      return {
        data: page.map((r) => ({
          id: r.id, branchId: r.branch_id, customerId: r.customer_id, patientName: r.patient_name, prescriberName: r.prescriber_name, issuedOn: r.issued_on,
          yellowFormNo: r.yellow_form_no, createdAt: new Date(r.created_at).toISOString(),
          status: statusOf(r.voided_at, toDec(r.prescribed ?? '0'), toDec(r.filled)), prescribed: toDec(r.prescribed ?? '0').toString(), dispensed: toDec(r.filled).toString(),
        })),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const row = await this.row(db, id);
      this.assertSee(auth, row);
      return this.view(db, row);
    });
  }

  create(auth: AuthContext, input: CreatePrescriptionInput) {
    return this.mutate(auth, async (db) => {
      const [branch] = await db.select().from(branches).where(eq(branches.id, input.branchId));
      if (!branch) throw notFound('Branch');
      this.assertCan(auth, 'pharmacy.dispense', { branchId: branch.id, legalEntityId: branch.legalEntityId });
      await assertPharmacy(db);
      if (input.customerId) await this.activeCustomer(db, input.customerId);
      const [row] = await db.insert(prescriptions).values({
        ...fields(input), tenantId: tenantOf(auth).tenantId, legalEntityId: branch.legalEntityId, branchId: branch.id, source: 'ADMIN', createdBy: auth.userId,
      } as typeof prescriptions.$inferInsert).returning();
      await db.insert(prescriptionItems).values(items(tenantOf(auth).tenantId, row!.id, input.items));
      await this.audit(db, auth, 'prescription.created', 'prescription', row!.id, { branchId: branch.id, items: input.items.length });
      return this.view(db, row!);
    });
  }

  update(auth: AuthContext, id: string, input: UpdatePrescriptionInput) {
    return this.mutate(auth, async (db) => {
      const row = await this.row(db, id, true);
      this.assertCan(auth, 'pharmacy.dispense', { branchId: row.branchId, legalEntityId: row.legalEntityId });
      await assertPharmacy(db);
      if (row.voidedAt) throw new AppError('PRESCRIPTION_VOIDED', 'This prescription was voided', HttpStatus.CONFLICT);
      if (input.customerId) await this.activeCustomer(db, input.customerId);
      const { items: next, ...rest } = input;
      const merged = { ...row, ...rest };
      // A dangerous drug's prescription keeps its forms (the create schema checks the same).
      const dangerous = next ? next.some((i) => i.drugClass === 'DANGEROUS') : (await db.select({ c: prescriptionItems.drugClass }).from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id))).some((i) => i.c === 'DANGEROUS');
      if (dangerous && (!merged.prescriberS2No || !merged.yellowFormNo || !merged.patientAddress)) {
        throw unprocessable('DANGEROUS_DRUG_FORMS', 'A dangerous drug needs the S2 licence, the yellow form number and the patient\'s address');
      }
      if (Object.keys(rest).length) await db.update(prescriptions).set({ ...fields(rest), updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(prescriptions.id, id));
      if (next) {
        // Replaced as a set; the trigger refuses once something is dispensed.
        await db.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id));
        await db.insert(prescriptionItems).values(items(row.tenantId, id, next));
      }
      await this.audit(db, auth, 'prescription.updated', 'prescription', id, { fields: Object.keys(input) });
      return this.view(db, await this.row(db, id));
    });
  }

  void(auth: AuthContext, id: string, input: VoidPrescriptionInput) {
    return this.mutate(auth, async (db) => {
      const row = await this.row(db, id, true);
      this.assertCan(auth, 'pharmacy.dispense', { branchId: row.branchId, legalEntityId: row.legalEntityId });
      await assertPharmacy(db);
      if (row.voidedAt) return this.view(db, row);
      await db.update(prescriptions).set({ voidedAt: sql`now()`, voidedBy: auth.userId, voidReason: input.reason, updatedBy: auth.userId, updatedAt: sql`now()` }).where(eq(prescriptions.id, id));
      await this.audit(db, auth, 'prescription.voided', 'prescription', id);
      return this.view(db, await this.row(db, id));
    });
  }

  private async view(db: Database, p: PrescriptionRow) {
    const [list, { rows: fills }, [branch]] = [
      await db.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, p.id)).orderBy(prescriptionItems.lineNo),
      await db.execute<FillRow>(sql`
        SELECT f.id, f.prescription_item_id, f.sale_id, s.sale_number, r.code AS register_code, f.quantity::text, u.display_name AS dispensed_by_name,
               f.needs_review, f.sale_return_line_id IS NOT NULL AS returned, f.created_at
          FROM prescription_fills f JOIN sales s ON s.id = f.sale_id JOIN registers r ON r.id = s.register_id
          LEFT JOIN users u ON u.id = f.dispensed_by
         WHERE f.prescription_id = ${p.id} ORDER BY f.created_at, f.id`),
      await db.select({ name: branches.name }).from(branches).where(eq(branches.id, p.branchId)),
    ];
    const [customer] = p.customerId ? await db.select({ name: customers.displayName }).from(customers).where(eq(customers.id, p.customerId)) : [];
    const itemsOut = list.map((i) => {
      const dispensed = fills.filter((f) => f.prescription_item_id === i.id).reduce((a, f) => a.plus(f.quantity), new Dec(0));
      return {
        id: i.id, lineNo: i.lineNo, genericName: i.genericName, strength: i.strength, dosageForm: i.dosageForm, drugClass: i.drugClass, directions: i.directions,
        quantity: toDec(i.quantity).toString(), dispensed: dispensed.toString(), left: Dec.max(toDec(i.quantity).minus(dispensed), 0).toString(),
      };
    });
    const prescribed = itemsOut.reduce((a, i) => a.plus(i.quantity), new Dec(0));
    const dispensed = itemsOut.reduce((a, i) => a.plus(i.dispensed), new Dec(0));
    return {
      id: p.id, branchId: p.branchId, branchName: branch?.name ?? null, legalEntityId: p.legalEntityId, customerId: p.customerId, customerName: customer?.name ?? null,
      patientName: p.patientName, patientAddress: p.patientAddress, prescriberName: p.prescriberName, prescriberLicenseNo: p.prescriberLicenseNo,
      prescriberS2No: p.prescriberS2No, yellowFormNo: p.yellowFormNo, issuedOn: p.issuedOn, notes: p.notes, source: p.source,
      createdAt: p.createdAt, voidedAt: p.voidedAt, voidReason: p.voidReason,
      status: statusOf(p.voidedAt, prescribed, dispensed),
      // Once something is dispensed the prescription no longer changes (trigger).
      editable: !p.voidedAt && fills.length === 0,
      items: itemsOut,
      fills: fills.map((f) => ({
        id: f.id, itemId: f.prescription_item_id, saleId: f.sale_id, saleNumber: f.sale_number, reference: `${f.register_code}-${String(f.sale_number).padStart(6, '0')}`,
        quantity: toDec(f.quantity).toString(), dispensedBy: f.dispensed_by_name, needsReview: f.needs_review, returned: f.returned, at: new Date(f.created_at).toISOString(),
      })),
    };
  }

  private async row(db: Database, id: string, lock = false) {
    const q = db.select().from(prescriptions).where(eq(prescriptions.id, id));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw notFound('Prescription');
    return row;
  }

  private canSee(auth: AuthContext, scope: { branchId: string; legalEntityId: string }) {
    return this.can(auth, 'pharmacy.read', scope) || this.can(auth, 'pharmacy.dispense', scope);
  }

  private assertSee(auth: AuthContext, p: PrescriptionRow) {
    if (!this.canSee(auth, { branchId: p.branchId, legalEntityId: p.legalEntityId })) this.assertCan(auth, 'pharmacy.read', { branchId: p.branchId, legalEntityId: p.legalEntityId });
  }

  private async activeCustomer(db: Database, customerId: string) {
    const [c] = await db.select({ id: customers.id, anonymisedAt: customers.anonymisedAt }).from(customers).where(eq(customers.id, customerId));
    if (!c || c.anonymisedAt) throw notFound('Customer');
  }

  // ---------------------------------------------------------------- the pharmacist's approval at the till

  /**
   * A pharmacist approves prescription medicines for a cashier who may not dispense (ADR-0025 §6), like a
   * price override: without credentials the person asking must hold `pharmacy.dispense` there (SELF); with
   * them the pharmacist signs in on the spot, outside the business transaction, and their own grants in
   * this business must include it. Dangerous drugs also need `pharmacy.dangerous_drugs` and a licence in
   * force. Used once by the cashier's next sale within 30 minutes. Refusals are audited.
   */
  async createApproval(auth: AuthContext, input: CreateDispenseApprovalInput) {
    const scope = await this.read(auth, async (db) => {
      const [branch] = await db.select().from(branches).where(eq(branches.id, input.branchId));
      if (!branch) throw notFound('Branch');
      await assertPharmacy(db);
      return { branchId: branch.id, legalEntityId: branch.legalEntityId };
    });
    this.assertCan(auth, 'sales.create', scope);
    const tenantId = tenantOf(auth).tenantId;
    let approver: { userId: string; membershipId: string | null; method: 'SELF' | 'CREDENTIALS'; grants: Parameters<typeof hasPermission>[0] };
    if (input.email === undefined) {
      if (!this.can(auth, 'pharmacy.dispense', scope)) {
        throw new AppError('APPROVAL_REQUIRED', 'A pharmacist must approve prescription medicines', HttpStatus.FORBIDDEN, { missing: ['pharmacy.dispense'] });
      }
      approver = { userId: auth.userId, membershipId: tenantOf(auth).membershipId, method: 'SELF', grants: tenantOf(auth).grants };
    } else {
      let userId: string;
      try {
        userId = await this.authService.verifySecondPerson(input.email, input.password!, input.code);
      } catch (e) {
        if (e instanceof AppError) await this.refused(auth, input.branchId, e.code);
        throw e;
      }
      const membership = (await this.authService.memberships(userId)).find((m) => m.tenantId === tenantId);
      const grants = membership ? await loadGrants(this.database.pool, tenantId, membership.membershipId, userId) : [];
      if (!hasPermission(grants, 'pharmacy.dispense', scope)) {
        await this.refused(auth, input.branchId, 'APPROVER_NOT_ALLOWED', userId);
        throw new AppError('APPROVER_NOT_ALLOWED', 'This person cannot dispense prescription medicines at this branch', HttpStatus.FORBIDDEN);
      }
      approver = { userId, membershipId: membership!.membershipId, method: userId === auth.userId ? 'SELF' : 'CREDENTIALS', grants };
    }
    return this.mutate(auth, async (db) => {
      const allowsDangerous = hasPermission(approver.grants, 'pharmacy.dangerous_drugs', scope) && (await hasValidLicence(db, approver.membershipId, scope.branchId));
      const now = await dbNow(db);
      const [row] = await db.insert(dispenseApprovals).values({
        tenantId, branchId: scope.branchId, requestedBy: auth.userId, approvedBy: approver.userId, approvalMethod: approver.method, allowsDangerous,
        createdAt: now, expiresAt: new Date(now.getTime() + DISPENSE_APPROVAL_TTL_MINUTES * 60_000),
      }).returning();
      await this.audit(db, auth, 'pharmacy.dispense_approved', 'dispense_approval', row!.id, { branchId: scope.branchId, approvedBy: approver.userId, method: approver.method, allowsDangerous });
      const [name] = await db.execute<{ display_name: string }>(sql`SELECT display_name FROM users WHERE id = ${approver.userId}`).then((r) => r.rows);
      return { id: row!.id, branchId: row!.branchId, approvedBy: row!.approvedBy, approvedByName: name?.display_name ?? null, approvalMethod: row!.approvalMethod, allowsDangerous, expiresAt: row!.expiresAt };
    });
  }

  private async refused(auth: AuthContext, branchId: string, code: string, approverId?: string) {
    await this.tenantDb.run(auth, (db) => this.audit(db, auth, 'pharmacy.dispense_approval_refused', 'branch', branchId, { code, ...(approverId && { approverId }) }));
  }

  // ---------------------------------------------------------------- pharmacist licences and settings

  /** Members and their pharmacist licences (`pharmacy.setup`, or `members.read` to look). */
  listPharmacists(auth: AuthContext) {
    if (!tenantOf(auth).grants.some((g) => g.permission === 'pharmacy.setup' || g.permission === 'members.read')) this.assertHolds(auth, 'pharmacy.setup');
    return this.read(auth, async (db) => {
      const { rows } = await db.execute<{ membership_id: string; display_name: string; status: string; license_no: string | null; valid_until: string | null; dispenses_dangerous: boolean }>(sql`
        SELECT m.id AS membership_id, u.display_name, m.status, l.license_no, l.valid_until::text,
               EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                        WHERE mr.membership_id = m.id AND rp.permission_code = 'pharmacy.dangerous_drugs') AS dispenses_dangerous
          FROM tenant_memberships m JOIN users u ON u.id = m.user_id
          LEFT JOIN pharmacist_licenses l ON l.membership_id = m.id
         WHERE m.status = 'ACTIVE'
         ORDER BY u.display_name`);
      return {
        data: rows.map((r) => ({
          membershipId: r.membership_id, name: r.display_name, licenseNo: r.license_no, validUntil: r.valid_until, dispensesDangerousDrugs: r.dispenses_dangerous,
        })),
      };
    });
  }

  setLicence(auth: AuthContext, membershipId: string, input: PharmacistLicenseInput) {
    this.assertCan(auth, 'pharmacy.setup');
    return this.mutate(auth, async (db) => {
      const { rows: [m] } = await db.execute<{ id: string }>(sql`SELECT id FROM tenant_memberships WHERE id = ${membershipId}`);
      if (!m) throw notFound('Member');
      await db.insert(pharmacistLicenses)
        .values({ tenantId: tenantOf(auth).tenantId, membershipId, licenseNo: input.licenseNo, validUntil: input.validUntil ?? null, updatedBy: auth.userId })
        .onConflictDoUpdate({ target: [pharmacistLicenses.tenantId, pharmacistLicenses.membershipId], set: { licenseNo: input.licenseNo, validUntil: input.validUntil ?? null, updatedBy: auth.userId, updatedAt: sql`now()` } });
      // Personal data: the field names only.
      await this.audit(db, auth, 'pharmacist_license.updated', 'membership', membershipId, { fields: Object.keys(input) });
      const [row] = await db.select().from(pharmacistLicenses).where(eq(pharmacistLicenses.membershipId, membershipId));
      return { membershipId, licenseNo: row!.licenseNo, validUntil: row!.validUntil };
    });
  }

  /** Business-wide: whoever reads, dispenses or sets up the pharmacy anywhere may look. */
  getSettings(auth: AuthContext) {
    if (!tenantOf(auth).grants.some((g) => g.permission === 'pharmacy.read' || g.permission === 'pharmacy.dispense')) this.assertHolds(auth, 'pharmacy.setup');
    return this.read(auth, async (db) => settingsView(db));
  }

  setSettings(auth: AuthContext, input: PharmacySettingsInput) {
    this.assertCan(auth, 'pharmacy.setup');
    return this.mutate(auth, async (db) => {
      await db.insert(pharmacySettings)
        .values({ tenantId: tenantOf(auth).tenantId, requirePurchaseBooklet: input.requirePurchaseBooklet, updatedBy: auth.userId })
        .onConflictDoUpdate({ target: pharmacySettings.tenantId, set: { requirePurchaseBooklet: input.requirePurchaseBooklet, updatedBy: auth.userId, updatedAt: sql`now()` } });
      await this.audit(db, auth, 'pharmacy.settings_updated', 'tenant', tenantOf(auth).tenantId, { ...input });
      return settingsView(db);
    });
  }

  /** A customer's prescriptions with something left (the till offers them for a refill); 404 for a customer not on record. */
  async openForCustomer(auth: AuthContext, customerId: string, branchId?: string) {
    await this.read(auth, async (db) => {
      const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId));
      if (!c) throw notFound('Customer');
    });
    return this.list(auth, { customerId, ...(branchId && { branchId }), open: true, limit: 50 });
  }
}

async function settingsView(db: Database) {
  const [s] = await db.select().from(pharmacySettings);
  return { requirePurchaseBooklet: s?.requirePurchaseBooklet ?? true, updatedAt: s?.updatedAt ?? null };
}

function statusOf(voidedAt: unknown, prescribed: Dec, dispensed: Dec): 'VOIDED' | 'OPEN' | 'PARTLY_FILLED' | 'FILLED' {
  if (voidedAt) return 'VOIDED';
  if (dispensed.isZero()) return 'OPEN';
  return dispensed.gte(prescribed) ? 'FILLED' : 'PARTLY_FILLED';
}

function fields(input: Partial<CreatePrescriptionInput>) {
  const out: Partial<typeof prescriptions.$inferInsert> = {};
  if (input.customerId !== undefined) out.customerId = input.customerId ?? null;
  if (input.patientName !== undefined) out.patientName = input.patientName;
  if (input.patientAddress !== undefined) out.patientAddress = input.patientAddress ?? null;
  if (input.prescriberName !== undefined) out.prescriberName = input.prescriberName;
  if (input.prescriberLicenseNo !== undefined) out.prescriberLicenseNo = input.prescriberLicenseNo;
  if (input.prescriberS2No !== undefined) out.prescriberS2No = input.prescriberS2No ?? null;
  if (input.yellowFormNo !== undefined) out.yellowFormNo = input.yellowFormNo ?? null;
  if (input.issuedOn !== undefined) out.issuedOn = input.issuedOn;
  if (input.notes !== undefined) out.notes = input.notes ?? null;
  return out;
}

function items(tenantId: string, prescriptionId: string, list: CreatePrescriptionInput['items']) {
  return list.map((it, i) => ({
    tenantId, prescriptionId, lineNo: i + 1, genericName: it.genericName, strength: it.strength ?? null, dosageForm: it.dosageForm, quantity: it.quantity,
    drugClass: it.drugClass, directions: it.directions ?? null,
  }));
}

