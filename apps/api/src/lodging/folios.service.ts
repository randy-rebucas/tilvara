import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { folioPaymentPosting, roomChargePosting } from '@1pos/accounting';
import {
  and,
  branches,
  cashMovements,
  customerCreditEntries,
  eq,
  folioEntries,
  folioPayments,
  folios,
  legalEntities,
  rooms,
  roomTypes,
  sql,
  stayDeposits,
  stays,
  type Database,
} from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { FolioAdjustmentInput, FolioPaymentInput, NightAuditInput, NightReversalInput } from '@1pos/validation';
import { post } from '../accounting/ledger.js';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { assertLodging, assertWritable } from '../billing/entitlements.js';
import { effectiveNow } from '../common/clock.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { creditBalance } from '../customers/customers.service.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { branchScope } from '../purchasing/purchase-orders.service.js';
import { TaxService, unprocessable } from '../tax/tax.service.js';
import { depositView } from './deposits.service.js';
import { depositsHeld, folioBalance, folioSettled, insertEntry, liabilityAtStayBranch, lockFolio, openJournalDate, stayGuestName, type FolioEntryRow, type FolioRow } from './folio.js';
import { consumeFolioIntent, frontDeskSession } from './front-desk.js';
import { BUCKETS, exVatOf, inHouseStays, postDueNights, signedBuckets, type Buckets } from './night-audit.js';

const money = (v: string | null) => (v === null ? null : toDec(v).toFixed(2));
const MONEY_KEYS = ['amount', 'unitPrice', ...BUCKETS] as const;
export const entryView = (e: FolioEntryRow) => {
  const o: Record<string, unknown> = { ...e };
  for (const k of MONEY_KEYS) o[k] = money(e[k]);
  return o;
};
const paymentView = (p: typeof folioPayments.$inferSelect) => ({ ...p, amount: money(p.amount), tendered: money(p.tendered), change: money(p.change) });

/**
 * Folios (ADR-0023 §5): the guest ledger of a stay, its entries, payments at the front desk,
 * adjustments, night reversals and the statement; the night audit run now for a branch.
 */
@Injectable()
export class FoliosService extends TenantService {
  private readonly logger = new Logger('NightAudit');
  protected readonly conflicts: ConflictMap = {
    folio_entries_folio_open: ['FOLIO_SETTLED', 'This folio is settled and takes no more entries'],
    folio_entries_overpaid: ['FOLIO_OVERPAID', 'The folio would owe the guest money'],
    folio_entries_reversal_once: ['ALREADY_REVERSED', 'This night was already reversed'],
    folio_entries_night_once: ['NIGHT_ALREADY_POSTED', 'This night is already on the folio'],
    folio_payments_intent_once: ['PAYMENT_CONSUMED', 'This payment was already used'],
    customer_credit_balance: ['INSUFFICIENT_STORE_CREDIT', 'The customer has less store credit than that'],
  };

  constructor(
    @Inject(TenantDb) tenantDb: TenantDb,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {
    super(tenantDb);
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const folio = await this.load(db, id);
      this.assertCan(auth, 'lodging.read', { branchId: folio.branchId, legalEntityId: folio.legalEntityId });
      return this.view(db, folio);
    });
  }

  ofStay(auth: AuthContext, stayId: string) {
    return this.read(auth, async (db) => {
      const [stay] = await db.select().from(stays).where(eq(stays.id, stayId));
      if (!stay) throw notFound('Stay');
      this.assertCan(auth, 'lodging.read', { branchId: stay.branchId, legalEntityId: stay.legalEntityId });
      const [folio] = await db.select().from(folios).where(eq(folios.stayId, stayId));
      if (!folio) throw notFound('Folio');
      return this.view(db, folio);
    });
  }

  /** What the guest is shown and signs at check-out: "Guest folio — not an invoice" while invoicing is disabled. */
  statement(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const folio = await this.load(db, id);
      this.assertCan(auth, 'lodging.read', { branchId: folio.branchId, legalEntityId: folio.legalEntityId });
      const [[entity], [branch], [stay]] = [
        await db.select().from(legalEntities).where(eq(legalEntities.id, folio.legalEntityId)),
        await db.select().from(branches).where(eq(branches.id, folio.branchId)),
        await db.select().from(stays).where(eq(stays.id, folio.stayId)),
      ];
      const [[room], [type]] = [
        await db.select({ number: rooms.number }).from(rooms).where(eq(rooms.id, stay!.roomId)),
        await db.select({ name: roomTypes.name }).from(roomTypes).where(eq(roomTypes.id, stay!.roomTypeId)),
      ];
      const entries = await db.select().from(folioEntries).where(eq(folioEntries.folioId, id)).orderBy(folioEntries.createdAt, folioEntries.id);
      // A night reversal counts with what it reverses: the room night, or the night's accommodation tax.
      const kindOf = new Map(entries.map((e) => [e.id, e.kind]));
      const kindFor = (e: FolioEntryRow) => (e.kind === 'NIGHT_REVERSAL' && e.relatedEntryId ? (kindOf.get(e.relatedEntryId) ?? 'ROOM_NIGHT') : e.kind);
      const sum = (kinds: string[]) => entries.filter((e) => kinds.includes(kindFor(e))).reduce((a, e) => a.plus(e.amount), new Dec(0)).toFixed(2);
      return {
        title: entity!.invoicingMode === 'DISABLED' ? 'Guest folio — not an invoice' : 'Guest folio',
        invoicingMode: entity!.invoicingMode,
        seller: { registeredName: entity!.registeredName, tradeName: entity!.tradeName, tin: entity!.tin, registeredAddress: entity!.registeredAddress },
        branch: { name: branch!.name, address: branch!.address },
        folio: { id: folio.id, status: folio.status, openedAt: folio.openedAt, settledAt: folio.settledAt, currency: folio.currency },
        stay: { id: stay!.id, roomNumber: room!.number, roomType: type!.name, arrivalDate: stay!.arrivalDate, departureDate: stay!.departureDate, guestName: await stayGuestName(db, stay!) },
        lines: entries.map((e) => ({ id: e.id, date: e.nightDate ?? e.createdAt.toISOString().slice(0, 10), kind: e.kind, description: e.description ?? e.kind, amount: money(e.amount), vatAmount: money(e.vatAmount) })),
        totals: {
          roomNights: sum(['ROOM_NIGHT']),
          accommodationTax: sum(['ACCOMMODATION_TAX']),
          charges: sum(['CHARGE', 'CHARGE_RETURN']),
          adjustments: sum(['ADJUSTMENT']),
          deposits: sum(['DEPOSIT_APPLIED']),
          payments: sum(['PAYMENT']),
          balance: entries.reduce((a, e) => a.plus(e.amount), new Dec(0)).toFixed(2),
        },
        signatureLine: 'Guest signature',
      };
    });
  }

  /** Settle (part of) a folio at an open cashier session (§5.2). */
  pay(auth: AuthContext, id: string, input: FolioPaymentInput) {
    return this.mutate(auth, async (db) => {
      const folio = await this.load(db, id, true);
      const scope = { branchId: folio.branchId, legalEntityId: folio.legalEntityId };
      this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      if (folio.status !== 'OPEN') throw folioSettled();
      await lockFolio(db, folio.id);
      const { session } = await frontDeskSession(db, auth, input.cashierSessionId, folio.legalEntityId);
      const balance = await folioBalance(db, folio.id);
      if (balance.lte(0)) throw new AppError('NOTHING_TO_PAY', 'This folio has nothing to pay', HttpStatus.CONFLICT, { balance: balance.toFixed(2) });
      const [stay] = await db.select().from(stays).where(eq(stays.id, folio.stayId));
      const tenantId = tenantOf(auth).tenantId;
      let method: string;
      let amount: Dec;
      let tendered: Dec;
      let intentId: string | null = null;
      let reference: string | null = null;
      if (input.method === 'CASH') {
        method = 'CASH';
        tendered = toDec(input.tendered);
        amount = Dec.min(tendered, balance);
      } else if (input.method === 'INTENT') {
        const p = await consumeFolioIntent(db, auth, { paymentIntentId: input.paymentIntentId, sessionId: session.id, folioId: folio.id, currency: folio.currency, consumer: { folioPayment: true } });
        if (toDec(p.amount).gt(balance)) throw unprocessable('OVERPAYMENT', 'The card/QR payment is more than the balance; cancel it and take the exact amount', { balance: balance.toFixed(2) });
        method = p.method;
        amount = tendered = toDec(p.amount);
        intentId = p.id;
      } else {
        amount = tendered = toDec(input.amount);
        if (amount.gt(balance)) throw unprocessable('OVERPAYMENT', 'More than the balance', { balance: balance.toFixed(2) });
        if (input.method === 'STORE_CREDIT') {
          if (!stay!.customerId) throw unprocessable('STORE_CREDIT_NEEDS_CUSTOMER', 'Store credit needs the stay\'s customer');
          await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${stay!.customerId}:${folio.legalEntityId}`}, 0))`);
          const held = await creditBalance(db, stay!.customerId, folio.legalEntityId);
          if (held.lt(amount)) throw new AppError('INSUFFICIENT_STORE_CREDIT', 'The customer has less store credit than that', HttpStatus.CONFLICT, { balance: held.toFixed(2) });
          method = 'STORE_CREDIT';
        } else {
          this.assertCan(auth, 'lodging.rates', scope);
          method = 'BANK_TRANSFER';
          reference = input.reference;
        }
      }
      const change = tendered.minus(amount);
      const [payment] = await db
        .insert(folioPayments)
        .values({
          tenantId, folioId: folio.id, legalEntityId: folio.legalEntityId, branchId: session.branchId, registerId: session.registerId, cashierSessionId: session.id,
          method, amount: amount.toString(), tendered: tendered.toString(), change: change.toString(), paymentIntentId: intentId, reference, createdBy: auth.userId,
        })
        .returning();
      if (method === 'CASH') {
        await db.insert(cashMovements).values({ tenantId, cashierSessionId: session.id, type: 'FOLIO_PAYMENT', amount: amount.toString(), folioPaymentId: payment!.id, reason: 'Guest folio', createdBy: auth.userId });
      }
      if (method === 'STORE_CREDIT') {
        await db.insert(customerCreditEntries).values({
          tenantId, legalEntityId: folio.legalEntityId, branchId: session.branchId, customerId: stay!.customerId!, kind: 'FOLIO_PAYMENT', amount: amount.negated().toString(), folioPaymentId: payment!.id, createdBy: auth.userId,
        });
      }
      const entry = await insertEntry(db, {
        tenantId, folioId: folio.id, stayId: folio.stayId, kind: 'PAYMENT', amount: amount.negated().toString(), description: `Payment (${method.toLowerCase().replace('_', ' ')})`,
        folioPaymentId: payment!.id, createdBy: auth.userId,
      }, auth.correlationId);
      const via = method === 'CASH' ? 'CASH' : method === 'STORE_CREDIT' ? 'STORE_CREDIT' : method === 'BANK_TRANSFER' ? 'BANK' : 'ELECTRONIC';
      await post(db, {
        tenantId, legalEntityId: folio.legalEntityId, branchId: session.branchId, sourceType: 'FOLIO_PAYMENT', sourceId: payment!.id, memo: 'Guest folio payment',
        lines: liabilityAtStayBranch(folioPaymentPosting(amount, via, session.branchId), 'GUEST_LEDGER', folio.branchId), createdBy: auth.userId,
      });
      await this.audit(db, auth, 'folio.payment', 'folio', folio.id, { folioPaymentId: payment!.id, entryId: entry.id, method, amount: amount.toFixed(2) });
      return { payment: paymentView(payment!), entry: entryView(entry), balance: (await folioBalance(db, folio.id)).toFixed(2) };
    });
  }

  /** A goodwill credit (negative) or a manual fee (positive), VAT-inclusive, VAT by @1pos/tax with the room night's category (`lodging.rates`). */
  adjust(auth: AuthContext, id: string, input: FolioAdjustmentInput) {
    return this.mutate(auth, async (db) => {
      const folio = await this.load(db, id, true);
      this.assertCan(auth, 'lodging.rates', { branchId: folio.branchId, legalEntityId: folio.legalEntityId });
      await assertLodging(db);
      if (folio.status !== 'OPEN') throw folioSettled();
      await lockFolio(db, folio.id);
      const [stay] = await db.select().from(stays).where(eq(stays.id, folio.stayId));
      const [type] = await db.select().from(roomTypes).where(eq(roomTypes.id, stay!.roomTypeId));
      const amount = toDec(input.amount);
      const sign = amount.isNegative() ? -1 : 1;
      const priced = await this.tax.computeRoomCharge(db, { branchId: folio.branchId, variantId: type!.nightVariantId, at: await effectiveNow(db), unitPrice: amount.abs().toString(), inclusive: true });
      const t = priced.totals as Buckets;
      const b = signedBuckets(t, sign);
      const today = (await db.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE b.timezone)::date::text AS d FROM branches b WHERE b.id = ${folio.branchId}`)).rows[0]!.d;
      const journalDate = await openJournalDate(db, folio.legalEntityId, today);
      const entry = await insertEntry(db, {
        tenantId: folio.tenantId, folioId: folio.id, stayId: folio.stayId, kind: 'ADJUSTMENT', amount: toDec(t.amountDue).times(sign).toString(),
        description: input.description ?? (sign < 0 ? 'Credit' : 'Charge'), reason: input.reason, ...b,
        unitPrice: priced.unitPrice, variantId: type!.nightVariantId, taxCategoryCode: priced.taxCategoryCode, vatTreatment: priced.vatTreatment, taxProfileId: priced.taxProfile.id,
        taxSnapshot: { vatStatus: priced.taxProfile.vatStatus, vatRate: priced.taxProfile.vatRate, roundingMode: priced.taxProfile.roundingMode, pricedAt: priced.at },
        journalDate, createdBy: auth.userId,
      }, auth.correlationId);
      await post(db, {
        tenantId: folio.tenantId, legalEntityId: folio.legalEntityId, branchId: folio.branchId, entryDate: journalDate, sourceType: 'FOLIO_ENTRY', sourceId: entry.id,
        memo: `Folio adjustment: ${input.reason}`,
        lines: roomChargePosting({ exVat: exVatOf(b), vatAmount: b.vatAmount, statutoryDiscount: b.statutoryDiscount }, folio.branchId),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'folio.adjusted', 'folio', folio.id, { entryId: entry.id, amount: toDec(entry.amount).toFixed(2), reason: input.reason });
      return { entry: entryView(entry), balance: (await folioBalance(db, folio.id)).toFixed(2) };
    });
  }

  /** Undo a night (and its accommodation tax) charged by mistake, once (`lodging.rates`). */
  reverseNight(auth: AuthContext, id: string, input: NightReversalInput) {
    return this.mutate(auth, async (db) => {
      const folio = await this.load(db, id, true);
      this.assertCan(auth, 'lodging.rates', { branchId: folio.branchId, legalEntityId: folio.legalEntityId });
      await assertLodging(db);
      if (folio.status !== 'OPEN') throw folioSettled();
      await lockFolio(db, folio.id);
      const [night] = await db.select().from(folioEntries).where(and(eq(folioEntries.id, input.entryId), eq(folioEntries.folioId, folio.id)));
      if (!night) throw new AppError('NOT_FOUND', 'Folio entry not found', HttpStatus.NOT_FOUND, { entryId: input.entryId });
      if (night.kind !== 'ROOM_NIGHT') throw unprocessable('NOT_A_NIGHT', 'Only a room night is reversed; adjust anything else');
      const [done] = await db.select({ id: folioEntries.id }).from(folioEntries).where(and(eq(folioEntries.relatedEntryId, night.id), eq(folioEntries.kind, 'NIGHT_REVERSAL')));
      if (done) throw new AppError('ALREADY_REVERSED', 'This night was already reversed', HttpStatus.CONFLICT, { reversalId: done.id });
      const [tax] = await db.select().from(folioEntries).where(and(eq(folioEntries.relatedEntryId, night.id), eq(folioEntries.kind, 'ACCOMMODATION_TAX')));
      const today = (await db.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE b.timezone)::date::text AS d FROM branches b WHERE b.id = ${folio.branchId}`)).rows[0]!.d;
      const journalDate = await openJournalDate(db, folio.legalEntityId, today);
      const nb = Object.fromEntries(BUCKETS.map((k) => [k, toDec(night[k] ?? '0').negated().toString()])) as Record<(typeof BUCKETS)[number], string>;
      const reversal = await insertEntry(db, {
        tenantId: folio.tenantId, folioId: folio.id, stayId: folio.stayId, kind: 'NIGHT_REVERSAL', amount: toDec(night.amount).negated().toString(), nightDate: night.nightDate,
        description: `Reversal — ${night.description ?? `night of ${night.nightDate}`}`, reason: input.reason, relatedEntryId: night.id, ...nb,
        unitPrice: night.unitPrice, variantId: night.variantId, taxCategoryCode: night.taxCategoryCode, vatTreatment: night.vatTreatment, taxProfileId: night.taxProfileId,
        taxSnapshot: night.taxSnapshot, journalDate, createdBy: auth.userId,
      }, auth.correlationId);
      const taxBack = tax
        ? await insertEntry(db, {
            tenantId: folio.tenantId, folioId: folio.id, stayId: folio.stayId, kind: 'NIGHT_REVERSAL', amount: toDec(tax.amount).negated().toString(), nightDate: tax.nightDate,
            description: `Reversal — ${tax.description ?? 'accommodation tax'}`, reason: input.reason, relatedEntryId: tax.id, journalDate, createdBy: auth.userId,
          }, auth.correlationId)
        : null;
      await post(db, {
        tenantId: folio.tenantId, legalEntityId: folio.legalEntityId, branchId: folio.branchId, entryDate: journalDate, sourceType: 'FOLIO_ENTRY', sourceId: reversal.id,
        memo: `Night reversed (${night.nightDate}): ${input.reason}`,
        lines: roomChargePosting({ exVat: exVatOf(nb), vatAmount: nb.vatAmount, statutoryDiscount: nb.statutoryDiscount, accommodationTax: tax ? toDec(tax.amount).negated() : 0 }, folio.branchId),
        createdBy: auth.userId,
      });
      await this.audit(db, auth, 'folio.night_reversed', 'folio', folio.id, { entryId: night.id, reversalId: reversal.id, nightDate: night.nightDate, reason: input.reason });
      return { entries: [entryView(reversal), ...(taxBack ? [entryView(taxBack)] : [])], balance: (await folioBalance(db, folio.id)).toFixed(2) };
    });
  }

  /**
   * The night audit now, for one branch (§7): every in-house stay's nights that are due, each stay in
   * its own transaction as the scheduler does, so one stay that cannot post (a closed period, a missing
   * price) is reported in `failed` and the others still post. Overstays (in house past the departure
   * date) are counted; their nights past the departure are charged at check-out.
   */
  async runNightAudit(auth: AuthContext, input: NightAuditInput) {
    if (tenantOf(auth).status === 'SUSPENDED') throw new AppError('TENANT_SUSPENDED', 'This business is suspended; records are read-only', HttpStatus.FORBIDDEN);
    const work = await this.read(auth, async (db) => {
      const { scope } = await branchScope(db, input.branchId);
      this.assertCan(auth, 'lodging.manage', scope);
      await assertLodging(db);
      await assertWritable(db);
      return inHouseStays(db, input.branchId);
    });
    const posted: { stayId: string; nights: string[] }[] = [];
    const failed: { stayId: string; code: string; message: string }[] = [];
    for (const s of work) {
      try {
        const nights = await this.mutate(auth, (db) =>
          postDueNights(db, this.tax, s.id, { tenantId: tenantOf(auth).tenantId, userId: auth.userId, correlationId: auth.correlationId ?? null, through: 'DUE', production: this.env.NODE_ENV === 'production' }));
        if (nights.length) posted.push({ stayId: s.id, nights });
      } catch (e) {
        const err = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'NIGHT_NOT_POSTED', message: 'This stay could not be posted; try again or check its folio' };
        this.logger.warn({ msg: 'night audit could not post a stay', stayId: s.id, code: err.code });
        failed.push({ stayId: s.id, ...err });
      }
    }
    const overstays = work.filter((s) => s.overstay).map((s) => s.id);
    return { branchId: input.branchId, nights: posted.reduce((a, p) => a + p.nights.length, 0), stays: posted, failed, overstays: overstays.length, overstayStayIds: overstays };
  }

  // ---------------------------------------------------------------- helpers

  /**
   * With `lock`: the folio's advisory lock first, then its row (FOR NO KEY UPDATE), the order every
   * other path takes (check-out, the night audit, a room charge, the folio-entry trigger), so two
   * writers of one folio never wait on each other in a cycle.
   */
  private async load(db: Database, id: string, lock = false): Promise<FolioRow> {
    const q = () => db.select().from(folios).where(eq(folios.id, id));
    let [row] = await q();
    if (!row) throw notFound('Folio');
    if (lock) {
      await lockFolio(db, row.id);
      [row] = await q().for('no key update');
    }
    return row!;
  }

  private async view(db: Database, folio: FolioRow) {
    const [entries, payments, deposits, [stay]] = [
      await db.select().from(folioEntries).where(eq(folioEntries.folioId, folio.id)).orderBy(folioEntries.createdAt, folioEntries.id),
      await db.select().from(folioPayments).where(eq(folioPayments.folioId, folio.id)).orderBy(folioPayments.createdAt),
      await db.select().from(stayDeposits).where(eq(stayDeposits.stayId, folio.stayId)).orderBy(stayDeposits.createdAt, stayDeposits.id),
      await db.select().from(stays).where(eq(stays.id, folio.stayId)),
    ];
    const [room] = await db.select({ number: rooms.number }).from(rooms).where(eq(rooms.id, stay!.roomId));
    return {
      ...folio,
      stay: { id: stay!.id, status: stay!.status, roomNumber: room!.number, arrivalDate: stay!.arrivalDate, departureDate: stay!.departureDate, guestName: await stayGuestName(db, stay!) },
      balance: entries.reduce((a, e) => a.plus(e.amount), new Dec(0)).toFixed(2),
      depositsHeld: (await depositsHeld(db, folio.stayId)).toFixed(2),
      entries: entries.map(entryView),
      payments: payments.map(paymentView),
      deposits: deposits.map(depositView),
    };
  }
}
