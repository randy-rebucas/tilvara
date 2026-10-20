import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { reversalOf, supplierInvoicePosting, supplierNotePosting, supplierPaymentPosting, type PostingLine } from '@1pos/accounting';
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
  supplierNotes,
  supplierPaymentAllocations,
  supplierPayments,
  supplierReturnLines,
  supplierReturns,
  suppliers,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type {
  CancelSupplierInvoiceInput,
  CreateSupplierBatchPaymentInput,
  CreateSupplierInvoiceInput,
  CreateSupplierNoteInput,
  CreateSupplierPaymentInput,
  PayablesAgingQuery,
  SupplierInvoiceListQuery,
  UninvoicedReceiptsQuery,
  VoidSupplierPaymentInput,
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
      // A note's entry would stay behind: notes are corrected by an opposite note, not by cancelling the invoice.
      const [note] = await db.select({ id: supplierNotes.id }).from(supplierNotes).where(eq(supplierNotes.supplierInvoiceId, invoice.id)).limit(1);
      if (note) throw new AppError('INVOICE_HAS_NOTES', 'An invoice with credit or debit notes cannot be cancelled', HttpStatus.CONFLICT);

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

  /** A payment of one invoice: the invoice as it now stands. */
  pay(auth: AuthContext, id: string, input: CreateSupplierPaymentInput) {
    return this.mutate(auth, async (db) => {
      const [found] = await db.select({ supplierId: supplierInvoices.supplierId }).from(supplierInvoices).where(eq(supplierInvoices.id, id));
      if (!found) throw notFound('Supplier invoice');
      await this.recordPayment(db, auth, { ...input, supplierId: found.supplierId, allocations: [{ supplierInvoiceId: id, amount: input.amount }] });
      const [invoice] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
      return this.view(db, invoice!);
    });
  }

  /** One payment to a supplier over several of its open invoices of one legal entity (session 22). */
  payMany(auth: AuthContext, input: CreateSupplierBatchPaymentInput) {
    return this.mutate(auth, async (db) => this.paymentView(db, await this.recordPayment(db, auth, input)));
  }

  /**
   * Every invoice under its row lock (id order), each allocation within its open balance; one payment
   * row, its allocations, and one entry: Dr payables, Cr bank, per branch of the invoices it settles.
   */
  private async recordPayment(db: Database, auth: AuthContext, input: CreateSupplierBatchPaymentInput) {
    const allocations = [...input.allocations].sort((a, b) => a.supplierInvoiceId.localeCompare(b.supplierInvoiceId));
    const invoices: InvoiceRow[] = [];
    for (const a of allocations) invoices.push(await this.lockInvoice(db, a.supplierInvoiceId));
    const entity = invoices[0]!.legalEntityId;
    const foreign = invoices.filter((i) => i.supplierId !== input.supplierId || i.legalEntityId !== entity).map((i) => i.id);
    if (foreign.length) throw unprocessable('INVOICE_MISMATCH', 'Every invoice must be from this supplier and of one legal entity', { supplierInvoiceIds: foreign });
    this.assertCan(auth, 'accounting.post', { legalEntityId: entity });
    const supplier = await findSupplier(db, input.supplierId);
    for (const i of invoices) {
      if (i.status === 'CANCELLED') throw new AppError('INVALID_STATE', 'A cancelled invoice cannot be paid', HttpStatus.CONFLICT, { status: i.status, supplierInvoiceId: i.id });
    }
    // The first invoice's branch dates the payment (and is its branch); all are of one entity.
    const first = invoices.find((i) => i.id === input.allocations[0]!.supplierInvoiceId)!;
    const [branch] = await db.select({ timezone: branches.timezone }).from(branches).where(eq(branches.id, first.branchId));
    const today = await localToday(db, branch!.timezone);
    if (input.paidOn > today) throw unprocessable('DATE_IN_FUTURE', 'The payment date is after today', { today });
    for (const [k, a] of allocations.entries()) {
      const i = invoices[k]!;
      if (input.paidOn < i.invoiceDate) throw unprocessable('PAID_BEFORE_INVOICE', 'The payment date is before the invoice date', { invoiceDate: i.invoiceDate, supplierInvoiceId: i.id });
      const balance = await this.openBalance(db, i);
      if (toDec(a.amount).gt(balance)) throw unprocessable('OVERPAYMENT', 'More than the open balance of the invoice', { balance: money(balance), supplierInvoiceId: i.id });
    }

    const amount = allocations.reduce((s, a) => s.plus(a.amount), new Dec(0));
    const tenantId = first.tenantId;
    const paymentNumber = await nextNumber(db, tenantId, entity, 'SUPPLIER_PAYMENT');
    const [payment] = await db
      .insert(supplierPayments)
      .values({
        tenantId,
        legalEntityId: entity,
        branchId: first.branchId,
        supplierId: supplier.id,
        supplierInvoiceId: invoices.length === 1 ? first.id : null,
        paymentNumber,
        amount: amount.toFixed(4),
        paidOn: input.paidOn,
        method: input.method,
        reference: input.reference ?? null,
        createdBy: auth.userId,
      })
      .returning();
    await db.insert(supplierPaymentAllocations).values(allocations.map((a) => ({ tenantId, supplierPaymentId: payment!.id, supplierInvoiceId: a.supplierInvoiceId, amount: toDec(a.amount).toFixed(4) })));
    // Each branch's payables settled by its own lines, so every branch stays balanced.
    const byBranch = new Map<string, Dec>();
    for (const [k, a] of allocations.entries()) byBranch.set(invoices[k]!.branchId, (byBranch.get(invoices[k]!.branchId) ?? new Dec(0)).plus(a.amount));
    const numbers = invoices.map((i) => i.invoiceNumber).join(', ');
    await post(db, {
      tenantId,
      legalEntityId: entity,
      branchId: first.branchId,
      entryDate: input.paidOn,
      sourceType: 'SUPPLIER_PAYMENT',
      sourceId: payment!.id,
      memo: `Payment #${paymentNumber} of supplier invoice${invoices.length > 1 ? 's' : ''} ${numbers}${input.reference ? ` (${input.reference})` : ''}`,
      lines: [...byBranch].flatMap(([branchId, v]) => supplierPaymentPosting(money(v), branchId)),
      createdBy: auth.userId,
    });

    await this.audit(db, auth, 'supplier_payment.recorded', 'supplier_payment', payment!.id, {
      paymentNumber,
      amount: money(amount),
      allocations: allocations.map((a) => ({ supplierInvoiceId: a.supplierInvoiceId, amount: money(a.amount) })),
    });
    await emitEvent(db, { tenantId, topic: 'supplier_payment.recorded', payload: { supplierPaymentId: payment!.id, supplierInvoiceIds: allocations.map((a) => a.supplierInvoiceId) }, correlationId: auth.correlationId });
    return payment!;
  }

  /**
   * A mistaken payment (wrong amount, wrong supplier, a bounced check): voided once, with a reason, and
   * its entry reversed on the branch's today. The invoices it settled are open again by its amounts.
   */
  voidPayment(auth: AuthContext, id: string, input: VoidSupplierPaymentInput) {
    return this.mutate(auth, async (db) => {
      const [payment] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, id)).for('update');
      if (!payment) throw notFound('Supplier payment');
      this.assertCan(auth, 'accounting.post', { legalEntityId: payment.legalEntityId });
      if (payment.voidedAt) throw new AppError('ALREADY_VOIDED', 'This payment is already voided', HttpStatus.CONFLICT);
      const [voided] = await db
        .update(supplierPayments)
        .set({ voidedBy: auth.userId, voidedAt: sql`now()`, voidReason: input.reason })
        .where(eq(supplierPayments.id, id))
        .returning();
      const [entry] = await db.select().from(journalEntries).where(and(eq(journalEntries.sourceType, 'SUPPLIER_PAYMENT'), eq(journalEntries.sourceId, id)));
      if (entry) {
        const lines = await db.select().from(journalLines).where(eq(journalLines.journalEntryId, entry.id));
        await post(db, {
          tenantId: payment.tenantId,
          legalEntityId: payment.legalEntityId,
          branchId: payment.branchId,
          sourceType: 'REVERSAL',
          reversesEntryId: entry.id,
          memo: `Supplier payment #${payment.paymentNumber} voided: ${input.reason}`,
          lines: reversalOf(lines.map((l) => ({ account: l.accountId, debit: l.debit, credit: l.credit, branchId: l.branchId, memo: l.memo }))),
          createdBy: auth.userId,
        });
      }
      await this.audit(db, auth, 'supplier_payment.voided', 'supplier_payment', id, { paymentNumber: payment.paymentNumber, amount: money(payment.amount), reason: input.reason });
      await emitEvent(db, { tenantId: payment.tenantId, topic: 'supplier_payment.voided', payload: { supplierPaymentId: id }, correlationId: auth.correlationId });
      return this.paymentView(db, voided!);
    });
  }

  /**
   * A supplier's credit or debit note against an open invoice (session 22). A credit note may not take
   * the invoice below what is already paid; it first clears the GRNI that returns after invoicing left
   * on the invoice's receipts (what they held when invoiced, less what they hold now, less what earlier
   * notes cleared). VAT is claimed or given back as on the invoice; the rest is a price variance.
   */
  createNote(auth: AuthContext, invoiceId: string, input: CreateSupplierNoteInput) {
    return this.mutate(auth, async (db) => {
      const invoice = await this.lockInvoice(db, invoiceId);
      const { branch } = await branchScope(db, invoice.branchId);
      this.assertEnter(auth, { branchId: invoice.branchId, legalEntityId: invoice.legalEntityId });
      if (invoice.status === 'CANCELLED') throw new AppError('INVALID_STATE', 'A cancelled invoice takes no notes', HttpStatus.CONFLICT, { status: invoice.status });
      const today = await localToday(db, branch.timezone);
      if (input.noteDate > today) throw unprocessable('DATE_IN_FUTURE', 'The note date is after today', { today });
      if (input.noteDate < invoice.invoiceDate) throw unprocessable('NOTE_BEFORE_INVOICE', 'The note date is before the invoice date', { invoiceDate: invoice.invoiceDate });
      const net = toDec(input.netAmount);
      const vat = toDec(input.vatAmount);
      const total = net.plus(vat);
      if (input.kind === 'CREDIT') {
        const balance = await this.openBalance(db, invoice);
        if (total.gt(balance)) throw unprocessable('CREDIT_EXCEEDS_BALANCE', 'More than the open balance of the invoice', { balance: money(balance) });
      }
      const profile = (await profilesInForce(db, [invoice.legalEntityId])).get(invoice.legalEntityId);
      if (!profile) throw new AppError('TAX_PROFILE_MISSING', 'The legal entity has no tax profile in force', HttpStatus.CONFLICT);
      const inputVat = profile.vatStatus === 'VAT' ? vat : new Dec(0);

      let grniCleared = new Dec(0);
      if (input.kind === 'CREDIT') {
        const receipts = await db
          .select({ id: supplierInvoiceReceipts.goodsReceiptId, matched: supplierInvoiceReceipts.matchedAmount })
          .from(supplierInvoiceReceipts)
          .where(eq(supplierInvoiceReceipts.supplierInvoiceId, invoice.id));
        const ids = receipts.map((r) => r.id).sort();
        // The receipts' lock (returns take it too): what they hold cannot change underneath.
        await mapInSequence(ids, (rid) => db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${rid}, 0))`));
        const held = await grniHeld(db, ids);
        const { rows } = await db.execute<{ v: string }>(sql`SELECT coalesce(sum(grni_cleared), 0)::text AS v FROM supplier_notes WHERE supplier_invoice_id = ${invoice.id}`);
        const stranded = receipts.reduce((s, r) => s.plus(r.matched).minus(held.get(r.id)!), new Dec(0)).minus(rows[0]!.v);
        grniCleared = Dec.max(new Dec(0), Dec.min(stranded, total.minus(inputVat)));
      }

      const tenantId = invoice.tenantId;
      const entryNumber = await nextNumber(db, tenantId, invoice.legalEntityId, 'SUPPLIER_NOTE');
      const [note] = await db
        .insert(supplierNotes)
        .values({
          tenantId,
          legalEntityId: invoice.legalEntityId,
          branchId: invoice.branchId,
          supplierId: invoice.supplierId,
          supplierInvoiceId: invoice.id,
          kind: input.kind,
          entryNumber,
          noteNumber: input.noteNumber,
          noteDate: input.noteDate,
          netAmount: net.toFixed(4),
          vatAmount: vat.toFixed(4),
          totalAmount: total.toFixed(4),
          inputVat: inputVat.toFixed(4),
          grniCleared: grniCleared.toFixed(4),
          reason: input.reason,
          createdBy: auth.userId,
        })
        .returning();
      await post(db, {
        tenantId,
        legalEntityId: invoice.legalEntityId,
        branchId: invoice.branchId,
        entryDate: input.noteDate,
        sourceType: 'SUPPLIER_NOTE',
        sourceId: note!.id,
        memo: `Supplier ${input.kind === 'CREDIT' ? 'credit' : 'debit'} note ${input.noteNumber} on invoice ${invoice.invoiceNumber}, entry #${entryNumber}`,
        lines: supplierNotePosting({ kind: input.kind, payable: total, inputVat, grniCleared }, invoice.branchId),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'supplier_note.recorded', 'supplier_note', note!.id, { kind: input.kind, entryNumber, noteNumber: input.noteNumber, supplierInvoiceId: invoice.id, total: money(total) });
      await emitEvent(db, { tenantId, topic: 'supplier_note.recorded', payload: { supplierNoteId: note!.id, supplierInvoiceId: invoice.id }, correlationId: auth.correlationId });
      return this.view(db, invoice);
    });
  }

  /** One note (the journal links a SUPPLIER_NOTE entry here), with the invoice it adjusts. */
  getNote(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [note] = await db.select().from(supplierNotes).where(eq(supplierNotes.id, id));
      if (!note) throw notFound('Supplier note');
      const scope = { branchId: note.branchId, legalEntityId: note.legalEntityId };
      if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'accounting.read', scope);
      const [invoice] = await db.select({ invoiceNumber: supplierInvoices.invoiceNumber }).from(supplierInvoices).where(eq(supplierInvoices.id, note.supplierInvoiceId));
      return { ...noteView(note), invoiceNumber: invoice!.invoiceNumber };
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

  /** One payment (the journal links a SUPPLIER_PAYMENT entry here), with the invoices it settles. */
  getPayment(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [payment] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, id));
      if (!payment) throw notFound('Supplier payment');
      const scope = { branchId: payment.branchId, legalEntityId: payment.legalEntityId };
      if (!this.can(auth, 'purchasing.manage', scope)) this.assertCan(auth, 'accounting.read', scope);
      return this.paymentView(db, payment);
    });
  }

  private async paymentView(db: Database, p: typeof supplierPayments.$inferSelect) {
    const [allocations, [supplier], [entry]] = [
      await db
        .select({ supplierInvoiceId: supplierPaymentAllocations.supplierInvoiceId, invoiceNumber: supplierInvoices.invoiceNumber, branchId: supplierInvoices.branchId, amount: supplierPaymentAllocations.amount })
        .from(supplierPaymentAllocations)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierPaymentAllocations.supplierInvoiceId))
        .where(eq(supplierPaymentAllocations.supplierPaymentId, p.id))
        .orderBy(asc(supplierInvoices.invoiceNumber)),
      await db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, p.supplierId)),
      await db.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.sourceType, 'SUPPLIER_PAYMENT'), eq(journalEntries.sourceId, p.id))),
    ];
    const [reversal] = entry ? await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.reversesEntryId, entry.id)) : [];
    return {
      id: p.id,
      legalEntityId: p.legalEntityId,
      branchId: p.branchId,
      supplier: supplier!,
      paymentNumber: p.paymentNumber,
      amount: money(p.amount),
      paidOn: p.paidOn,
      method: p.method,
      reference: p.reference,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
      status: p.voidedAt ? 'VOIDED' : 'RECORDED',
      voidedBy: p.voidedBy,
      voidedAt: p.voidedAt,
      voidReason: p.voidReason,
      allocations: allocations.map((a) => ({ ...a, amount: money(a.amount) })),
      /** A one-invoice payment's invoice and its number (older clients); null when it settles several. */
      supplierInvoiceId: p.supplierInvoiceId,
      invoiceNumber: allocations.length === 1 ? allocations[0]!.invoiceNumber : null,
      journalEntryId: entry?.id ?? null,
      reversalEntryId: reversal?.id ?? null,
    };
  }

  listInvoices(auth: AuthContext, q: SupplierInvoiceListQuery) {
    return this.read(auth, async (db) => {
      await this.assertEntityRead(db, auth, q.legalEntityId);
      if (q.supplierId) await findSupplier(db, q.supplierId);
      const { rows } = await db.execute<{
        id: string; entry_number: number; invoice_number: string; invoice_date: string; due_date: string; branch_id: string; supplier_id: string;
        supplier_code: string; supplier_name: string; total_amount: string; notes: string; paid: string; status: string;
      }>(sql`
        SELECT * FROM (
          SELECT i.id, i.entry_number::int, i.invoice_number, i.invoice_date::text, i.due_date::text, i.branch_id, i.supplier_id,
                 s.code AS supplier_code, s.name AS supplier_name, i.total_amount::text,
                 ${NOTES_SQL}::text AS notes, ${PAID_SQL}::text AS paid, i.status
            FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id
           WHERE i.legal_entity_id = ${q.legalEntityId}
             ${q.supplierId ? sql`AND i.supplier_id = ${q.supplierId}` : sql``}
        ) x
        -- The derived status filters before the limit, so a filter never loses rows past it.
         WHERE ${q.status === 'CANCELLED' ? sql`x.status = 'CANCELLED'` : q.status === 'PAID' ? sql`x.status <> 'CANCELLED' AND x.total_amount::numeric + x.notes::numeric <= x.paid::numeric` : q.status === 'OPEN' ? sql`x.status <> 'CANCELLED' AND x.total_amount::numeric + x.notes::numeric > x.paid::numeric` : sql`TRUE`}
         ORDER BY x.due_date, x.entry_number
         LIMIT 1000`);
      const data = rows
        .map((r) => {
          const balance = toDec(r.total_amount).plus(r.notes).minus(r.paid);
          return {
            id: r.id,
            entryNumber: r.entry_number,
            invoiceNumber: r.invoice_number,
            invoiceDate: r.invoice_date,
            dueDate: r.due_date,
            branchId: r.branch_id,
            supplier: { id: r.supplier_id, code: r.supplier_code, name: r.supplier_name },
            totalAmount: money(r.total_amount),
            /** Debit notes less credit notes. */
            notesAmount: money(r.notes),
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
      // A note counts from its note date; a payment from its paid-on date until its void's local date
      // (the dates their entries and the void's reversal carry).
      const { rows } = await db.execute<{ supplier_id: string; code: string; name: string; due_date: string; days: number; balance: string }>(sql`
        SELECT i.supplier_id, s.code, s.name, i.due_date::text, (${asOf}::date - i.due_date)::int AS days,
               (i.total_amount
                 + coalesce((SELECT sum(CASE n.kind WHEN 'DEBIT' THEN n.total_amount ELSE -n.total_amount END) FROM supplier_notes n
                              WHERE n.supplier_invoice_id = i.id AND n.note_date <= ${asOf}::date), 0)
                 - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                               JOIN supplier_payments p ON p.id = a.supplier_payment_id JOIN branches pb ON pb.id = p.branch_id
                              WHERE a.supplier_invoice_id = i.id AND p.paid_on <= ${asOf}::date
                                AND (p.voided_at IS NULL OR (p.voided_at AT TIME ZONE pb.timezone)::date > ${asOf}::date)), 0))::text AS balance
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

  /** What payments not voided have settled of the invoice. */
  private async paidOn(db: Database, invoiceId: string) {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT coalesce(sum(a.amount), 0)::text AS v FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.supplier_payment_id
       WHERE a.supplier_invoice_id = ${invoiceId} AND p.voided_at IS NULL`);
    return toDec(rows[0]!.v);
  }

  /** Still owed on the invoice: its total, plus debit notes, less credit notes, less what is paid. */
  private async openBalance(db: Database, i: InvoiceRow) {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT coalesce(sum(CASE kind WHEN 'DEBIT' THEN total_amount ELSE -total_amount END), 0)::text AS v FROM supplier_notes WHERE supplier_invoice_id = ${i.id}`);
    return toDec(i.totalAmount).plus(rows[0]!.v).minus(await this.paidOn(db, i.id));
  }

  private async view(db: Database, i: InvoiceRow) {
    const [supplier] = await db.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, i.supplierId));
    const receipts = await db
      .select({ goodsReceiptId: supplierInvoiceReceipts.goodsReceiptId, receiptNumber: goodsReceipts.receiptNumber, matchedAmount: supplierInvoiceReceipts.matchedAmount, active: supplierInvoiceReceipts.active })
      .from(supplierInvoiceReceipts)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, supplierInvoiceReceipts.goodsReceiptId))
      .where(eq(supplierInvoiceReceipts.supplierInvoiceId, i.id))
      .orderBy(asc(goodsReceipts.receiptNumber));
    const payments = await db
      .select({ p: supplierPayments, allocated: supplierPaymentAllocations.amount })
      .from(supplierPaymentAllocations)
      .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.supplierPaymentId))
      .where(eq(supplierPaymentAllocations.supplierInvoiceId, i.id))
      .orderBy(asc(supplierPayments.paymentNumber));
    const notes = await db.select().from(supplierNotes).where(eq(supplierNotes.supplierInvoiceId, i.id)).orderBy(asc(supplierNotes.entryNumber));
    const [entry] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.sourceType, 'SUPPLIER_INVOICE'), eq(journalEntries.sourceId, i.id)));
    const [reversal] = entry ? await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.reversesEntryId, entry.id)) : [];
    const paid = payments.filter((x) => !x.p.voidedAt).reduce((a, x) => a.plus(x.allocated), new Dec(0));
    const noteSum = (kind: string) => notes.filter((n) => n.kind === kind).reduce((a, n) => a.plus(n.totalAmount), new Dec(0));
    const credited = noteSum('CREDIT');
    const debited = noteSum('DEBIT');
    const balance = toDec(i.totalAmount).plus(debited).minus(credited).minus(paid);
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
      creditedAmount: money(credited),
      debitedAmount: money(debited),
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
      /** `amount`: what the payment settles of this invoice; `paymentAmount`: the whole payment (it may settle others too). */
      payments: payments.map(({ p, allocated }) => ({
        id: p.id,
        paymentNumber: p.paymentNumber,
        amount: money(allocated),
        paymentAmount: money(p.amount),
        paidOn: p.paidOn,
        method: p.method,
        reference: p.reference,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
        status: p.voidedAt ? 'VOIDED' : 'RECORDED',
        voidedAt: p.voidedAt,
        voidReason: p.voidReason,
      })),
      /** Credit and debit notes (the `notes` field above is the free text entered with the invoice). */
      adjustments: notes.map(noteView),
    };
  }
}

function noteView(n: typeof supplierNotes.$inferSelect) {
  return {
    id: n.id,
    supplierInvoiceId: n.supplierInvoiceId,
    legalEntityId: n.legalEntityId,
    branchId: n.branchId,
    kind: n.kind,
    entryNumber: n.entryNumber,
    noteNumber: n.noteNumber,
    noteDate: n.noteDate,
    netAmount: money(n.netAmount),
    vatAmount: money(n.vatAmount),
    totalAmount: money(n.totalAmount),
    inputVat: money(n.inputVat),
    grniCleared: money(n.grniCleared),
    reason: n.reason,
    createdBy: n.createdBy,
    createdAt: n.createdAt,
  };
}

/** Debit notes less credit notes on invoice `i` (SQL, in a query over `supplier_invoices i`). */
const NOTES_SQL = sql`coalesce((SELECT sum(CASE n.kind WHEN 'DEBIT' THEN n.total_amount ELSE -n.total_amount END) FROM supplier_notes n WHERE n.supplier_invoice_id = i.id), 0)`;
/** What payments not voided settled of invoice `i`. */
const PAID_SQL = sql`coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.supplier_payment_id WHERE a.supplier_invoice_id = i.id AND p.voided_at IS NULL), 0)`;
