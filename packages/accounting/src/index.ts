/**
 * Posting rules for the double-entry ledger (ADR-0013). Pure: no I/O, no clock. Every builder
 * returns a balanced set of lines or throws — an unbalanced entry can never leave this package.
 */
import { Dec, toDec } from '@1pos/money';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

/** System accounts every legal entity has (seeded with its chart). */
export const DEFAULT_CHART = [
  { key: 'CASH_ON_HAND', code: '1010', name: 'Cash on hand', type: 'ASSET' },
  { key: 'PAYMENT_CLEARING', code: '1020', name: 'Card/QR clearing', type: 'ASSET' },
  { key: 'CASH_IN_BANK', code: '1030', name: 'Cash in bank', type: 'ASSET' },
  // Session 28 (ADR-0023 §5): what in-house and departed guests owe on their folios.
  { key: 'GUEST_LEDGER', code: '1150', name: 'Guest ledger', type: 'ASSET' },
  { key: 'INVENTORY', code: '1200', name: 'Inventory', type: 'ASSET' },
  { key: 'INVENTORY_IN_TRANSIT', code: '1210', name: 'Inventory in transit', type: 'ASSET' },
  { key: 'INPUT_VAT', code: '1300', name: 'Input VAT', type: 'ASSET' },
  { key: 'ACCOUNTS_PAYABLE', code: '2000', name: 'Accounts payable – trade', type: 'LIABILITY' },
  { key: 'GRNI', code: '2010', name: 'Goods received not invoiced', type: 'LIABILITY' },
  { key: 'OUTPUT_VAT', code: '2100', name: 'Output VAT payable', type: 'LIABILITY' },
  // ADR-0023 §10: a local tax on room charges, owed to the LGU. Rate and base unverified (tax adviser).
  { key: 'ACCOMMODATION_TAX_PAYABLE', code: '2120', name: 'Accommodation tax payable', type: 'LIABILITY' },
  { key: 'SERVICE_CHARGE_PAYABLE', code: '2200', name: 'Service charge payable', type: 'LIABILITY' },
  // Session 25: tips are the staff's, never sales; paid out from the drawer. Pending the accountant.
  { key: 'TIPS_PAYABLE', code: '2210', name: 'Tips payable', type: 'LIABILITY' },
  // Session 20 (ADR-0018): refunds given as store credit, owed to customers until spent. Pending the accountant.
  { key: 'CUSTOMER_STORE_CREDIT', code: '2300', name: 'Customer store credit', type: 'LIABILITY' },
  // Session 27 (ADR-0022 §6): service packages paid for and not used yet, ex VAT. Pending the accountant.
  { key: 'PREPAID_SERVICES', code: '2310', name: 'Prepaid service packages', type: 'LIABILITY' },
  // ADR-0023 §6: booking deposits held without VAT until applied or forfeited. Pending the accountant.
  { key: 'GUEST_DEPOSITS', code: '2320', name: 'Guest deposits', type: 'LIABILITY' },
  // ADR-0024 §5: laundry job orders' down payments, held without VAT until the claim or a forfeit. Pending the accountant.
  { key: 'CUSTOMER_DOWN_PAYMENTS', code: '2330', name: 'Customer down payments', type: 'LIABILITY' },
  { key: 'CASH_TRANSFERS', code: '3900', name: 'Cash fund transfers', type: 'EQUITY' },
  { key: 'SALES', code: '4000', name: 'Sales', type: 'REVENUE' },
  { key: 'SALES_RETURNS', code: '4010', name: 'Sales returns', type: 'REVENUE' },
  { key: 'STATUTORY_DISCOUNTS', code: '4020', name: 'SC/PWD discounts', type: 'REVENUE' },
  { key: 'ROOM_REVENUE', code: '4100', name: 'Room revenue', type: 'REVENUE' },
  { key: 'CANCELLATION_INCOME', code: '4110', name: 'Cancellation fees', type: 'REVENUE' },
  { key: 'FORFEITED_DOWN_PAYMENTS', code: '4120', name: 'Forfeited down payments', type: 'REVENUE' },
  { key: 'COGS', code: '5000', name: 'Cost of goods sold', type: 'EXPENSE' },
  { key: 'PURCHASES_NON_STOCK', code: '5050', name: 'Purchases – non-stock items', type: 'EXPENSE' },
  { key: 'PURCHASE_PRICE_VARIANCE', code: '5060', name: 'Purchase price variance', type: 'EXPENSE' },
  { key: 'INVENTORY_ADJUSTMENTS', code: '5100', name: 'Inventory adjustments', type: 'EXPENSE' },
  { key: 'INVENTORY_WASTE', code: '5110', name: 'Spoilage and waste', type: 'EXPENSE' },
  { key: 'TRANSIT_LOSS', code: '5120', name: 'Transit losses', type: 'EXPENSE' },
  { key: 'CASH_OVER_SHORT', code: '5200', name: 'Cash over/short', type: 'EXPENSE' },
] as const satisfies readonly { key: string; code: string; name: string; type: AccountType }[];

export type SystemAccount = (typeof DEFAULT_CHART)[number]['key'];

/** A posting line before account ids are resolved; `account` is a system key or an account id. */
export interface PostingLine {
  account: SystemAccount | (string & {});
  debit: string;
  credit: string;
  branchId?: string | null;
  memo?: string | null;
}

type Amount = Dec | string | number;

export class UnbalancedEntryError extends Error {
  constructor(readonly debit: string, readonly credit: string) {
    super(`Unbalanced journal entry: debit ${debit} ≠ credit ${credit}`);
    this.name = 'UnbalancedEntryError';
  }
}

const SCALE = 4;

/** A signed amount on an account: positive → debit, negative → credit. Zero lines are dropped later. */
export function signed(account: PostingLine['account'], amount: Amount, branchId?: string | null, memo?: string | null): PostingLine {
  const d = toDec(String(amount)).toDecimalPlaces(SCALE);
  return { account, debit: d.gt(0) ? d.toFixed(SCALE) : '0', credit: d.lt(0) ? d.negated().toFixed(SCALE) : '0', branchId: branchId ?? null, memo: memo ?? null };
}

export const dr = (account: PostingLine['account'], amount: Amount, branchId?: string | null) => signed(account, amount, branchId);
export const cr = (account: PostingLine['account'], amount: Amount, branchId?: string | null) => signed(account, toDec(String(amount)).negated(), branchId);

/** Drop zero lines and verify Σ debit = Σ credit exactly. Returns [] when nothing is left to post. */
export function balanced(lines: PostingLine[]): PostingLine[] {
  const kept = lines.filter((l) => !toDec(l.debit).isZero() || !toDec(l.credit).isZero());
  for (const l of kept) {
    if (toDec(l.debit).lt(0) || toDec(l.credit).lt(0) || (!toDec(l.debit).isZero() && !toDec(l.credit).isZero())) {
      throw new Error('A journal line is either a debit or a credit, never negative');
    }
  }
  const debit = kept.reduce((a, l) => a.plus(l.debit), new Dec(0));
  const credit = kept.reduce((a, l) => a.plus(l.credit), new Dec(0));
  if (!debit.equals(credit)) throw new UnbalancedEntryError(debit.toFixed(SCALE), credit.toFixed(SCALE));
  return kept;
}

export interface SaleAmounts {
  /** Items: VATable + VAT-exempt + zero-rated + percentage-tax sales (ex VAT, before the statutory discount). */
  salesExVat: Amount;
  /** Service charge ex VAT (RA 11360: owed to employees, not revenue). Its VAT is in `vatAmount`. */
  serviceCharge?: Amount;
  vatAmount: Amount;
  statutoryDiscount: Amount;
  /** Collected in cash (tendered − change). */
  cash: Amount;
  /** Collected by card/QR/e-wallet intents. */
  electronic: Amount;
  /** Paid with the customer's store credit (ADR-0018): the liability goes down. */
  storeCredit?: Amount;
  /** Cost of the goods that left stock (−Σ SALE movement values). */
  cogs: Amount;
  /** A tip given with the sale (session 25), in cash or by card/QR: owed to staff, not revenue or VAT. */
  tip?: { amount: Amount; electronic: boolean };
  /** Service packages sold, ex VAT (ADR-0022 §6): part of `salesExVat`, owed until used, not sales yet. */
  packagesSold?: Amount;
  /** Package sessions used: their value moves from what is owed into sales. */
  packageSessions?: Amount;
  /** Charged to an in-house guest's folio (ADR-0023 §5.1): the guest ledger, not cash. */
  roomCharge?: Amount;
  /** A laundry claim paid by the job's down payment (ADR-0024 §5): what was held is owed no more. */
  downPayment?: Amount;
}

/** Sale: money in, revenue and output tax out, cost of goods moved from inventory. */
export function salePosting(a: SaleAmounts, branchId?: string | null): PostingLine[] {
  return balanced([
    dr('CASH_ON_HAND', toDec(String(a.cash)).plus(a.tip && !a.tip.electronic ? String(a.tip.amount) : 0), branchId),
    dr('PAYMENT_CLEARING', toDec(String(a.electronic)).plus(a.tip?.electronic ? String(a.tip.amount) : 0), branchId),
    cr('TIPS_PAYABLE', a.tip?.amount ?? 0, branchId),
    dr('CUSTOMER_STORE_CREDIT', a.storeCredit ?? 0, branchId),
    dr('GUEST_LEDGER', a.roomCharge ?? 0, branchId),
    dr('CUSTOMER_DOWN_PAYMENTS', a.downPayment ?? 0, branchId),
    dr('STATUTORY_DISCOUNTS', a.statutoryDiscount, branchId),
    cr('SALES', toDec(String(a.salesExVat)).minus(String(a.packagesSold ?? 0)), branchId),
    cr('PREPAID_SERVICES', a.packagesSold ?? 0, branchId),
    dr('PREPAID_SERVICES', a.packageSessions ?? 0, branchId),
    cr('SALES', a.packageSessions ?? 0, branchId),
    cr('SERVICE_CHARGE_PAYABLE', a.serviceCharge ?? 0, branchId),
    cr('OUTPUT_VAT', a.vatAmount, branchId),
    dr('COGS', a.cogs, branchId),
    cr('INVENTORY', a.cogs, branchId),
  ]);
}

export interface SaleReturnAmounts {
  salesExVat: Amount;
  /** Service charge given back, ex VAT. */
  serviceCharge?: Amount;
  vatAmount: Amount;
  statutoryDiscount: Amount;
  /** Given back: in cash (ADR-0011), or as store credit when `refundTo` is STORE_CREDIT (ADR-0018). */
  refund: Amount;
  refundTo?: 'CASH' | 'STORE_CREDIT';
  /**
   * Part of a cash refund that goes back to store credit because the sale was paid with it
   * (ADR-0018): store credit never turns into drawer cash. Ignored when `refundTo` is STORE_CREDIT.
   */
  storeCredit?: Amount;
  /** Value brought back into stock (Σ RETURN movement values; damaged goods bring none). */
  restocked: Amount;
  /** A void gives the sale's tip back in cash (session 25). */
  tipRefund?: Amount;
  /** Unused packages given back (ADR-0022 §6): their recorded value, owed no more; part of `salesExVat`. */
  packagesRefunded?: Amount;
  /** Package sessions given back: their value goes back from sales to what is owed. */
  packageSessionsRestored?: Amount;
  /** Part of `refund` credited to the guest's open folio (ADR-0023 §5.1), not paid out. */
  folioRefund?: Amount;
}

/** Return or void: the sale's revenue, tax and discount reversed into Sales returns; restocked goods back to inventory. */
export function saleReturnPosting(a: SaleReturnAmounts, branchId?: string | null): PostingLine[] {
  const toCredit = a.refundTo === 'STORE_CREDIT';
  const tip = toDec(String(a.tipRefund ?? 0));
  const folio = toDec(String(a.folioRefund ?? 0));
  const paid = toDec(String(a.refund)).minus(folio);
  const credit = toCredit ? paid : toDec(String(a.storeCredit ?? 0));
  return balanced([
    dr('SALES_RETURNS', toDec(String(a.salesExVat)).minus(String(a.packagesRefunded ?? 0)), branchId),
    dr('PREPAID_SERVICES', a.packagesRefunded ?? 0, branchId),
    dr('SALES_RETURNS', a.packageSessionsRestored ?? 0, branchId),
    cr('PREPAID_SERVICES', a.packageSessionsRestored ?? 0, branchId),
    dr('SERVICE_CHARGE_PAYABLE', a.serviceCharge ?? 0, branchId),
    dr('OUTPUT_VAT', a.vatAmount, branchId),
    cr('STATUTORY_DISCOUNTS', a.statutoryDiscount, branchId),
    cr('GUEST_LEDGER', folio, branchId),
    cr('CUSTOMER_STORE_CREDIT', credit, branchId),
    cr('CASH_ON_HAND', paid.minus(credit).plus(tip), branchId),
    dr('TIPS_PAYABLE', tip, branchId),
    dr('INVENTORY', a.restocked, branchId),
    cr('COGS', a.restocked, branchId),
  ]);
}

export interface GoodsReceiptAmounts {
  /** Value the stock ledger recorded (Σ RECEIPT movement values). */
  stockValue: Amount;
  /** The same stocked lines at their receipt cost (Σ quantity × cost) — what is owed for them. */
  stockAtCost: Amount;
  /** Non-stock lines (services, untracked items) at cost. */
  nonStock: Amount;
}

/** Goods receipt: inventory in, liability to the supplier at cost; a revaluation of units sold short adjusts COGS (ADR-0012 §4). */
export function goodsReceiptPosting(a: GoodsReceiptAmounts, branchId?: string | null): PostingLine[] {
  const owed = toDec(String(a.stockAtCost)).plus(String(a.nonStock));
  return balanced([
    dr('INVENTORY', a.stockValue, branchId),
    dr('COGS', toDec(String(a.stockAtCost)).minus(String(a.stockValue)), branchId),
    dr('PURCHASES_NON_STOCK', a.nonStock, branchId),
    cr('GRNI', owed, branchId),
  ]);
}

export interface SupplierReturnAmounts {
  /** Value that left stock (−Σ SUPPLIER_RETURN movement values, at average). */
  stockValueOut: Amount;
  /** What the supplier credits for the stocked lines. */
  stockCredit: Amount;
  /** Credit for non-stock lines. */
  nonStockCredit: Amount;
}

export function supplierReturnPosting(a: SupplierReturnAmounts, branchId?: string | null): PostingLine[] {
  const credit = toDec(String(a.stockCredit)).plus(String(a.nonStockCredit));
  return balanced([
    dr('GRNI', credit, branchId),
    cr('INVENTORY', a.stockValueOut, branchId),
    cr('PURCHASES_NON_STOCK', a.nonStockCredit, branchId),
    // Average out ≠ purchase credit: the difference is a purchase price variance.
    dr('PURCHASE_PRICE_VARIANCE', toDec(String(a.stockValueOut)).minus(String(a.stockCredit)), branchId),
  ]);
}

export interface SupplierInvoiceAmounts {
  /** GRNI the invoice clears: the covered receipts at cost, less what was returned against them before. */
  matched: Amount;
  /** VAT on the invoice the entity may claim (VAT-registered); 0 for a non-VAT entity, whose VAT is cost. */
  inputVat: Amount;
  /** What the supplier is owed: the invoice total. */
  payable: Amount;
}

/**
 * Supplier invoice (session 16): GRNI cleared, input VAT claimed, the supplier owed the total; what
 * the invoice charges above or below the receipts (and a non-VAT entity's VAT) is a purchase price variance.
 */
export function supplierInvoicePosting(a: SupplierInvoiceAmounts, branchId?: string | null): PostingLine[] {
  const payable = toDec(String(a.payable));
  return balanced([
    dr('GRNI', a.matched, branchId),
    dr('INPUT_VAT', a.inputVat, branchId),
    dr('PURCHASE_PRICE_VARIANCE', payable.minus(String(a.matched)).minus(String(a.inputVat)), branchId),
    cr('ACCOUNTS_PAYABLE', payable, branchId),
  ]);
}

export interface SupplierNoteAmounts {
  kind: 'CREDIT' | 'DEBIT';
  /** The note's total: what is owed goes down (credit) or up (debit) by it. */
  payable: Amount;
  /** VAT on the note the entity claims or gives back (VAT-registered); 0 otherwise. */
  inputVat: Amount;
  /** Credit notes only: GRNI left by returns after invoicing that this note clears. */
  grniCleared: Amount;
}

/**
 * Supplier credit or debit note (session 22): a credit note lowers the payable, gives back the input
 * VAT claimed, clears the GRNI returns after invoicing left, and the rest is a price variance; a debit
 * note raises the payable against input VAT and the variance.
 */
export function supplierNotePosting(a: SupplierNoteAmounts, branchId?: string | null): PostingLine[] {
  const payable = toDec(String(a.payable));
  const variance = payable.minus(String(a.inputVat)).minus(a.kind === 'CREDIT' ? String(a.grniCleared) : '0');
  return a.kind === 'CREDIT'
    ? balanced([
        dr('ACCOUNTS_PAYABLE', payable, branchId),
        cr('INPUT_VAT', a.inputVat, branchId),
        cr('GRNI', a.grniCleared, branchId),
        cr('PURCHASE_PRICE_VARIANCE', variance, branchId),
      ])
    : balanced([
        dr('PURCHASE_PRICE_VARIANCE', variance, branchId),
        dr('INPUT_VAT', a.inputVat, branchId),
        cr('ACCOUNTS_PAYABLE', payable, branchId),
      ]);
}

/** Supplier payment: the payable settled from the bank. */
export function supplierPaymentPosting(amount: Amount, branchId?: string | null): PostingLine[] {
  return balanced([dr('ACCOUNTS_PAYABLE', amount, branchId), cr('CASH_IN_BANK', amount, branchId)]);
}

/** Adjustment, waste or count: Σ signed movement values against the matching expense account. */
export function stockChangePosting(kind: 'ADJUSTMENT' | 'WASTE' | 'COUNT', value: Amount, branchId?: string | null): PostingLine[] {
  const against: SystemAccount = kind === 'WASTE' ? 'INVENTORY_WASTE' : 'INVENTORY_ADJUSTMENTS';
  return balanced([dr('INVENTORY', value, branchId), cr(against, value, branchId)]);
}

/**
 * Opening packs into pieces (ADR-0020): inventory to inventory. The pieces normally take exactly the
 * packs' value and nothing posts; pieces that were below zero are revalued, and that goes to COGS,
 * as for receipts and transfers.
 */
export function packOpeningPosting(a: { packsValue: Amount; piecesValue: Amount }, branchId?: string | null): PostingLine[] {
  const diff = toDec(String(a.piecesValue)).minus(String(a.packsValue));
  return balanced([dr('INVENTORY', diff, branchId), cr('COGS', diff, branchId)]);
}

/** Transfer dispatch: value leaves the source branch into transit. */
export function transferDispatchPosting(value: Amount, fromBranchId?: string | null): PostingLine[] {
  return balanced([dr('INVENTORY_IN_TRANSIT', value, fromBranchId), cr('INVENTORY', value, fromBranchId)]);
}

export interface TransferReceiptLine {
  /** Value that left the source for this line (−TRANSFER_OUT movement value). */
  sentValue: Amount;
  /** Received quantity at the dispatch cost (= sentValue when received in full). */
  arrivedAtCost: Amount;
  /** Value the destination ledger recorded (TRANSFER_IN movement value; 0 when nothing arrived). */
  stockValue: Amount;
}

/** Transfer receipt: transit cleared; shortfall is a transit loss; any destination revaluation adjusts COGS. */
export function transferReceiptPosting(lines: TransferReceiptLine[], fromBranchId?: string | null, toBranchId?: string | null): PostingLine[] {
  const sum = (f: (l: TransferReceiptLine) => Amount) => lines.reduce((a, l) => a.plus(String(f(l))), new Dec(0));
  const sent = sum((l) => l.sentValue);
  const atCost = sum((l) => l.arrivedAtCost);
  const stock = sum((l) => l.stockValue);
  return balanced([
    dr('INVENTORY', stock, toBranchId),
    dr('TRANSIT_LOSS', sent.minus(atCost), toBranchId),
    dr('COGS', atCost.minus(stock), toBranchId),
    cr('INVENTORY_IN_TRANSIT', sent, fromBranchId),
  ]);
}

/** Drawer pay-in (positive) or pay-out (negative). */
export function cashMovementPosting(amount: Amount, branchId?: string | null): PostingLine[] {
  return balanced([dr('CASH_ON_HAND', amount, branchId), cr('CASH_TRANSFERS', amount, branchId)]);
}

/** Tips handed to staff from the drawer (session 25): the liability goes down with the cash. */
export function tipPayoutPosting(amount: Amount, branchId?: string | null): PostingLine[] {
  return balanced([dr('TIPS_PAYABLE', amount, branchId), cr('CASH_ON_HAND', amount, branchId)]);
}

/** A voided sale's card tip given back (session 25): its charge cancelled (card), or cash from the drawer. */
export function tipRefundPosting(amount: Amount, via: 'CARD' | 'CASH', branchId?: string | null): PostingLine[] {
  return balanced([dr('TIPS_PAYABLE', amount, branchId), cr(via === 'CARD' ? 'PAYMENT_CLEARING' : 'CASH_ON_HAND', amount, branchId)]);
}

/** Drawer count variance: counted − expected (negative = short). */
export function cashVariancePosting(variance: Amount, branchId?: string | null): PostingLine[] {
  return balanced([dr('CASH_ON_HAND', variance, branchId), cr('CASH_OVER_SHORT', variance, branchId)]);
}

// ------------------------------------------------------------------ lodging (ADR-0023)

/** How money reached the business at the front desk. */
export type FrontDeskVia = 'CASH' | 'ELECTRONIC' | 'STORE_CREDIT' | 'BANK';
const VIA_ACCOUNT: Record<FrontDeskVia, SystemAccount> = {
  CASH: 'CASH_ON_HAND', ELECTRONIC: 'PAYMENT_CLEARING', STORE_CREDIT: 'CUSTOMER_STORE_CREDIT', BANK: 'CASH_IN_BANK',
};

export interface RoomChargeAmounts {
  /** Ex VAT, before the statutory discount (VATable + exempt + zero-rated + percentage-tax). Signed: − for a credit or reversal. */
  exVat: Amount;
  vatAmount: Amount;
  statutoryDiscount: Amount;
  /** The local accommodation tax on it (§10); not revenue, not subject to VAT. */
  accommodationTax?: Amount;
}

/**
 * A room night, an adjustment or a night reversal on a folio (§5): the guest owes what was charged;
 * room revenue ex VAT, output VAT and the accommodation tax payable; SC/PWD as for sales. Signed: a
 * credit or reversal (negative amounts) mirrors it.
 */
export function roomChargePosting(a: RoomChargeAmounts, branchId?: string | null): PostingLine[] {
  const owed = toDec(String(a.exVat)).plus(String(a.vatAmount)).minus(String(a.statutoryDiscount)).plus(String(a.accommodationTax ?? 0));
  return balanced([
    dr('GUEST_LEDGER', owed, branchId),
    dr('STATUTORY_DISCOUNTS', a.statutoryDiscount, branchId),
    cr('ROOM_REVENUE', a.exVat, branchId),
    cr('OUTPUT_VAT', a.vatAmount, branchId),
    cr('ACCOMMODATION_TAX_PAYABLE', a.accommodationTax ?? 0, branchId),
  ]);
}

/** A guest settling (part of) a folio: money in, the guest ledger down. */
export function folioPaymentPosting(amount: Amount, via: FrontDeskVia, branchId?: string | null): PostingLine[] {
  return balanced([dr(VIA_ACCOUNT[via], amount, branchId), cr('GUEST_LEDGER', amount, branchId)]);
}

/** A booking deposit received (§6): held, without VAT, until applied or forfeited. */
export function depositReceivedPosting(amount: Amount, via: Exclude<FrontDeskVia, 'STORE_CREDIT'>, branchId?: string | null): PostingLine[] {
  return balanced([dr(VIA_ACCOUNT[via], amount, branchId), cr('GUEST_DEPOSITS', amount, branchId)]);
}

/** Deposits moved onto the folio: they pay for what the guest owes. */
export function depositAppliedPosting(amount: Amount, branchId?: string | null): PostingLine[] {
  return balanced([dr('GUEST_DEPOSITS', amount, branchId), cr('GUEST_LEDGER', amount, branchId)]);
}

/** A deposit given back in cash from a drawer or by bank transfer. */
export function depositRefundedPosting(amount: Amount, via: 'CASH' | 'BANK', branchId?: string | null): PostingLine[] {
  return balanced([dr('GUEST_DEPOSITS', amount, branchId), cr(VIA_ACCOUNT[via], amount, branchId)]);
}

/** A deposit kept on a cancellation or no-show: a cancellation fee ex VAT plus its output VAT. */
export function depositForfeitedPosting(a: { amount: Amount; exVat: Amount; vatAmount: Amount }, branchId?: string | null): PostingLine[] {
  return balanced([dr('GUEST_DEPOSITS', a.amount, branchId), cr('CANCELLATION_INCOME', a.exVat, branchId), cr('OUTPUT_VAT', a.vatAmount, branchId)]);
}

// ------------------------------------------------------------------ laundry (ADR-0024)

/** A job order's down payment received (§5): held, without VAT, until the claim or a forfeit. */
export function downPaymentReceivedPosting(amount: Amount, via: Exclude<FrontDeskVia, 'STORE_CREDIT'>, branchId?: string | null): PostingLine[] {
  return balanced([dr(VIA_ACCOUNT[via], amount, branchId), cr('CUSTOMER_DOWN_PAYMENTS', amount, branchId)]);
}

/** A down payment given back in cash from a drawer or by bank transfer. */
export function downPaymentRefundedPosting(amount: Amount, via: 'CASH' | 'BANK', branchId?: string | null): PostingLine[] {
  return balanced([dr('CUSTOMER_DOWN_PAYMENTS', amount, branchId), cr(VIA_ACCOUNT[via], amount, branchId)]);
}

/** A down payment kept (unclaimed laundry disposed of, a cancelled job): income ex VAT plus its output VAT. */
export function downPaymentForfeitedPosting(a: { amount: Amount; exVat: Amount; vatAmount: Amount }, branchId?: string | null): PostingLine[] {
  return balanced([dr('CUSTOMER_DOWN_PAYMENTS', a.amount, branchId), cr('FORFEITED_DOWN_PAYMENTS', a.exVat, branchId), cr('OUTPUT_VAT', a.vatAmount, branchId)]);
}

/** Mirror of an entry's lines (debits ↔ credits). */
export function reversalOf(lines: PostingLine[]): PostingLine[] {
  return balanced(lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })));
}
