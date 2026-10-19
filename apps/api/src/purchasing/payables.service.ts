import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { reversalOf, supplierInvoicePosting, supplierPaymentPosting, type PostingLine } from '@1pos/accounting';
import {
  and,
  asc,
  branches,
  eq,
  goodsReceiptLines,
  goodsReceipts,
  inArray,
  journalEntries,
  journalLines,
  legalEntities,
  mapInSequence,
  sql,
  supplierInvoiceReceipts,
  supplierInvoices,
  supplierPayments,
  supplierReturnLines,
  supplierReturns,
  suppliers,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type {
  CancelSupplierInvoiceInput,
  CreateSupplierInvoiceInput,
  CreateSupplierPaymentInput,
  PayablesAgingQuery,
  SupplierInvoiceListQuery,
  UninvoicedReceiptsQuery,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { post } from '../accounting/ledger.js';
import { nextNumber } from '../common/sequence.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { unprocessable } from '../tax/tax.service.js';
import { profilesInForce } from '../tax/tax-profiles.js';
import { branchScope } from './purchase-orders.service.js';

type InvoiceRow = typeof supplierInvoices.$inferSelect;
type Scope = { branchId?: string; legalEntityId: string };

const money = (v: Dec | string) => toDec(v).toFixed(2);
/** Same per-line rounding as the receipt and return postings, so a match clears GRNI to the centavo fraction. */
const lineValue = (quantity: string, cost: string) => toDec(quantity).times(cost).toDecimalPlaces(4);

/** Archived suppliers still invoice and get paid for what they delivered; another tenant's is not found. */
async function findSupplier(db: Database, id: string) {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id));
  if (!row) throw notFound('Supplier');
  return row;
}

/** Branch-local today (the calendar `post()` dates entries by). */
async function localToday(db: Database, timezone: string) {
  const { rows } = await db.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE ${timezone})::date::text AS d`);
  return rows[0]!.d;
}

/**
 * GRNI still held for each receipt: Σ received at cost less Σ credited by returns against it
 * (exactly what the GOODS_RECEIPT and SUPPLIER_RETURN entries put on and took off GRNI).
 */
async function grniHeld(db: Database, receiptIds: string[]) {
  const held = new Map(receiptIds.map((id) => [id, new Dec(0)]));
  if (!receiptIds.length) return held;
  const received = await db
    .select({ receiptId: goodsReceiptLines.goodsReceiptId, quantity: goodsReceiptLines.quantity, unitCost: goodsReceiptLines.unitCost })
    .from(goodsReceiptLines)
    .where(inArray(goodsReceiptLines.goodsReceiptId, receiptIds));
  for (const l of received) held.set(l.receiptId, held.get(l.receiptId)!.plus(lineValue(l.quantity, l.unitCost)));
  const returned = await db
    .select({ receiptId: supplierReturns.goodsReceiptId, quantity: supplierReturnLines.quantity, credit: supplierReturnLines.creditUnitCost })
    .from(supplierReturnLines)
    .innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.supplierReturnId))
    .where(inArray(supplierReturns.goodsReceiptId, receiptIds));
  for (const l of returned) held.set(l.receiptId!, held.get(l.receiptId!)!.minus(lineValue(l.quantity, l.credit)));
  return held;
}

/**
 * Supplier invoices and payments (ADR-0013 amendment, session 16). An invoice covers whole goods
 * receipts of one branch and supplier: it clears their GRNI, claims input VAT when the entity is
 * VAT-registered, and owes the supplier the total; the rest is a purchase price variance. Payments
 * settle it from the bank, never beyond its open balance. Cancelling (only while unpaid) reverses
 * the entry and frees the receipts for another invoice.
 *
 * Entering and cancelling: `purchasing.manage` at the branch or `accounting.post` at the entity.
 * Paying: `accounting.post` at the entity. Reading one: `purchasing.manage` at the branch or
 * `accounting.read` at the entity; lists and aging are entity-wide (`accounting.read`, or
 * `purchasing.manage` for the whole entity).
 */
@Injectable()
export class PayablesService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    supplier_invoices_supplier_ref_unique: ['INVOICE_NUMBER_TAKEN', 'This supplier already has an open invoice with this number'],
    supplier_invoice_receipts_active_unique: ['RECEIPT_ALREADY_INVOICED', 'A goods receipt is already on an open invoice'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  createInvoice(auth: AuthContext, input: CreateSupplierInvoiceInput) {
    return this.mutate(auth, async (db) => {
      const ids = [...input.goodsReceiptIds].sort();
      const receipts = await db.select().from(goodsReceipts).where(inArray(goodsReceipts.id, ids));
      const missing = ids.filter((id) => !receipts.some((r) => r.id === id));
      if (missing.length) throw new AppError('NOT_FOUND', 'Goods receipt not found', HttpStatus.NOT_FOUND, { goodsReceiptIds: missing });
      const supplier = await findSupplier(db, input.supplierId);
      const { branch, scope } = await branchScope(db, receipts[0]!.branchId);
      this.assertEnter(auth, scope);
      const foreign = receipts.filter((r) => r.branchId !== branch.id || r.supplierId !== supplier.id).map((r) => r.id);
      if (foreign.length) throw unprocessable('RECEIPT_MISMATCH', 'Every receipt must be from this supplier and of one branch', { goodsReceiptIds: foreign });
      const today = await localToday(db, branch.timezone);
      if (input.invoiceDate > today) throw unprocessable('DATE_IN_FUTURE', 'The invoice date is after today', { today });

      // The same per-receipt lock supplier returns take, in id order: GRNI held cannot change underneath.
      await mapInSequence(ids, (id) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`));
      const taken = await db
        .select({ id: supplierInvoiceReceipts.goodsReceiptId })
        .from(supplierInvoiceReceipts)
        .where(and(inArray(supplierInvoiceReceipts.goodsReceiptId, ids), eq(supplierInvoiceReceipts.active, true)));
      if (taken.length) {
        throw new AppError('RECEIPT_ALREADY_INVOICED', 'A goods receipt is already on an open invoice', HttpStatus.CONFLICT, { goodsReceiptIds: taken.map((t) => t.id) });
      }
      const held = await grniHeld(db, ids);
      const matched = [...held.values()].reduce((a, v) => a.plus(v), new Dec(0));

      const profile = (await profilesInForce(db, [branch.legalEntityId])).get(branch.legalEntityId);
      if (!profile) throw new AppError('TAX_PROFILE_MISSING', 'The legal entity has no tax profile in force', HttpStatus.CONFLICT);
      const net = toDec(input.netAmount);
      const vat = toDec(input.vatAmount);
      const total = net.plus(vat);
      // A non-VAT entity cannot claim input VAT: what it pays in VAT is part of the cost (variance).
      const inputVat = profile.vatStatus === 'VAT' ? vat : new Dec(0);
      const dueDate = input.dueDate ?? (await db.execute<{ d: string }>(sql`SELECT (${input.invoiceDate}::date + ${supplier.paymentTermsDays}::int)::text AS d`)).rows[0]!.d;

      const tenantId = tenantOf(auth).tenantId;
      const entryNumber = await nextNumber(db, tenantId, branch.legalEntityId, 'SUPPLIER_INVOICE');
      const [invoice] = await db
        .insert(supplierInvoices)
        .values({
          tenantId,
          legalEntityId: branch.legalEntityId,
          branchId: branch.id,
          supplierId: supplier.id,
          entryNumber,
          invoiceNumber: input.invoiceNumber,
          invoiceDate: input.invoiceDate,
          dueDate,
          netAmount: net.toFixed(4),
          vatAmount: vat.toFixed(4),
          totalAmount: total.toFixed(4),
          matchedAmount: matched.toFixed(4),
          inputVat: inputVat.toFixed(4),
          notes: input.notes ?? null,
          createdBy: auth.userId,
        })
        .returning();
      await db
        .insert(supplierInvoiceReceipts)
        .values(ids.map((id) => ({ tenantId, supplierInvoiceId: invoice!.id, goodsReceiptId: id, matchedAmount: held.get(id)!.toFixed(4) })));

      await post(db, {
        tenantId,
        legalEntityId: branch.legalEntityId,
        branchId: branch.id,
        entryDate: input.invoiceDate,
        sourceType: 'SUPPLIER_INVOICE',
        sourceId: invoice!.id,
        memo: `Supplier invoice ${input.invoiceNumber} (${supplier.code}), entry #${entryNumber}`,
        lines: supplierInvoicePosting({ matched, inputVat, payable: total }, branch.id),
        createdBy: auth.userId,
      });

      await this.audit(db, auth, 'supplier_invoice.recorded', 'supplier_invoice', invoice!.id, { entryNumber, invoiceNumber: input.invoiceNumber, receipts: ids.length });
      await emitEvent(db, { tenantId, topic: 'supplier_invoice.recorded', payload: { supplierInvoiceId: invoice!.id, branchId: branch.id, supplierId: supplier.id }, correlationId: auth.correlationId });
      return this.view(db, invoice!);
    });
  }

  cancelInvoice(auth: AuthContext, id: string, input: CancelSupplierInvoiceInput) {
    return this.mutate(auth, async (db) => {
      const invoice = await this.lockInvoice(db, id);
      this.assertEnter(auth, { branchId: invoice.branchId, legalEntityId: invoice.legalEntityId });
      if (invoice.status === 'CANCELLED') throw new AppError('INVALID_STATE', 'The invoice is already cancelled', HttpStatus.CONFLICT, { status: invoice.status });
      const paid = await this.paidOn(db, invoice.id);
      if (paid.gt(0)) throw new AppError('INVOICE_HAS_PAYMENTS', 'A paid or part-paid invoice cannot be cancelled', HttpStatus.CONFLICT, { paid: money(paid) });

      // Status first: the receipts' trigger releases them only from a cancelled invoice.
      const [cancelled] = await db
        .update(supplierInvoices)
        .set({ status: 'CANCELLED', cancelledBy: auth.userId, cancelledAt: sql`now()`, cancelReason: input.reason })
        .where(eq(supplierInvoices.id, invoice.id))
        .returning();
      await db.update(supplierInvoiceReceipts).set({ active: false }).where(and(eq(supplierInvoiceReceipts.supplierInvoiceId, invoice.id), eq(supplierInvoiceReceipts.active, true)));

      const [entry] = await db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.sourceType, 'SUPPLIER_INVOICE'), eq(journalEntries.sourceId, invoice.id)));
      if (entry) {
        const lines = await db.select().from(journalLines).where(eq(journalLines.journalEntryId, entry.id));
        const posting: PostingLine[] = lines.map((l) => ({ account: l.accountId, debit: l.debit, credit: l.credit, branchId: l.branchId, memo: l.memo }));
        await post(db, {
          tenantId: invoice.tenantId,
          legalEntityId: invoice.legalEntityId,
          branchId: invoice.branchId,
          sourceType: 'REVERSAL',
          reversesEntryId: entry.id,
          memo: `Supplier invoice ${invoice.invoiceNumber} cancelled: ${input.reason}`,
          lines: reversalOf(posting),
          createdBy: auth.userId,
        });
      }

      await this.audit(db, auth, 'supplier_invoice.cancelled', 'supplier_invoice', invoice.id, { entryNumber: invoice.entryNumber, reason: input.reason });
      await emitEvent(db, { tenantId: invoice.tenantId, topic: 'supplier_invoice.cancelled', payload: { supplierInvoiceId: invoice.id, branchId: invoice.branchId }, correlationId: auth.correlationId });
      return this.view(db, cancelled!);
    });
  }

  pay(auth: AuthContext, id: string, input: CreateSupplierPaymentInput) {
    return this.mutate(auth, async (db) => {
      const invoice = await this.lockInvoice(db, id);
      this.assertCan(auth, 'accounting.post', { legalEntityId: invoice.legalEntityId });
      if (invoice.status === 'CANCELLED') throw new AppError('INVALID_STATE', 'A cancelled invoice cannot be paid', HttpStatus.CONFLICT, { status: invoice.status });
      const [branch] = await db.select({ timezone: branches.timezone }).from(branches).where(eq(branches.id, invoice.branchId));
      const today = await localToday(db, branch!.timezone);
      if (input.paidOn > today) throw unprocessable('DATE_IN_FUTURE', 'The payment date is after today', { today });
      if (input.paidOn < invoice.invoiceDate) throw unprocessable('PAID_BEFORE_INVOICE', 'The payment date is before the invoice date', { invoiceDate: invoice.invoiceDate });
      const balance = toDec(invoice.totalAmount).minus(await this.paidOn(db, invoice.id));
      if (toDec(input.amount).gt(balance)) throw unprocessable('OVERPAYMENT', 'More than the open balance of the invoice', { balance: money(balance) });

      const tenantId = invoice.tenantId;
      const paymentNumber = await nextNumber(db, tenantId, invoice.legalEntityId, 'SUPPLIER_PAYMENT');
      const [payment] = await db
        .insert(supplierPayments)
        .values({
          tenantId,
          legalEntityId: invoice.legalEntityId,
          branchId: invoice.branchId,
          supplierId: invoice.supplierId,
          supplierInvoiceId: invoice.id,
          paymentNumber,
          amount: toDec(input.amount).toFixed(4),
          paidOn: input.paidOn,
          method: input.method,
          reference: input.reference ?? null,
          createdBy: auth.userId,
        })
        .returning();
      await post(db, {
        tenantId,
        legalEntityId: invoice.legalEntityId,
        branchId: invoice.branchId,
        entryDate: input.paidOn,
        sourceType: 'SUPPLIER_PAYMENT',
        sourceId: payment!.id,
        memo: `Payment #${paymentNumber} of supplier invoice ${invoice.invoiceNumber}${input.reference ? ` (${input.reference})` : ''}`,
        lines: supplierPaymentPosting(input.amount, invoice.branchId),
        createdBy: auth.userId,
      });

      await this.audit(db, auth, 'supplier_payment.recorded', 'supplier_payment', payment!.id, { paymentNumber, supplierInvoiceId: invoice.id, amount: money(input.amount) });
      await emitEvent(db, { tenantId, topic: 'supplier_payment.recorded', payload: { supplierPaymentId: payment!.id, supplierInvoiceId: invoice.id }, correlationId: auth.correlationId });
      return this.view(db, invoice);
    });
  }

  getInvoice(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [invoice] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
      if (!invoice) throw notFound('Supplier invoice');
      const scope = { branchId: invoice.branchId, legalEntityId: invoice.legalEntityId };
      if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'accounting.read', scope);
      return this.view(db, invoice);
    });
  }

  /** One payment (the journal links a SUPPLIER_PAYMENT entry here), with the invoice it settles. */
  getPayment(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [payment] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, id));
      if (!payment) throw notFound('Supplier payment');
      const scope = { branchId: payment.branchId, legalEntityId: payment.legalEntityId };
      if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'accounting.read', scope);
      const [invoice] = await db.select({ invoiceNumber: supplierInvoices.invoiceNumber }).from(supplierInvoices).where(eq(supplierInvoices.id, payment.supplierInvoiceId));
      return { ...payment, amount: money(payment.amount), invoiceNumber: invoice!.invoiceNumber };
    });
  }

  listInvoices(auth: AuthContext, q: SupplierInvoiceListQuery) {
    return this.read(auth, async (db) => {
      await this.assertEntityRead(db, auth, q.legalEntityId);
      if (q.supplierId) await findSupplier(db, q.supplierId);
      const { rows } = await db.execute<{
        id: string; entry_number: number; invoice_number: string; invoice_date: string; due_date: string; branch_id: string; supplier_id: string;
        supplier_code: string; supplier_name: string; total_amount: string; paid: string; status: string;
      }>(sql`
        SELECT * FROM (
          SELECT i.id, i.entry_number::int, i.invoice_number, i.invoice_date::text, i.due_date::text, i.branch_id, i.supplier_id,
                 s.code AS supplier_code, s.name AS supplier_name, i.total_amount::text,
                 coalesce((SELECT sum(p.amount) FROM supplier_payments p WHERE p.supplier_invoice_id = i.id), 0)::text AS paid, i.status
            FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id
           WHERE i.legal_entity_id = ${q.legalEntityId}
             ${q.supplierId ? sql`AND i.supplier_id = ${q.supplierId}` : sql``}
        ) x
        -- The derived status filters before the limit, so a filter never loses rows past it.
         WHERE ${q.status === 'CANCELLED' ? sql`x.status = 'CANCELLED'` : q.status === 'PAID' ? sql`x.status <> 'CANCELLED' AND x.total_amount::numeric <= x.paid::numeric` : q.status === 'OPEN' ? sql`x.status <> 'CANCELLED' AND x.total_amount::numeric > x.paid::numeric` : sql`TRUE`}
         ORDER BY x.due_date, x.entry_number
         LIMIT 1000`);
      const data = rows
        .map((r) => {
          const balance = toDec(r.total_amount).minus(r.paid);
          return {
            id: r.id,
            entryNumber: r.entry_number,
            invoiceNumber: r.invoice_number,
            invoiceDate: r.invoice_date,
            dueDate: r.due_date,
            branchId: r.branch_id,
            supplier: { id: r.supplier_id, code: r.supplier_code, name: r.supplier_name },
            totalAmount: money(r.total_amount),
            paidAmount: money(r.paid),
            balance: money(balance),
            status: r.status === 'CANCELLED' ? 'CANCELLED' : balance.lte(0) ? 'PAID' : 'OPEN',
          };
        })
        .filter((r) => !q.status || r.status === q.status);
      return { data };
    });
  }

  /** Receipts of a branch from a supplier not on an open invoice, with the GRNI each still holds. */
  uninvoicedReceipts(auth: AuthContext, q: UninvoicedReceiptsQuery) {
    return this.read(auth, async (db) => {
      const { scope } = await branchScope(db, q.branchId);
      if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'accounting.read', scope);
      await findSupplier(db, q.supplierId);
      const rows = await db
        .select({ id: goodsReceipts.id, receiptNumber: goodsReceipts.receiptNumber, supplierInvoiceRef: goodsReceipts.supplierInvoiceRef, receivedAt: goodsReceipts.createdAt })
        .from(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.branchId, q.branchId),
            eq(goodsReceipts.supplierId, q.supplierId),
            sql`NOT EXISTS (SELECT 1 FROM supplier_invoice_receipts x WHERE x.goods_receipt_id = ${goodsReceipts.id} AND x.active)`,
          ),
        )
        .orderBy(asc(goodsReceipts.createdAt))
        .limit(500);
      const held = await grniHeld(db, rows.map((r) => r.id));
      return { data: rows.map((r) => ({ ...r, uninvoicedAmount: money(held.get(r.id)!) })) };
    });
  }

  /**
   * Open balances by supplier as of a day, bucketed by days past due. An invoice counts from its
   * invoice date until its cancellation's local date; payments count from their paid-on date — the
   * same dates their entries carry, so the total equals the payables account as of that day
   * (`ledgerBalance`) unless someone posted to it by hand.
   */
  aging(auth: AuthContext, q: PayablesAgingQuery) {
    return this.read(auth, async (db) => {
      await this.assertEntityRead(db, auth, q.legalEntityId);
      // An entity has no time zone of its own: its first branch's local day (Manila when it has none).
      const [first] = await db.select({ timezone: branches.timezone }).from(branches).where(eq(branches.legalEntityId, q.legalEntityId)).orderBy(asc(branches.createdAt)).limit(1);
      const asOf = q.asOf ?? (await localToday(db, first?.timezone ?? 'Asia/Manila'));
      const { rows } = await db.execute<{ supplier_id: string; code: string; name: string; due_date: string; days: number; balance: string }>(sql`
        SELECT i.supplier_id, s.code, s.name, i.due_date::text, (${asOf}::date - i.due_date)::int AS days,
               (i.total_amount - coalesce((SELECT sum(p.amount) FROM supplier_payments p WHERE p.supplier_invoice_id = i.id AND p.paid_on <= ${asOf}::date), 0))::text AS balance
          FROM supplier_invoices i
          JOIN suppliers s ON s.id = i.supplier_id
          JOIN branches b ON b.id = i.branch_id
         WHERE i.legal_entity_id = ${q.legalEntityId}
           AND i.invoice_date <= ${asOf}::date
           AND (i.status = 'OPEN' OR (i.cancelled_at AT TIME ZONE b.timezone)::date > ${asOf}::date)`);
      const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
      const bucketOf = (days: number) => (days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
      const bySupplier = new Map<string, { supplier: { id: string; code: string; name: string }; sums: Dec[]; invoices: number }>();
      for (const r of rows) {
        const balance = toDec(r.balance);
        if (balance.lte(0)) continue;
        const row = bySupplier.get(r.supplier_id) ?? { supplier: { id: r.supplier_id, code: r.code, name: r.name }, sums: BUCKETS.map(() => new Dec(0)), invoices: 0 };
        row.sums[bucketOf(r.days)] = row.sums[bucketOf(r.days)]!.plus(balance);
        row.invoices += 1;
        bySupplier.set(r.supplier_id, row);
      }
      const shape = (sums: Dec[]) => ({
        ...Object.fromEntries(BUCKETS.map((b, i) => [b, money(sums[i]!)])),
        total: money(sums.reduce((a, v) => a.plus(v), new Dec(0))),
      });
      const suppliersOut = [...bySupplier.values()]
        .sort((a, b) => a.supplier.name.localeCompare(b.supplier.name))
        .map((r) => ({ supplier: r.supplier, invoices: r.invoices, ...shape(r.sums) }));
      const totals = BUCKETS.map((_, i) => [...bySupplier.values()].reduce((a, r) => a.plus(r.sums[i]!), new Dec(0)));
      const { rows: ledger } = await db.execute<{ v: string }>(sql`
        SELECT coalesce(sum(l.credit - l.debit), 0)::text AS v
          FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
         WHERE e.legal_entity_id = ${q.legalEntityId} AND a.system_key = 'ACCOUNTS_PAYABLE' AND e.entry_date <= ${asOf}::date`);
      return { legalEntityId: q.legalEntityId, asOf, suppliers: suppliersOut, totals: shape(totals), ledgerBalance: money(ledger[0]!.v) };
    });
  }

  /** Entering or cancelling an invoice: the branch's purchaser, or the entity's bookkeeper. */
  private assertEnter(auth: AuthContext, scope: Scope) {
    if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'accounting.post', { legalEntityId: scope.legalEntityId });
  }

  private async assertEntityRead(db: Database, auth: AuthContext, legalEntityId: string) {
    const [row] = await db.select({ id: legalEntities.id }).from(legalEntities).where(eq(legalEntities.id, legalEntityId));
    if (!row) throw notFound('Legal entity');
    if (!this.can(auth, 'purchasing.manage', { legalEntityId })) this.assertCan(auth, 'accounting.read', { legalEntityId });
  }

  /** The invoice under its row lock: payments and cancellation are decided one at a time. */
  private async lockInvoice(db: Database, id: string) {
    const [invoice] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id)).for('update');
    if (!invoice) throw notFound('Supplier invoice');
    return invoice;
  }

  private async paidOn(db: Database, invoiceId: string) {
    const { rows } = await db.execute<{ v: string }>(sql`SELECT coalesce(sum(amount), 0)::text AS v FROM supplier_payments WHERE supplier_invoice_id = ${invoiceId}`);
    return toDec(rows[0]!.v);
  }

  private async view(db: Database, i: InvoiceRow) {
    const [supplier] = await db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, i.supplierId));
    const receipts = await db
      .select({ goodsReceiptId: supplierInvoiceReceipts.goodsReceiptId, receiptNumber: goodsReceipts.receiptNumber, matchedAmount: supplierInvoiceReceipts.matchedAmount, active: supplierInvoiceReceipts.active })
      .from(supplierInvoiceReceipts)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, supplierInvoiceReceipts.goodsReceiptId))
      .where(eq(supplierInvoiceReceipts.supplierInvoiceId, i.id))
      .orderBy(asc(goodsReceipts.receiptNumber));
    const payments = await db.select().from(supplierPayments).where(eq(supplierPayments.supplierInvoiceId, i.id)).orderBy(asc(supplierPayments.paymentNumber));
    const [entry] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.sourceType, 'SUPPLIER_INVOICE'), eq(journalEntries.sourceId, i.id)));
    const [reversal] = entry ? await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.reversesEntryId, entry.id)) : [];
    const paid = payments.reduce((a, p) => a.plus(p.amount), new Dec(0));
    const balance = toDec(i.totalAmount).minus(paid);
    return {
      id: i.id,
      legalEntityId: i.legalEntityId,
      branchId: i.branchId,
      supplier: supplier!,
      entryNumber: i.entryNumber,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      currency: i.currency,
      netAmount: money(i.netAmount),
      vatAmount: money(i.vatAmount),
      totalAmount: money(i.totalAmount),
      matchedAmount: money(i.matchedAmount),
      inputVat: money(i.inputVat),
      /** What the invoice charges beyond the receipts and the claimable VAT (posted to the price variance). */
      priceVariance: money(toDec(i.totalAmount).minus(i.matchedAmount).minus(i.inputVat)),
      paidAmount: money(paid),
      balance: money(balance),
      status: i.status === 'CANCELLED' ? 'CANCELLED' : balance.lte(0) ? 'PAID' : 'OPEN',
      notes: i.notes,
      createdBy: i.createdBy,
      createdAt: i.createdAt,
      cancelledBy: i.cancelledBy,
      cancelledAt: i.cancelledAt,
      cancelReason: i.cancelReason,
      journalEntryId: entry?.id ?? null,
      reversalEntryId: reversal?.id ?? null,
      receipts: receipts.map((r) => ({ ...r, matchedAmount: money(r.matchedAmount) })),
      payments: payments.map((p) => ({
        id: p.id,
        paymentNumber: p.paymentNumber,
        amount: money(p.amount),
        paidOn: p.paidOn,
        method: p.method,
        reference: p.reference,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
      })),
    };
  }
}
