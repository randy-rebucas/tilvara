import type { PrintableReceipt } from '@1pos/escpos';
import type { OfflineReceipt } from '@1pos/pos-offline';
import type { Receipt, ReceiptBranding } from '../types';
import { isZero, peso } from './money';

/** Receipt wording stays in English, matching BIR document terminology (not UI copy). */
export const TOTAL_LABELS: Record<string, string> = {
  gross: 'Gross',
  discount: 'Discount',
  vatableSales: 'VATable sales',
  vatAmount: 'VAT',
  vatExemptSales: 'VAT-exempt sales',
  zeroRatedSales: 'Zero-rated sales',
  vatExemption: 'VAT exemption',
  salesSubjectToPercentageTax: 'Sales subject to percentage tax',
  exemptSales: 'Exempt sales',
  statutoryDiscount: 'SC/PWD discount',
  amountDue: 'TOTAL DUE',
  refund: 'REFUND',
  tendered: 'Tendered',
  change: 'Change',
};
/** Amounts taken off the price print with a minus, as on the counter screen. */
export const DEDUCTIONS = new Set(['discount', 'vatExemption', 'statutoryDiscount']);
/** Printed after the tenders, so the slip reads TOTAL DUE → how it was paid → tendered → change. */
export const SETTLEMENT = ['tendered', 'change'];

/** A total as printed: deductions carry a minus unless they are zero. */
export const signedTotal = (k: string, v: string) => (DEDUCTIONS.has(k) && !isZero(v) ? `-${v}` : v);

/** Receipt words the screen shows too, so the receipt on screen reads as it prints (English, like the totals). */
export const SIGNATURE = 'Signature of the beneficiary';
export const RECEIPT_WORDS = { cashier: 'Cashier', customer: 'Customer', reason: 'Reason', discount: 'Discount' } as const;

/** A promoted line prints the promotion and what it took off under the quantity (ADR-0021). */
const promoDetail = (detail: string, promo?: { name: string; discount: string }) => (promo ? `${detail}  ${promo.name} -${promo.discount}` : detail);
/**
 * An expiry item's line adds each batch its sale drew ("Lot NEW-1 · Exp 03/2027"), under the item in small
 * print; the printer has one detail line per item, so they follow the quantity there, kept apart by " | ".
 */
export const lotDetail = (detail: string, l: { lots?: string[] | undefined }) => [detail, ...(l.lots ?? [])].join(' | ');

/** The business's messages (session 39): its header above the names a receipt must show, its footer and contact lines last. */
export const brandHeader = (b: Pick<ReceiptBranding, 'header'> | undefined) => b?.header ?? [];
export const brandFooter = (b: Pick<ReceiptBranding, 'footer' | 'contact'> | undefined) => [...(b?.footer ?? []), ...(b?.contact ?? [])];

/** The server's receipt document as a thermal-printer receipt: same content, same order, same notice. */
export function receiptToPrintable(r: Receipt): PrintableReceipt {
  const entries = Object.entries(r.totals).filter(([k]) => k !== 'currency' && k !== 'vatLabel');
  return {
    header: [...brandHeader(r.branding), r.seller.name, r.seller.registeredName, ...(r.seller.address ? [r.seller.address] : []), ...(r.seller.tin ? [`${r.seller.tinLabel} ${r.seller.tin}`] : [])],
    notice: r.notice,
    meta: [[r.transaction.reference, r.transaction.dateTime]],
    items: [
      ...r.lines.map((l) => ({ name: l.name, amount: `${l.amount} ${l.flag}`.trim(), detail: lotDetail(promoDetail(`${l.quantity} x ${l.unitPrice}`, l.promotion && l.discount ? { name: l.promotion, discount: l.discount } : undefined), l) })),
      // An older sale's service charge: its own line after the items, as the server words it.
      ...(r.charges ?? []).map((c) => ({ name: c.label, amount: `${c.amount} ${c.flag}`.trim() })),
    ],
    totals: entries
      .filter(([k]) => !SETTLEMENT.includes(k))
      .map(([k, v]) => ({ label: k === 'vatAmount' ? (r.totals.vatLabel ?? 'VAT') : (TOTAL_LABELS[k] ?? k), amount: peso(signedTotal(k, v)), ...((k === 'amountDue' || k === 'refund') && { emphasis: true }) })),
    payments: [
      ...r.tenders.map((t) => ({ label: tenderLabel(t), amount: peso(t.amount) })),
      ...SETTLEMENT.flatMap((k) => entries.filter(([e]) => e === k).map(([, v]) => ({ label: TOTAL_LABELS[k]!, amount: peso(v) }))),
    ],
    blocks: r.statutory.map((s) => ({
      lines: [`${s.label}: ${s.name}`, `ID ${s.idNumber}`],
      // One beneficiary's discount is the "SC/PWD discount" total already; only a split needs each share.
      pairs: r.statutory.length > 1 ? [[RECEIPT_WORDS.discount, peso(signedTotal('statutoryDiscount', s.discount))] as [string, string]] : [],
      ...(s.signatureLine && { signature: SIGNATURE }),
    })),
    footer: [...(r.customer ? [`${RECEIPT_WORDS.customer}: ${r.customer.name}${r.customer.tin ? ` · TIN ${r.customer.tin}` : ''}`] : []), ...(r.reason ? [`${RECEIPT_WORDS.reason}: ${r.reason}`] : []), ...(r.legend ? [r.legend] : []), `${RECEIPT_WORDS.cashier}: ${r.transaction.cashier} · ${r.transaction.register}`, ...brandFooter(r.branding)],
  };
}

/** A receipt rung up offline (ADR-0015 §6): its local reference, and that it is not an invoice. */
export function offlineReceiptToPrintable(r: OfflineReceipt, dateTime: string): PrintableReceipt {
  const isVat = r.seller.vatStatus === 'VAT';
  // What promotions took off, as online receipts print it (a receipt queued before it was kept has none).
  const discount: [string, string][] = r.totals.discount && !isZero(r.totals.discount) ? [['discount', r.totals.discount]] : [];
  const totals: [string, string][] = isVat
    ? [['gross', r.totals.gross], ...discount, ['vatableSales', r.totals.vatableSales], ['vatAmount', r.totals.vatAmount], ['vatExemptSales', r.totals.vatExemptSales], ['zeroRatedSales', r.totals.zeroRatedSales], ['amountDue', r.totals.amountDue]]
    : [['gross', r.totals.gross], ...discount, ['salesSubjectToPercentageTax', r.totals.percentageTaxSales], ['exemptSales', r.totals.vatExemptSales], ['amountDue', r.totals.amountDue]];
  return {
    header: [...brandHeader(r.branding), r.seller.name, r.seller.registeredName, ...(r.seller.tin ? [`${isVat ? 'VAT REG TIN' : 'NON-VAT REG TIN'} ${r.seller.tin}`] : [])],
    notice: r.notice,
    meta: [[r.localReference, dateTime]],
    items: r.lines.map((l) => ({ name: l.name, amount: `${l.amount} ${l.flag}`.trim(), detail: promoDetail(`${l.quantity} x ${l.unitPrice}`, l.promotion) })),
    totals: totals.map(([k, v]) => ({ label: k === 'vatAmount' ? (r.totals.vatLabel ?? TOTAL_LABELS.vatAmount!) : TOTAL_LABELS[k]!, amount: peso(signedTotal(k, v)), ...(k === 'amountDue' && { emphasis: true }) })),
    payments: [{ label: 'CASH', amount: peso(r.totals.amountDue) }, { label: 'Tendered', amount: peso(r.tendered) }, { label: 'Change', amount: peso(r.change) }],
    footer: [...(isVat ? ['V = VATable, E = VAT-exempt, Z = zero-rated'] : []), `${RECEIPT_WORDS.cashier}: ${r.cashierName} · ${r.register.name}`, ...brandFooter(r.branding)],
  };
}

/**
 * Tenders as a receipt words them. ROOM_CHARGE and JOB_DEPOSIT stay on old sales (retired with lodging
 * and laundry, migrations 0110–0111) and reprint marked retired; a code this build has no words for prints as stored.
 */
const RECEIPT_TENDERS: Record<string, string> = {
  STORE_CREDIT: 'STORE CREDIT',
  EWALLET: 'E-WALLET',
  ROOM_CHARGE: 'ROOM CHARGE (RETIRED)',
  JOB_DEPOSIT: 'LAUNDRY DOWN PAYMENT (RETIRED)',
};

/** Tender methods of features no longer offered: a sale paid with one cannot be voided or returned (`TENDER_RETIRED`). */
export const RETIRED_TENDERS: readonly string[] = ['ROOM_CHARGE', 'JOB_DEPOSIT'];

/** How a tender reads on a receipt: an exchange credit names the return it came from. */
export const tenderLabel = (t: { method: string; exchangeReturnNumber?: number }) =>
  t.exchangeReturnNumber ? `EXCHANGE CREDIT (RETURN #${String(t.exchangeReturnNumber).padStart(6, '0')})` : (RECEIPT_TENDERS[t.method] ?? t.method);
