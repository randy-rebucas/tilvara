import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import {
  and,
  desc,
  eq,
  saleBeneficiaries,
  saleLines,
  sales,
  saleTenders,
  branches,
  cashMovements,
  inArray,
  legalEntities,
  registers,
  users,
  paymentEvents,
  paymentIntents,
  sql,
  stockMovements,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { CreateSaleInput, SaleListQuery } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { emitEvent } from '../outbox/outbox.js';
import { TaxService, unprocessable } from '../tax/tax.service.js';
import { loadSession } from './cash.service.js';
import { buildReceipt } from './receipt.js';
import { nextNumber } from '../common/sequence.js';
import { salePosting } from '@1pos/accounting';
import { post } from '../accounting/ledger.js';
import { planConsumption } from '../restaurant/consumption.js';

type SaleRow = typeof sales.$inferSelect;

const fixed = (v: string) => toDec(v).toFixed(2);
const MONEY_FIELDS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount',
  'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue',
] as const;

@Injectable()
export class SalesService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    sales_register_client_tx_unique: ['DUPLICATE_TRANSACTION', 'This register already recorded a sale with this transaction id'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    super(tenantDb);
  }

  /**
   * Checkout (SPEC §checkout workflow, cash tender). One transaction: lock the session, recompute
   * prices and taxes on the server, number the sale, write sale + lines + tenders + cash and
   * stock movements + audit + outbox. Any refusal leaves nothing behind; the required
   * Idempotency-Key makes retries return the original sale.
   */
  create(auth: AuthContext, input: CreateSaleInput) {
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      const { session, scope } = await loadSession(db, input.cashierSessionId, true);
      this.assertCan(auth, 'sales.create', scope);
      if (session.openedBy !== auth.userId) {
        throw new AppError('NOT_SESSION_OWNER', 'Sell on your own cashier session', HttpStatus.FORBIDDEN);
      }
      // A resubmit under a new key (e.g. after an unanswered request) points at the recorded sale,
      // so the counter can show its receipt instead of ringing it again. The unique index still
      // catches a concurrent duplicate (conflict map above).
      const [recorded] = await db
        .select({ id: sales.id, saleNumber: sales.saleNumber })
        .from(sales)
        .where(and(eq(sales.registerId, session.registerId), eq(sales.clientTransactionId, input.clientTransactionId)));
      if (recorded) {
        throw new AppError('DUPLICATE_TRANSACTION', 'This register already recorded a sale with this transaction id', HttpStatus.CONFLICT, {
          saleId: recorded.id,
          saleNumber: recorded.saleNumber,
        });
      }
      if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);

      const cart = await this.tax.computeCart(db, auth, {
        branchId: session.branchId,
        lines: input.lines.map(({ statutory, ...l }) => ({
          ...l,
          ...(statutory && { statutory: { scheme: statutory.scheme, ...(statutory.share && { share: statutory.share }) } }),
        })),
      });
      const due = toDec(cart.totals.amountDue);
      if (input.expectedAmountDue !== undefined && !toDec(input.expectedAmountDue).equals(due)) {
        throw new AppError('TOTAL_CHANGED', 'Prices or taxes changed since the cart was shown; review the new total', HttpStatus.CONFLICT, {
          amountDue: cart.totals.amountDue,
        });
      }
      if (cart.requiresProfessionalReview && this.env.NODE_ENV === 'production') {
        throw unprocessable('SCHEME_PENDING_REVIEW', 'Statutory discounts are disabled until a tax professional signs off the computation (ADR-0008)');
      }

      // Non-cash tenders: authorized payment intents of this checkout, locked and applied first (ADR-0010).
      const intentIds = input.tenders.flatMap((t) => (t.method === 'INTENT' ? [t.paymentIntentId] : []));
      if (new Set(intentIds).size !== intentIds.length) throw unprocessable('DUPLICATE_TENDER', 'A payment can be tendered once');
      const intents = intentIds.length
        ? await db.select().from(paymentIntents).where(inArray(paymentIntents.id, intentIds)).for('update')
        : [];
      for (const pid of intentIds) {
        const p = intents.find((x) => x.id === pid);
        if (!p) throw new AppError('NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND, { paymentIntentId: pid });
        if (p.saleId) throw new AppError('PAYMENT_CONSUMED', 'This payment already paid for another sale', HttpStatus.CONFLICT, { paymentIntentId: pid });
        if (p.status !== 'SUCCEEDED') {
          throw new AppError('PAYMENT_NOT_SUCCEEDED', `This payment is ${p.status.toLowerCase()}`, HttpStatus.CONFLICT, { paymentIntentId: pid, status: p.status });
        }
        if (p.cashierSessionId !== session.id || p.clientTransactionId !== input.clientTransactionId || p.currency !== cart.currency) {
          throw unprocessable('PAYMENT_MISMATCH', 'This payment was taken for a different checkout', { paymentIntentId: pid });
        }
      }
      const electronic = intents.reduce((a, p) => a.plus(p.amount), new Dec(0));
      if (electronic.gt(due)) throw unprocessable('OVERPAYMENT', 'Card/QR payments exceed the total; cancel one and take the exact amount', { amountDue: cart.totals.amountDue });

      // Cash covers the rest; only the last cash tender may give change.
      let remaining = due.minus(electronic);
      const cashTenders = input.tenders.flatMap((t, i) => (t.method === 'CASH' ? [{ t, i }] : []));
      const cash = cashTenders.map(({ t, i }) => {
        if (remaining.isZero() && !due.isZero()) throw unprocessable('UNNECESSARY_TENDER', 'The sale is already paid', { tender: i });
        const tendered = toDec(t.tendered);
        const applied = Dec.min(tendered, remaining);
        remaining = remaining.minus(applied);
        return { tendered, applied, change: tendered.minus(applied) };
      });
      if (remaining.gt(0)) throw unprocessable('INSUFFICIENT_TENDER', 'The tendered amount does not cover the total', { amountDue: cart.totals.amountDue });
      if (cash.slice(0, -1).some((t) => t.change.gt(0))) throw unprocessable('UNNECESSARY_TENDER', 'Only the last tender may give change');
      const cashApplied = cash.reduce((a, t) => a.plus(t.applied), new Dec(0));
      const tendered = cash.reduce((a, t) => a.plus(t.tendered), electronic);
      const change = tendered.minus(due);

      const saleNumber = await nextNumber(db, tenantId, session.registerId, 'SALE');
      const totals = Object.fromEntries(MONEY_FIELDS.map((k) => [k, cart.totals[k]])) as Record<(typeof MONEY_FIELDS)[number], string>;
      const [sale] = await db
        .insert(sales)
        .values({
          tenantId,
          legalEntityId: cart.legalEntityId,
          branchId: session.branchId,
          registerId: session.registerId,
          cashierSessionId: session.id,
          cashierUserId: auth.userId,
          clientTransactionId: input.clientTransactionId,
          saleNumber,
          currency: cart.currency,
          taxProfileId: cart.taxProfile.id,
          ...totals,
          amountTendered: tendered.toString(),
          changeDue: change.toString(),
          requiresProfessionalReview: cart.requiresProfessionalReview,
          taxSnapshot: cart.taxProfile,
        })
        .returning();

      const beneficiaryIds = new Map<string, string>();
      for (const b of input.beneficiaries) {
        const line = cart.lines.find((l, i) => input.lines[i]!.statutory?.beneficiary === b.ref);
        const scheme = line!.snapshot.scheme!;
        const [row] = await db
          .insert(saleBeneficiaries)
          .values({ tenantId, saleId: sale!.id, schemeCode: scheme.code, schemeVersion: scheme.version, name: b.name, idNumber: b.idNumber, tin: b.tin ?? null })
          .returning({ id: saleBeneficiaries.id });
        beneficiaryIds.set(b.ref, row!.id);
      }

      const lineRows = await db
        .insert(saleLines)
        .values(
          cart.lines.map((l, i) => {
            const statutory = input.lines[i]!.statutory;
            return {
              tenantId,
              saleId: sale!.id,
              lineNo: i + 1,
              clientLineId: l.id,
              variantId: l.variantId,
              sku: l.sku,
              name: l.name,
              taxCategoryCode: l.taxCategoryCode,
              vatTreatment: l.vatTreatment,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              priceIncludesTax: l.priceIncludesTax,
              priceId: l.priceId,
              priceListId: l.priceListId,
              ...Object.fromEntries(MONEY_FIELDS.map((k) => [k, l[k]])),
              beneficiaryId: statutory ? beneficiaryIds.get(statutory.beneficiary)! : null,
              schemeShare: statutory ? (l.snapshot.scheme?.share ?? '1') : null,
              taxSnapshot: l.snapshot,
            } as typeof saleLines.$inferInsert;
          }),
        )
        .returning({ id: saleLines.id, lineNo: saleLines.lineNo });

      await db.insert(saleTenders).values([
        ...intents.map((p) => ({ tenantId, saleId: sale!.id, method: p.method, paymentIntentId: p.id, amount: p.amount, tendered: p.amount, change: '0' })),
        ...cash.map((t) => ({ tenantId, saleId: sale!.id, method: 'CASH', amount: t.applied.toString(), tendered: t.tendered.toString(), change: t.change.toString() })),
      ]);
      for (const p of intents) {
        await db.update(paymentIntents).set({ saleId: sale!.id }).where(eq(paymentIntents.id, p.id));
        await db.insert(paymentEvents).values({ tenantId, paymentIntentId: p.id, type: 'CONSUMED', detail: { saleId: sale!.id }, createdBy: auth.userId });
      }
      // Net cash into the drawer = the cash part of the sale (tendered minus change).
      if (cash.length) {
        await db.insert(cashMovements).values({ tenantId, cashierSessionId: session.id, type: 'SALE', amount: cashApplied.toString(), saleId: sale!.id, createdBy: auth.userId });
      }

      const lineId = (i: number) => lineRows.find((r) => r.lineNo === i + 1)!.id;
      const stock: (typeof stockMovements.$inferInsert & { variantId: string })[] = cart.lines.flatMap((l, i) =>
        l.trackInventory
          ? [{
              tenantId,
              branchId: session.branchId,
              variantId: l.variantId,
              quantity: toDec(l.quantity).negated().toString(),
              type: 'SALE',
              saleId: sale!.id,
              saleLineId: lineId(i),
              createdBy: auth.userId,
            }]
          : [],
      );
      // Items made from a recipe consume their ingredients with the sale (ADR-0014 §4).
      const consumed = await planConsumption(
        db,
        cart.lines.flatMap((l, i) => (l.trackInventory ? [] : [{ saleLineId: lineId(i), variantId: l.variantId, quantity: l.quantity }])),
      );
      for (const c of consumed) {
        stock.push({ tenantId, branchId: session.branchId, ...c, type: 'CONSUMPTION', saleId: sale!.id, createdBy: auth.userId });
      }
      // Sorted by variant: concurrent sales lock balance rows in the same order (ADR-0012 §7).
      const moved = stock.length
        ? await db.insert(stockMovements).values(stock.sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))).returning({ value: stockMovements.value })
        : [];

      // Books (ADR-0013): money in, revenue and output VAT, COGS at the ledger's cost — same transaction.
      const t = cart.totals;
      await post(db, {
        tenantId,
        legalEntityId: cart.legalEntityId,
        branchId: session.branchId,
        sourceType: 'SALE',
        sourceId: sale!.id,
        memo: `Sale #${saleNumber}`,
        lines: salePosting({
          salesExVat: toDec(t.vatableSales).plus(t.vatExemptSales).plus(t.zeroRatedSales).plus(t.percentageTaxSales),
          vatAmount: t.vatAmount,
          statutoryDiscount: t.statutoryDiscount,
          cash: cashApplied,
          electronic: electronic,
          cogs: moved.reduce((a, m) => a.minus(m.value), new Dec(0)),
        }, session.branchId),
        createdBy: auth.userId,
      });

      await this.audit(db, auth, 'sale.completed', 'sale', sale!.id, { saleNumber, amountDue: cart.totals.amountDue, registerId: session.registerId });
      await emitEvent(db, {
        tenantId,
        topic: 'sale.completed',
        payload: { saleId: sale!.id, registerId: session.registerId, branchId: session.branchId, saleNumber },
        correlationId: auth.correlationId,
      });
      return this.view(db, sale!);
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [sale] = await db.select().from(sales).where(eq(sales.id, id));
      if (!sale) throw notFound('Sale');
      this.assertCanRead(auth, sale);
      return this.view(db, sale);
    });
  }

  /** Receipt data (not an invoice while invoicing is DISABLED), built from the sale's own snapshot. */
  receipt(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [sale] = await db.select().from(sales).where(eq(sales.id, id));
      if (!sale) throw notFound('Sale');
      this.assertCanRead(auth, sale);
      const [[entity], [branch], [register], [cashier], lines, tenders, beneficiaries] = await Promise.all([
        db.select().from(legalEntities).where(eq(legalEntities.id, sale.legalEntityId)),
        db.select().from(branches).where(eq(branches.id, sale.branchId)),
        db.select().from(registers).where(eq(registers.id, sale.registerId)),
        db.select({ displayName: users.displayName }).from(users).where(eq(users.id, sale.cashierUserId)),
        db.select().from(saleLines).where(eq(saleLines.saleId, id)).orderBy(saleLines.lineNo),
        db.select().from(saleTenders).where(eq(saleTenders.saleId, id)).orderBy(saleTenders.createdAt, saleTenders.id),
        db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, id)),
      ]);
      const snapshot = sale.taxSnapshot as { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string };
      return buildReceipt({
        invoicingMode: entity!.invoicingMode,
        seller: { registeredName: entity!.registeredName, tradeName: entity!.tradeName, registeredAddress: entity!.registeredAddress, tin: entity!.tin, vatStatus: snapshot.vatStatus },
        branch: { name: branch!.name, code: branch!.code, birBranchCode: branch!.birBranchCode, address: branch!.address, timezone: branch!.timezone },
        register: { code: register!.code, name: register!.name },
        cashierName: cashier?.displayName ?? 'Cashier',
        sale: {
          ...Object.fromEntries([...MONEY_FIELDS, 'amountTendered', 'changeDue'].map((k) => [k, fixed(sale[k as keyof SaleRow] as string)])),
          saleNumber: sale.saleNumber,
          completedAt: sale.completedAt,
          currency: sale.currency,
          vatRate: snapshot.vatRate,
        } as Parameters<typeof buildReceipt>[0]['sale'],
        lines: lines.map((l) => ({
          name: l.name,
          quantity: toDec(l.quantity).toString(),
          unitPrice: l.unitPrice,
          gross: l.gross,
          discount: l.discount,
          statutoryDiscount: l.statutoryDiscount,
          vatTreatment: l.vatTreatment,
          vatableSales: l.vatableSales,
          vatExemptSales: l.vatExemptSales,
          beneficiaryId: l.beneficiaryId,
        })),
        tenders: tenders.map((t) => ({ method: t.method, amount: fixed(t.amount), tendered: fixed(t.tendered), change: fixed(t.change) })),
        beneficiaries,
      });
    });
  }

  list(auth: AuthContext, q: SaleListQuery) {
    return this.read(auth, async (db) => {
      const rows = await db
        .select()
        .from(sales)
        .where(
          and(
            q.cashierSessionId ? eq(sales.cashierSessionId, q.cashierSessionId) : undefined,
            q.registerId ? eq(sales.registerId, q.registerId) : undefined,
            q.cursor ? sql`${sales.id} < ${q.cursor}` : undefined,
          ),
        )
        .orderBy(desc(sales.id))
        .limit(q.limit + 1);
      const visible = rows.filter((s) => this.canRead(auth, s));
      const page = visible.slice(0, q.limit);
      return {
        data: page.map((s) => this.summary(s)),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    });
  }

  private canRead(auth: AuthContext, s: SaleRow) {
    const scope = { legalEntityId: s.legalEntityId, branchId: s.branchId, registerId: s.registerId };
    return this.can(auth, 'sales.read', scope) || s.cashierUserId === auth.userId;
  }

  private assertCanRead(auth: AuthContext, s: SaleRow) {
    if (!this.canRead(auth, s)) this.assertCan(auth, 'sales.read', { legalEntityId: s.legalEntityId, branchId: s.branchId, registerId: s.registerId });
  }

  private summary(s: SaleRow) {
    const out: Record<string, unknown> = { ...s };
    for (const k of [...MONEY_FIELDS, 'amountTendered', 'changeDue'] as const) out[k] = fixed(s[k]);
    return out;
  }

  private async view(db: Database, s: SaleRow) {
    const { rows: returned } = await db.execute<{ sale_line_id: string; quantity: string }>(
      sql`SELECT rl.sale_line_id, sum(rl.quantity)::text AS quantity FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.sale_return_id WHERE r.sale_id = ${s.id} GROUP BY 1`,
    );
    const [lines, tenders, beneficiaries] = await Promise.all([
      db.select().from(saleLines).where(eq(saleLines.saleId, s.id)).orderBy(saleLines.lineNo),
      db.select().from(saleTenders).where(eq(saleTenders.saleId, s.id)),
      db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, s.id)),
    ]);
    return {
      ...this.summary(s),
      lines: lines.map((l) => {
        const back = returned.find((r) => r.sale_line_id === l.id)?.quantity ?? '0';
        const out: Record<string, unknown> = { ...l, quantity: toDec(l.quantity).toString(), unitPrice: toDec(l.unitPrice).toString(), returnedQuantity: toDec(back).toString() };
        for (const k of MONEY_FIELDS) out[k] = fixed(l[k]);
        return out;
      }),
      tenders: tenders.map((t) => ({ ...t, amount: fixed(t.amount), tendered: fixed(t.tendered), change: fixed(t.change) })),
      beneficiaries,
    };
  }
}
