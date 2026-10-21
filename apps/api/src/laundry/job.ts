import { randomInt } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import {
  and,
  eq,
  inArray,
  jobOrderItems,
  jobOrderLines,
  jobOrders,
  jobOrderStatusChanges,
  jobOrderTrips,
  laundrySettings,
  productVariants,
  sql,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { JobOrderLineInput } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import type { TaxService } from '../tax/tax.service.js';
import { unprocessable } from '../tax/tax.service.js';

export type JobRow = typeof jobOrders.$inferSelect;
export type JobLineRow = typeof jobOrderLines.$inferSelect;
export type LaundrySettingsRow = Awaited<ReturnType<typeof branchLaundrySettings>>;

export const OPEN_STATUSES = ['RECEIVED', 'WASHING', 'DRYING', 'FOLDING', 'READY', 'OUT_FOR_DELIVERY'] as const;
export const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

/** The lock the down-payment trigger takes too (migration 0104): one job's down payments one at a time. */
export const lockJobDeposits = (db: Database, jobId: string) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job-deposit:${jobId}`}, 0))`);
/** One machine's runs are planned one at a time (the exclusion constraint is the backstop). */
export const lockMachine = (db: Database, machineId: string) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`machine:${machineId}`}, 0))`);

export const jobNumber = (n: number) => `J-${String(n).padStart(6, '0')}`;

/** Six characters without look-alikes (no 0/O, 1/I/L): what the stub prints and the counter types. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export async function newClaimCode(db: Database): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM job_orders WHERE claim_code = ${code}`);
    if (Number(rows[0]!.n) === 0) return code;
  }
  throw new AppError('SERVICE_UNAVAILABLE', 'Could not make a claim code; try again', HttpStatus.SERVICE_UNAVAILABLE);
}

/** A branch's laundry settings, with the defaults when none were saved (§3, §6, §9). */
export async function branchLaundrySettings(db: Database, branchId: string) {
  const [row] = await db.select().from(laundrySettings).where(eq(laundrySettings.branchId, branchId));
  return {
    branchId,
    regularHours: row?.regularHours ?? 48,
    expressHours: row?.expressHours ?? 6,
    expressVariantId: row?.expressVariantId ?? null,
    deliveryVariantId: row?.deliveryVariantId ?? null,
    storageFeeVariantId: row?.storageFeeVariantId ?? null,
    storageFreeDays: row?.storageFreeDays ?? null,
    unclaimedDays: row?.unclaimedDays ?? 30,
    finalNoticeDays: row?.finalNoticeDays ?? 3,
    reminderDays: row?.reminderDays ?? [3, 7],
    claimPolicyText: row?.claimPolicyText ?? null,
    smsEnabled: row?.smsEnabled ?? false,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function loadJob(db: Database, id: string, lock = false): Promise<JobRow> {
  const q = db.select().from(jobOrders).where(eq(jobOrders.id, id));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound('Job order');
  return row;
}

export const jobScope = (j: { branchId: string; legalEntityId: string }) => ({ branchId: j.branchId, legalEntityId: j.legalEntityId });

export const jobEnded = (j: JobRow) => new AppError('JOB_ORDER_ENDED', `This job order is ${j.status.toLowerCase()}`, HttpStatus.CONFLICT, { status: j.status });

/** What a job holds in down payments (Σ RECEIVED − APPLIED − REFUNDED − FORFEITED). */
export async function depositsHeld(db: Database, jobId: string): Promise<Dec> {
  const { rows } = await db.execute<{ v: string }>(sql`SELECT coalesce(sum(amount), 0)::text AS v FROM job_order_deposits WHERE job_order_id = ${jobId}`);
  return toDec(rows[0]!.v);
}

export async function recordStatus(db: Database, job: Pick<JobRow, 'tenantId' | 'id'>, from: string | null, to: string, userId: string, note?: string | null) {
  await db.insert(jobOrderStatusChanges).values({ tenantId: job.tenantId, jobOrderId: job.id, fromStatus: from, toStatus: to, note: note ?? null, changedBy: userId });
}

/** Days a READY job has waited beyond the free days (branch calendar, DB clock): what the storage fee charges. */
export async function storageDays(db: Database, job: JobRow, settings: LaundrySettingsRow): Promise<number> {
  if (settings.storageFreeDays === null || !settings.storageFeeVariantId || !job.readyAt) return 0;
  const { rows } = await db.execute<{ d: number }>(sql`
    SELECT ((now() AT TIME ZONE b.timezone)::date - (${job.readyAt.toISOString()}::timestamptz AT TIME ZONE b.timezone)::date)::int AS d
      FROM branches b WHERE b.id = ${job.branchId}`);
  return Math.max(0, Number(rows[0]!.d) - settings.storageFreeDays);
}

type LaundryVariant = { id: string; laundryUnit: string | null; laundryMinQuantity: string | null; machineKind: string | null };

async function laundryVariants(db: Database, ids: string[]): Promise<Map<string, LaundryVariant>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: productVariants.id, laundryUnit: productVariants.laundryUnit, laundryMinQuantity: productVariants.laundryMinQuantity, machineKind: productVariants.machineKind })
    .from(productVariants)
    .where(inArray(productVariants.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** A priced job line, ready to store as `job_order_lines` or to record on the claim sale. */
export interface PricedJobLine {
  variantId: string;
  sku: string;
  name: string;
  taxCategoryCode: string;
  vatTreatment: string;
  laundryUnit: string | null;
  measuredQuantity: string;
  quantity: string;
  unitPrice: string;
  priceIncludesTax: boolean;
  priceId: string;
  priceListId: string;
  trackInventory: boolean;
  productType: string;
  promotionId: string | null;
  customerPackageId: string | null;
  gross: string; discount: string; statutoryDiscount: string; vatExemptionAmount: string; vatableSales: string;
  vatAmount: string; vatExemptSales: string; zeroRatedSales: string; percentageTaxSales: string; amountDue: string;
  taxSnapshot: unknown;
}

export interface PricedJob {
  lines: PricedJobLine[];
  taxProfileId: string;
  taxSnapshot: unknown;
  requiresProfessionalReview: boolean;
  currency: string;
  at: Date;
  amountDue: string;
}

/**
 * Price a job's lines on the tax path (§2): each line billed at least its service's minimum, the
 * branch's express and delivery items added by the server (lines naming them are replaced), package
 * sessions at zero for a per-load or per-piece service of the job's customer. Promotions apply as at
 * the counter. Called when a job is taken in and every time its lines change; the result is frozen.
 */
export async function priceJob(
  tax: TaxService,
  db: Database,
  auth: AuthContext,
  job: { branchId: string; customerId: string | null; serviceLevel: string; deliveryRequested: boolean; weightKg: string | null },
  input: JobOrderLineInput[],
  settings: LaundrySettingsRow,
  extra: { variantId: string; quantity: string }[] = [],
  opts: { auto?: boolean } = {},
): Promise<PricedJob | null> {
  const auto = opts.auto ?? true;
  const autoIds = new Set([settings.expressVariantId, settings.deliveryVariantId].filter((x): x is string => x !== null));
  const given = input.filter((l) => !autoIds.has(l.variantId));
  if (!given.length && !extra.length) return null;
  const variants = await laundryVariants(db, [...given.map((l) => l.variantId), ...autoIds, ...extra.map((e) => e.variantId)]);
  const lines: { variantId: string; measured: string; quantity: string; packageId?: string }[] = given.map((l, i) => {
    const v = variants.get(l.variantId);
    if (!v) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { path: ['lines', i, 'variantId'] });
    if (l.packageId) {
      if (!job.customerId) throw unprocessable('PACKAGE_NEEDS_CUSTOMER', 'A package session needs the customer on the job order', { path: ['lines', i, 'packageId'] });
      if (v.laundryUnit === 'KG') throw new AppError('PACKAGE_NEEDS_WHOLE_UNITS', 'A per-kilo service is not taken from a package', HttpStatus.CONFLICT, { path: ['lines', i, 'packageId'] });
      if (!toDec(l.quantity).isInteger()) throw unprocessable('PACKAGE_NEEDS_WHOLE_UNITS', 'Package sessions are whole loads or pieces', { path: ['lines', i, 'quantity'] });
    }
    const min = v.laundryMinQuantity ? toDec(v.laundryMinQuantity) : null;
    const billed = min && !l.packageId && toDec(l.quantity).lt(min) ? min : toDec(l.quantity);
    return { variantId: l.variantId, measured: toDec(l.quantity).toString(), quantity: billed.toString(), ...(l.packageId && { packageId: l.packageId }) };
  });
  // The express surcharge follows its own unit: per kilo billed (minimums included; the job's weight
  // when no line is per kilo), per load, or once.
  if (auto && job.serviceLevel === 'EXPRESS' && settings.expressVariantId) {
    const unit = variants.get(settings.expressVariantId)?.laundryUnit ?? null;
    const of = (u: string) => lines.filter((l) => variants.get(l.variantId)?.laundryUnit === u).reduce((a, l) => a.plus(l.quantity), new Dec(0));
    const kg = of('KG');
    const q = unit === 'KG' ? (kg.gt(0) ? kg : job.weightKg ? toDec(job.weightKg) : kg) : unit === 'LOAD' ? of('LOAD') : new Dec(1);
    if (q.gt(0)) lines.push({ variantId: settings.expressVariantId, measured: q.toString(), quantity: q.toString() });
  }
  if (auto && job.deliveryRequested && settings.deliveryVariantId) lines.push({ variantId: settings.deliveryVariantId, measured: '1', quantity: '1' });
  for (const e of extra) lines.push({ variantId: e.variantId, measured: e.quantity, quantity: e.quantity });

  const cart = await tax.computeCart(
    db,
    auth,
    { branchId: job.branchId, lines: lines.map((l, i) => ({ id: String(i + 1), variantId: l.variantId, quantity: l.quantity, ...(l.packageId && { packageId: l.packageId }) })) },
    undefined,
    { promotions: true },
  );
  return {
    taxProfileId: cart.taxProfile.id,
    taxSnapshot: cart.taxProfile,
    requiresProfessionalReview: cart.requiresProfessionalReview,
    currency: cart.currency,
    at: new Date(cart.at),
    amountDue: String(cart.totals.amountDue),
    lines: cart.lines.map((l, i) => ({
      variantId: l.variantId,
      sku: l.sku,
      name: l.name,
      taxCategoryCode: l.taxCategoryCode,
      vatTreatment: l.vatTreatment,
      laundryUnit: variants.get(l.variantId)?.laundryUnit ?? null,
      measuredQuantity: lines[i]!.measured,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      priceIncludesTax: l.priceIncludesTax,
      priceId: l.priceId,
      priceListId: l.priceListId,
      trackInventory: l.trackInventory,
      productType: l.productType,
      promotionId: l.promotionId,
      customerPackageId: l.packageId,
      gross: String(l.gross), discount: String(l.discount), statutoryDiscount: String(l.statutoryDiscount), vatExemptionAmount: String(l.vatExemptionAmount),
      vatableSales: String(l.vatableSales), vatAmount: String(l.vatAmount), vatExemptSales: String(l.vatExemptSales), zeroRatedSales: String(l.zeroRatedSales),
      percentageTaxSales: String(l.percentageTaxSales), amountDue: String(l.amountDue),
      taxSnapshot: l.snapshot,
    })),
  };
}

/** Replace a job's lines with a priced set and freeze its total (the caller checked it may). */
export async function storeLines(db: Database, job: JobRow, priced: PricedJob | null, userId: string) {
  await db.delete(jobOrderLines).where(eq(jobOrderLines.jobOrderId, job.id));
  if (priced) {
    await db.insert(jobOrderLines).values(priced.lines.map((l, i) => ({ tenantId: job.tenantId, jobOrderId: job.id, lineNo: i + 1, ...l })));
  }
  const [row] = await db
    .update(jobOrders)
    .set({
      taxProfileId: priced?.taxProfileId ?? null,
      taxSnapshot: priced?.taxSnapshot ?? null,
      requiresProfessionalReview: priced?.requiresProfessionalReview ?? false,
      currency: priced?.currency ?? job.currency,
      pricedAt: priced?.at ?? null,
      amountDue: priced?.amountDue ?? '0',
      updatedBy: userId,
      updatedAt: sql`now()`,
    })
    .where(eq(jobOrders.id, job.id))
    .returning();
  return row!;
}

const money = (v: string | null) => (v === null ? null : toDec(v).toFixed(2));
const MONEY = ['gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount', 'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue', 'unitPrice'] as const;

/** A job order with its lines, items, trips and money (what the board, the ticket and the claim show). */
export async function jobView(db: Database, job: JobRow) {
  const lines = await db.select().from(jobOrderLines).where(eq(jobOrderLines.jobOrderId, job.id)).orderBy(jobOrderLines.lineNo);
  const items = await db.select().from(jobOrderItems).where(eq(jobOrderItems.jobOrderId, job.id));
  const trips = await db.select().from(jobOrderTrips).where(eq(jobOrderTrips.jobOrderId, job.id)).orderBy(jobOrderTrips.createdAt);
  const history = await db.select().from(jobOrderStatusChanges).where(eq(jobOrderStatusChanges.jobOrderId, job.id)).orderBy(jobOrderStatusChanges.changedAt, jobOrderStatusChanges.id);
  const held = await depositsHeld(db, job.id);
  const settings = await branchLaundrySettings(db, job.branchId);
  const { rows: [names] } = await db.execute<{ customer: string | null; branch: string }>(sql`
    SELECT (SELECT display_name FROM customers WHERE id = ${job.customerId}) AS customer, (SELECT name FROM branches WHERE id = ${job.branchId}) AS branch`);
  const { rows: [clock] } = await db.execute<{ overdue: boolean; unclaimed: boolean }>(sql`
    SELECT ${job.promisedAt.toISOString()}::timestamptz < now() AND ${job.status} IN ('RECEIVED','WASHING','DRYING','FOLDING') AS overdue,
           ${job.readyAt?.toISOString() ?? null}::timestamptz + make_interval(days => ${settings.unclaimedDays}) <= now() AND ${job.status} = 'READY' AS unclaimed`);
  const due = toDec(job.amountDue);
  const autoIds = [settings.expressVariantId, settings.deliveryVariantId];
  return {
    ...job,
    reference: jobNumber(job.number),
    branchName: names!.branch,
    customerDisplayName: names!.customer ?? job.customerName,
    weightKg: job.weightKg === null ? null : toDec(job.weightKg).toString(),
    amountDue: money(job.amountDue),
    depositHeld: held.toFixed(2),
    balance: Dec.max(due.minus(held), 0).toFixed(2),
    overdue: Boolean(clock!.overdue),
    unclaimed: Boolean(clock!.unclaimed),
    storageDays: isOpen(job.status) ? await storageDays(db, job, settings) : 0,
    lines: lines.map((l) => {
      const out: Record<string, unknown> = { ...l, measuredQuantity: toDec(l.measuredQuantity).toString(), quantity: toDec(l.quantity).toString(), auto: autoIds.includes(l.variantId) };
      for (const k of MONEY) out[k] = money(l[k]);
      return out;
    }),
    items,
    trips,
    history,
  };
}

/** Lines and items may change only while the job is at the shop and not yet claimed. */
export function assertEditable(job: JobRow) {
  if (!isOpen(job.status)) throw jobEnded(job);
}

export async function insertItems(db: Database, job: JobRow, items: { garmentTypeId?: string | undefined; label?: string | undefined; count: number; note?: string | undefined }[]) {
  await db.delete(jobOrderItems).where(eq(jobOrderItems.jobOrderId, job.id));
  if (!items.length) return;
  const typeIds = items.flatMap((i) => (i.garmentTypeId ? [i.garmentTypeId] : []));
  const { rows: types } = typeIds.length
    ? await db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM laundry_garment_types WHERE id IN (${sql.join(typeIds.map((t) => sql`${t}`), sql`, `)})`)
    : { rows: [] };
  await db.insert(jobOrderItems).values(
    items.map((i, n) => {
      const type = i.garmentTypeId ? types.find((t) => t.id === i.garmentTypeId) : undefined;
      if (i.garmentTypeId && !type) throw new AppError('NOT_FOUND', 'Garment type not found', HttpStatus.NOT_FOUND, { path: ['items', n, 'garmentTypeId'] });
      return { tenantId: job.tenantId, jobOrderId: job.id, garmentTypeId: i.garmentTypeId ?? null, label: i.label ?? type!.name, count: i.count, note: i.note ?? null };
    }),
  );
}

export async function liveTrip(db: Database, jobId: string, kind: 'PICKUP' | 'DELIVERY') {
  const [row] = await db.select().from(jobOrderTrips).where(and(eq(jobOrderTrips.jobOrderId, jobId), eq(jobOrderTrips.kind, kind), eq(jobOrderTrips.status, 'SCHEDULED')));
  return row;
}

/**
 * A self-service cycle sale voided or returned (ADR-0024 §7): its machine run, if not finished, ends.
 * Returned in full, a run still queued is called off (stopped at its start) and a running one stops now;
 * returned in part, the run is cut to the cycles kept (or now, if that time has passed). In the return's
 * transaction (called by ReturnsService.record). Returns the runs changed.
 */
export async function endReturnedCycleRuns(db: Database, saleLineIds: string[], userId: string): Promise<string[]> {
  if (!saleLineIds.length) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    WITH kept AS (
      SELECT l.id, greatest(l.quantity - coalesce((SELECT sum(rl.quantity) FROM sale_return_lines rl WHERE rl.sale_line_id = l.id), 0), 0) / l.quantity AS share
        FROM sale_lines l WHERE l.id IN (${sql.join(saleLineIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND l.quantity > 0)
    UPDATE machine_runs r
       SET stopped_at = greatest(r.started_at, now(), r.started_at + (r.ends_at - r.started_at) * kept.share::float8), stopped_by = ${userId}
      FROM kept
     WHERE r.sale_line_id = kept.id AND r.stopped_at IS NULL AND r.ends_at > now() AND kept.share < 1
       AND greatest(r.started_at, now(), r.started_at + (r.ends_at - r.started_at) * kept.share::float8) < r.ends_at
    RETURNING r.id`);
  return rows.map((r) => r.id);
}
