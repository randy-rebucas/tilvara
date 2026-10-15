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
  cashMovements,
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

type SaleRow = typeof sales.$inferSelect;

const fixed = (v: string) => toDec(v).toFixed(2);
const MONEY_FIELDS = [
  'gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount',
  'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue',
] as const;

/** Next value of a gapless per-scope counter, under the counter row's lock (rolls back with the tx). */
async function nextNumber(db: Database, tenantId: string, scopeId: string, name: string): Promise<number> {
  const { rows } = await db.execute<{ value: string }>(sql`
    INSERT INTO sequence_counters (tenant_id, scope_id, name, next_value) VALUES (${tenantId}, ${scopeId}, ${name}, 2)
    ON CONFLICT (tenant_id, scope_id, name) DO UPDATE SET next_value = sequence_counters.next_value + 1
    RETURNING (next_value - 1)::text AS value`);
  return Number(rows[0]!.value);
}

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
      if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);
      if (session.openedBy !== auth.userId) {
        throw new AppError('NOT_SESSION_OWNER', 'Sell on your own cashier session', HttpStatus.FORBIDDEN);
      }

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

      // Tenders: apply in order; only the last tender may produce change.
      let remaining = due;
      const tenders = input.tenders.map((t, i) => {
        if (remaining.isZero() && !due.isZero()) throw unprocessable('UNNECESSARY_TENDER', 'The sale is already paid', { tender: i });
        const tendered = toDec(t.tendered);
        const applied = Dec.min(tendered, remaining);
        remaining = remaining.minus(applied);
        return { method: t.method, tendered, applied, change: tendered.minus(applied) };
      });
      if (remaining.gt(0)) throw unprocessable('INSUFFICIENT_TENDER', 'The tendered amount does not cover the total', { amountDue: cart.totals.amountDue });
      if (tenders.slice(0, -1).some((t) => t.change.gt(0))) throw unprocessable('UNNECESSARY_TENDER', 'Only the last tender may give change');
      const tendered = tenders.reduce((a, t) => a.plus(t.tendered), new Dec(0));
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

      await db.insert(saleTenders).values(
        tenders.map((t) => ({
          tenantId,
          saleId: sale!.id,
          method: t.method,
          amount: t.applied.toString(),
          tendered: t.tendered.toString(),
          change: t.change.toString(),
        })),
      );
      // Net cash into the drawer = what the sale cost (tendered minus change).
      await db.insert(cashMovements).values({ tenantId, cashierSessionId: session.id, type: 'SALE', amount: due.toString(), saleId: sale!.id, createdBy: auth.userId });

      const stock = cart.lines.flatMap((l, i) =>
        l.trackInventory
          ? [{
              tenantId,
              branchId: session.branchId,
              variantId: l.variantId,
              quantity: toDec(l.quantity).negated().toString(),
              type: 'SALE',
              saleId: sale!.id,
              saleLineId: lineRows.find((r) => r.lineNo === i + 1)!.id,
              createdBy: auth.userId,
            }]
          : [],
      );
      if (stock.length) await db.insert(stockMovements).values(stock);

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
    const [lines, tenders, beneficiaries] = await Promise.all([
      db.select().from(saleLines).where(eq(saleLines.saleId, s.id)).orderBy(saleLines.lineNo),
      db.select().from(saleTenders).where(eq(saleTenders.saleId, s.id)),
      db.select().from(saleBeneficiaries).where(eq(saleBeneficiaries.saleId, s.id)),
    ]);
    return {
      ...this.summary(s),
      lines: lines.map((l) => {
        const out: Record<string, unknown> = { ...l, quantity: toDec(l.quantity).toString(), unitPrice: toDec(l.unitPrice).toString() };
        for (const k of MONEY_FIELDS) out[k] = fixed(l[k]);
        return out;
      }),
      tenders: tenders.map((t) => ({ ...t, amount: fixed(t.amount), tendered: fixed(t.tendered), change: fixed(t.change) })),
      beneficiaries,
    };
  }
}
