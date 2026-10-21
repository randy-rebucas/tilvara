import { HttpStatus } from '@nestjs/common';
import { customers, dispenseApprovals, eq, inArray, pharmacySettings, prescriptionFills, prescriptionItems, prescriptions, sql, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { needsPrescription, type LinePrescriptionInput, type PermissionCode, type SalePrescriptionInput } from '@1pos/validation';
import { assertPharmacy } from '../billing/entitlements.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { unprocessable } from '../tax/tax.service.js';
import { drugsOf, genericKey, piecesPerUnit, type DrugInfo } from './drugs.js';

/** The per-item lock the fill trigger takes too (ADR-0025 §6): one item's fills are counted one sale at a time. */
export const lockPrescriptionItem = (db: Database, itemId: string) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`rx-item:${itemId}`}, 0))`);

/**
 * A member's pharmacist licence in force today at the branch (needed to dispense dangerous drugs): the
 * branch's calendar date, not the database server's, so a licence ending today still counts until local midnight.
 */
export async function hasValidLicence(db: Database, membershipId: string | null, branchId: string): Promise<boolean> {
  if (!membershipId) return false;
  const { rows } = await db.execute(sql`
    SELECT 1 FROM pharmacist_licenses l, branches b
     WHERE l.membership_id = ${membershipId} AND b.id = ${branchId}
       AND (l.valid_until IS NULL OR l.valid_until >= (now() AT TIME ZONE b.timezone)::date)`);
  return rows.length > 0;
}

export interface DispenseContext {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  userId: string;
  membershipId: string | null;
  /** An offline sale (ADR-0025 §6): recorded and flagged for review rather than refused; never a dangerous drug. */
  offline: boolean;
  can: (perm: PermissionCode) => boolean;
}

export interface DispenseLine {
  variantId: string;
  quantity: string;
  name: string;
  prescription?: LinePrescriptionInput | undefined;
}

interface PlannedFill {
  index: number;
  variantId: string;
  target: { itemId: string } | { prescriptionRef: string; itemRef: string };
  pieces: Dec;
  piecesPerUnit: Dec;
  needsReview: boolean;
}

export interface DispensePlan {
  drugs: Map<string, DrugInfo>;
  newPrescriptions: SalePrescriptionInput[];
  fills: PlannedFill[];
  dispensedBy: string;
  approvalId: string | null;
  /** Something did not check out on an offline sale: the pharmacist reviews it (PRESCRIPTION_REVIEW). */
  review: boolean;
}

const lineError = (code: string, message: string, index: number, extra: Record<string, unknown> = {}) =>
  unprocessable(code, message, { line: index, path: ['lines', index, 'prescription'], ...extra });

/**
 * The prescriptions a sale's lines fill (ADR-0025 §6), checked before anything is written. Every line of
 * an RX, ANTIBIOTIC or DANGEROUS medicine names a prescription item (on record, or recorded with this sale)
 * whose generic name, strength and form are the medicine's, with enough left; a dangerous drug is filled
 * once, in full, from a yellow prescription. The dispenser may dispense (and, for a dangerous drug, has a
 * licence in force), or a pharmacist approved at the till. Online, anything wrong refuses the sale;
 * offline, it is recorded and flagged, except a dangerous drug, which is refused (the delivery is quarantined).
 */
export async function planDispensing(
  db: Database,
  ctx: DispenseContext,
  lines: readonly DispenseLine[],
  input: { prescriptions: readonly SalePrescriptionInput[]; dispenseApprovalId?: string | undefined; customerId?: string | null },
): Promise<DispensePlan> {
  const drugs = await drugsOf(db, lines.map((l) => l.variantId));
  const plan: DispensePlan = { drugs, newPrescriptions: [...input.prescriptions], fills: [], dispensedBy: ctx.userId, approvalId: null, review: false };
  const asked = lines.map((l, index) => ({ l, index, drug: drugs.get(l.variantId) })).filter(({ l, drug }) => l.prescription || needsPrescription(drug?.drugClass));
  // Prescriptions, approvals and prescription medicines belong to a pharmacy (ADR-0025): another type is
  // refused online (an OTC-only sale never gets here); an offline sale is never refused for it (ADR-0015).
  if (!ctx.offline && (asked.length || input.prescriptions.length || input.dispenseApprovalId)) await assertPharmacy(db);
  if (!asked.length) {
    if (input.prescriptions.length && !ctx.offline) throw unprocessable('PRESCRIPTION_UNUSED', 'No line of this sale fills the prescription recorded with it');
    return plan;
  }
  const dangerous = asked.some(({ drug }) => drug?.drugClass === 'DANGEROUS');
  if (dangerous && ctx.offline) throw unprocessable('DANGEROUS_DRUG_OFFLINE', 'A dangerous drug is dispensed online only, by a pharmacist');

  if (input.prescriptions.some((p) => p.customerId)) {
    const ids = [...new Set(input.prescriptions.flatMap((p) => (p.customerId ? [p.customerId] : [])))];
    const found = await db.select({ id: customers.id, anonymisedAt: customers.anonymisedAt }).from(customers).where(inArray(customers.id, ids));
    if (found.length !== ids.length || found.some((c) => c.anonymisedAt)) throw new AppError('NOT_FOUND', 'Customer not found', HttpStatus.NOT_FOUND, { path: ['prescriptions'] });
  }

  // Items on record: locked (in id order) and counted once.
  const existingIds = [...new Set(asked.flatMap(({ l }) => (l.prescription && 'itemId' in l.prescription ? [l.prescription.itemId] : [])))].sort();
  for (const id of existingIds) await lockPrescriptionItem(db, id);
  const existing = existingIds.length
    ? (await db.execute<{ id: string; generic_key: string; quantity: string; drug_class: string; legal_entity_id: string; voided_at: string | null; filled: string; s2: string | null; yellow: string | null }>(sql`
        SELECT i.id, i.generic_key, i.quantity::text, i.drug_class, p.legal_entity_id, p.voided_at::text, p.prescriber_s2_no AS s2, p.yellow_form_no AS yellow,
               coalesce((SELECT sum(f.quantity) FROM prescription_fills f WHERE f.prescription_item_id = i.id), 0)::text AS filled
          FROM prescription_items i JOIN prescriptions p ON p.tenant_id = i.tenant_id AND p.id = i.prescription_id
         WHERE i.id IN (${sql.join(existingIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows
    : [];
  const fresh = new Map<string, { it: SalePrescriptionInput['items'][number]; rx: SalePrescriptionInput }>(input.prescriptions.flatMap((p) => p.items.map((it) => [`${p.ref}/${it.ref}`, { it, rx: p }] as const)));

  const per = await piecesPerUnit(db, asked.map(({ l }) => l.variantId));
  const used = new Map<string, Dec>();
  for (const { l, index, drug } of asked) {
    const target = l.prescription;
    if (!target) {
      if (!ctx.offline) throw lineError('PRESCRIPTION_REQUIRED', `${l.name} needs a prescription`, index);
      plan.review = true;
      continue;
    }
    const key = 'itemId' in target ? target.itemId : `${target.prescriptionRef}/${target.itemRef}`;
    // An item on record that cannot be filled: refused online; offline the sale is recorded, the line
    // fills nothing and the pharmacist reviews it (§6: never refused offline).
    const unusable = 'itemId' in target
      ? (() => {
          const r = existing.find((x) => x.id === target.itemId);
          if (!r) return new AppError('NOT_FOUND', 'Prescription item not found', HttpStatus.NOT_FOUND, { line: index });
          if (r.voided_at) return lineError('PRESCRIPTION_VOIDED', 'This prescription was voided', index);
          if (r.legal_entity_id !== ctx.legalEntityId) return lineError('WRONG_LEGAL_ENTITY', 'This prescription was recorded by another company of the business', index);
          return null;
        })()
      : null;
    if (unusable) {
      if (!ctx.offline) throw unusable;
      plan.review = true;
      continue;
    }
    const item = 'itemId' in target
      ? (() => {
          const r = existing.find((x) => x.id === target.itemId)!;
          return { genericKey: r.generic_key, quantity: toDec(r.quantity), drugClass: r.drug_class, filled: toDec(r.filled), forms: Boolean(r.s2 && r.yellow) };
        })()
      : (() => {
          const f = fresh.get(key)!;
          return { genericKey: genericKey(f.it.genericName, f.it.strength, f.it.dosageForm), quantity: toDec(f.it.quantity), drugClass: f.it.drugClass, filled: new Dec(0), forms: Boolean(f.rx.prescriberS2No && f.rx.yellowFormNo) };
        })();
    const pieces = toDec(l.quantity).times(per.get(l.variantId) ?? 1);
    const mismatch = !drug || drug.genericKey !== item.genericKey || (drug.drugClass === 'DANGEROUS' && (item.drugClass !== 'DANGEROUS' || !item.forms));
    if (mismatch) {
      if (!ctx.offline) {
        throw lineError('PRESCRIPTION_MISMATCH', drug ? `${l.name} is not what this prescription orders (${drug.label})` : `${l.name} is not a medicine`, index);
      }
      plan.review = true;
      continue;
    }
    const before = item.filled.plus(used.get(key) ?? 0);
    if (item.drugClass === 'DANGEROUS' && (!before.isZero() || !pieces.equals(item.quantity))) {
      throw lineError('DANGEROUS_DRUG_FULL_FILL', `A dangerous drug is dispensed once, in full: ${item.quantity.toString()} as prescribed`, index, { prescribed: item.quantity.toString() });
    }
    const over = before.plus(pieces).gt(item.quantity);
    if (over && !ctx.offline) {
      throw lineError('PRESCRIPTION_EXCEEDED', `More than the prescription allows: ${Dec.max(item.quantity.minus(before), 0).toString()} left`, index, { left: Dec.max(item.quantity.minus(before), 0).toString() });
    }
    if (over) plan.review = true;
    used.set(key, (used.get(key) ?? new Dec(0)).plus(pieces));
    plan.fills.push({ index, variantId: l.variantId, target, pieces, piecesPerUnit: per.get(l.variantId) ?? new Dec(1), needsReview: over });
  }
  // Who dispenses (once the lines check out):  the cashier when they may, else the pharmacist who approved at the till.
  const selfOk = ctx.can('pharmacy.dispense') && (!dangerous || (ctx.can('pharmacy.dangerous_drugs') && (await hasValidLicence(db, ctx.membershipId, ctx.branchId))));
  if (!selfOk) {
    if (input.dispenseApprovalId && !ctx.offline) {
      const [a] = await db.select().from(dispenseApprovals).where(eq(dispenseApprovals.id, input.dispenseApprovalId)).for('update');
      const { rows: [now] } = await db.execute<{ ok: boolean }>(sql`SELECT ${a?.expiresAt ?? new Date(0)}::timestamptz > now() AS ok`);
      if (!a || a.branchId !== ctx.branchId || a.requestedBy !== ctx.userId || a.saleId || !now?.ok) {
        throw new AppError('DISPENSE_APPROVAL_INVALID', 'This pharmacist approval was used, has expired or is not for this till; ask again', HttpStatus.CONFLICT);
      }
      if (dangerous && !a.allowsDangerous) {
        throw new AppError('DISPENSE_APPROVAL_INVALID', 'The pharmacist who approved may not dispense dangerous drugs', HttpStatus.FORBIDDEN);
      }
      plan.dispensedBy = a.approvedBy;
      plan.approvalId = a.id;
    } else if (ctx.offline) {
      plan.review = true;
    } else {
      throw new AppError('DISPENSE_APPROVAL_REQUIRED', dangerous ? 'A pharmacist with a licence on record must dispense dangerous drugs' : 'A pharmacist must approve prescription medicines', HttpStatus.FORBIDDEN, {
        missing: [dangerous ? 'pharmacy.dangerous_drugs' : 'pharmacy.dispense'],
      });
    }
  }

  return plan;
}

/** Write the prescriptions recorded with the sale, its fills, and use the approval (in `record()`, after the lines). */
export async function recordDispensing(db: Database, ctx: DispenseContext, plan: DispensePlan, saleId: string, lineIds: readonly string[]) {
  const itemIds = new Map<string, string>();
  const prescriptionOf = new Map<string, string>();
  for (const p of plan.newPrescriptions) {
    const [row] = await db.insert(prescriptions).values({
      tenantId: ctx.tenantId, legalEntityId: ctx.legalEntityId, branchId: ctx.branchId, customerId: p.customerId ?? null,
      patientName: p.patientName, patientAddress: p.patientAddress ?? null, prescriberName: p.prescriberName, prescriberLicenseNo: p.prescriberLicenseNo,
      prescriberS2No: p.prescriberS2No ?? null, yellowFormNo: p.yellowFormNo ?? null, issuedOn: p.issuedOn, notes: p.notes ?? null,
      source: ctx.offline ? 'OFFLINE' : 'COUNTER', createdBy: ctx.userId,
    }).returning({ id: prescriptions.id });
    const items = await db.insert(prescriptionItems).values(p.items.map((it, i) => ({
      tenantId: ctx.tenantId, prescriptionId: row!.id, lineNo: i + 1, genericName: it.genericName, strength: it.strength ?? null, dosageForm: it.dosageForm,
      quantity: it.quantity, drugClass: it.drugClass, directions: it.directions ?? null,
    }))).returning({ id: prescriptionItems.id, lineNo: prescriptionItems.lineNo });
    for (const it of items) {
      const ref = `${p.ref}/${p.items[it.lineNo - 1]!.ref}`;
      itemIds.set(ref, it.id);
      prescriptionOf.set(it.id, row!.id);
    }
  }
  const knownIds = plan.fills.flatMap((f) => ('itemId' in f.target ? [f.target.itemId] : []));
  if (knownIds.length) {
    const rows = await db.select({ id: prescriptionItems.id, prescriptionId: prescriptionItems.prescriptionId }).from(prescriptionItems).where(inArray(prescriptionItems.id, knownIds));
    for (const r of rows) prescriptionOf.set(r.id, r.prescriptionId);
  }
  // Items in id order: the trigger's per-item locks are taken in a stable order.
  const fills = plan.fills
    .map((f) => ({ f, itemId: 'itemId' in f.target ? f.target.itemId : itemIds.get(`${f.target.prescriptionRef}/${f.target.itemRef}`)! }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : a.f.index - b.f.index));
  if (fills.length) {
    await db.insert(prescriptionFills).values(fills.map(({ f, itemId }) => ({
      tenantId: ctx.tenantId, prescriptionId: prescriptionOf.get(itemId)!, prescriptionItemId: itemId, branchId: ctx.branchId, saleId, saleLineId: lineIds[f.index]!,
      variantId: f.variantId, quantity: f.pieces.toString(), piecesPerUnit: f.piecesPerUnit.toString(), dispensedBy: plan.dispensedBy, approvalId: plan.approvalId,
      needsReview: f.needsReview,
    })));
  }
  if (plan.approvalId) await db.update(dispenseApprovals).set({ saleId }).where(eq(dispenseApprovals.id, plan.approvalId));
  return { prescriptions: plan.newPrescriptions.length, fills: fills.length };
}

/**
 * What a return or void of filled lines gives back to their prescriptions (ADR-0025 §6): the pieces of
 * the units returned, at most what the line still has filled; the item can be filled again.
 */
export async function returnFills(db: Database, ctx: { tenantId: string; userId: string }, returned: readonly { saleLineId: string; saleReturnLineId: string; quantity: Dec }[]) {
  if (!returned.length) return 0;
  const { rows } = await db.execute<{ sale_line_id: string; prescription_id: string; prescription_item_id: string; branch_id: string; sale_id: string; variant_id: string; pieces_per_unit: string; net: string }>(sql`
    SELECT sale_line_id, prescription_id, prescription_item_id, branch_id, sale_id, variant_id, max(pieces_per_unit)::text AS pieces_per_unit, sum(quantity)::text AS net
      FROM prescription_fills WHERE sale_line_id IN (${sql.join(returned.map((r) => sql`${r.saleLineId}::uuid`), sql`, `)})
     GROUP BY 1, 2, 3, 4, 5, 6 HAVING sum(quantity) > 0
     ORDER BY prescription_item_id`);
  const values = rows.flatMap((r) => {
    const back = returned.find((x) => x.saleLineId === r.sale_line_id)!;
    const pieces = Dec.min(back.quantity.times(r.pieces_per_unit), toDec(r.net));
    return pieces.gt(0)
      ? [{ tenantId: ctx.tenantId, prescriptionId: r.prescription_id, prescriptionItemId: r.prescription_item_id, branchId: r.branch_id, saleId: r.sale_id, saleLineId: r.sale_line_id,
           saleReturnLineId: back.saleReturnLineId, variantId: r.variant_id, quantity: pieces.negated().toString(), piecesPerUnit: r.pieces_per_unit, dispensedBy: ctx.userId }]
      : [];
  });
  if (values.length) await db.insert(prescriptionFills).values(values);
  return values.length;
}

/**
 * SC/PWD on medicines (ADR-0025 §8): for each beneficiary whose discounted lines include a medicine,
 * whether the purchase booklet was presented (refused without it when the business requires it); null
 * for a beneficiary with no medicine.
 */
export async function bookletOf(
  db: Database,
  beneficiaries: readonly { ref: string; purchaseBooklet?: boolean | undefined }[],
  lines: readonly { variantId: string; beneficiaryRef: string | null }[],
  drugs: Map<string, DrugInfo>,
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  let required: boolean | undefined;
  for (const b of beneficiaries) {
    const medicine = lines.some((l) => l.beneficiaryRef === b.ref && drugs.has(l.variantId));
    if (!medicine) {
      out.set(b.ref, null);
      continue;
    }
    if (required === undefined) {
      const [s] = await db.select({ require: pharmacySettings.requirePurchaseBooklet }).from(pharmacySettings);
      required = s?.require ?? true;
    }
    if (required && !b.purchaseBooklet) throw unprocessable('PURCHASE_BOOKLET_REQUIRED', 'A senior citizen or PWD discount on medicine needs the purchase booklet', { beneficiary: b.ref });
    out.set(b.ref, b.purchaseBooklet ?? false);
  }
  return out;
}
