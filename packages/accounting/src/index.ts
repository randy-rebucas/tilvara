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
  { key: 'INVENTORY', code: '1200', name: 'Inventory', type: 'ASSET' },
  { key: 'INVENTORY_IN_TRANSIT', code: '1210', name: 'Inventory in transit', type: 'ASSET' },
  { key: 'INPUT_VAT', code: '1300', name: 'Input VAT', type: 'ASSET' },
  { key: 'ACCOUNTS_PAYABLE', code: '2000', name: 'Accounts payable – trade', type: 'LIABILITY' },
  { key: 'GRNI', code: '2010', name: 'Goods received not invoiced', type: 'LIABILITY' },
  { key: 'OUTPUT_VAT', code: '2100', name: 'Output VAT payable', type: 'LIABILITY' },
  { key: 'SERVICE_CHARGE_PAYABLE', code: '2200', name: 'Service charge payable', type: 'LIABILITY' },
  { key: 'CASH_TRANSFERS', code: '3900', name: 'Cash fund transfers', type: 'EQUITY' },
  { key: 'SALES', code: '4000', name: 'Sales', type: 'REVENUE' },
  { key: 'SALES_RETURNS', code: '4010', name: 'Sales returns', type: 'REVENUE' },
  { key: 'STATUTORY_DISCOUNTS', code: '4020', name: 'SC/PWD discounts', type: 'REVENUE' },
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
  /** Cost of the goods that left stock (−Σ SALE movement values). */
  cogs: Amount;
}

/** Sale: money in, revenue and output tax out, cost of goods moved from inventory. */
export function salePosting(a: SaleAmounts, branchId?: string | null): PostingLine[] {
  return balanced([
    dr('CASH_ON_HAND', a.cash, branchId),
    dr('PAYMENT_CLEARING', a.electronic, branchId),
    dr('STATUTORY_DISCOUNTS', a.statutoryDiscount, branchId),
    cr('SALES', a.salesExVat, branchId),
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
  /** Refunded in cash (ADR-0011). */
  refund: Amount;
  /** Value brought back into stock (Σ RETURN movement values; damaged goods bring none). */
  restocked: Amount;
}

/** Return or void: the sale's revenue, tax and discount reversed into Sales returns; restocked goods back to inventory. */
export function saleReturnPosting(a: SaleReturnAmounts, branchId?: string | null): PostingLine[] {
  return balanced([
    dr('SALES_RETURNS', a.salesExVat, branchId),
    dr('SERVICE_CHARGE_PAYABLE', a.serviceCharge ?? 0, branchId),
    dr('OUTPUT_VAT', a.vatAmount, branchId),
    cr('STATUTORY_DISCOUNTS', a.statutoryDiscount, branchId),
    cr('CASH_ON_HAND', a.refund, branchId),
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

/** Supplier payment: the payable settled from the bank. */
export function supplierPaymentPosting(amount: Amount, branchId?: string | null): PostingLine[] {
  return balanced([dr('ACCOUNTS_PAYABLE', amount, branchId), cr('CASH_IN_BANK', amount, branchId)]);
}

/** Adjustment, waste or count: Σ signed movement values against the matching expense account. */
export function stockChangePosting(kind: 'ADJUSTMENT' | 'WASTE' | 'COUNT', value: Amount, branchId?: string | null): PostingLine[] {
  const against: SystemAccount = kind === 'WASTE' ? 'INVENTORY_WASTE' : 'INVENTORY_ADJUSTMENTS';
  return balanced([dr('INVENTORY', value, branchId), cr(against, value, branchId)]);
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

/** Drawer count variance: counted − expected (negative = short). */
export function cashVariancePosting(variance: Amount, branchId?: string | null): PostingLine[] {
  return balanced([dr('CASH_ON_HAND', variance, branchId), cr('CASH_OVER_SHORT', variance, branchId)]);
}

/** Mirror of an entry's lines (debits ↔ credits). */
export function reversalOf(lines: PostingLine[]): PostingLine[] {
  return balanced(lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })));
}
