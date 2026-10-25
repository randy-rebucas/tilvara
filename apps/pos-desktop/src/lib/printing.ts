import type { PrintableReceipt } from '@1pos/escpos';
import type { OfflineReceipt } from '@1pos/pos-offline';
import type { Receipt } from '../types';
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

const SIGNATURE = 'Signature of the beneficiary';

/** A promoted line prints the promotion and what it took off under the quantity (ADR-0021). */
const promoDetail = (detail: string, promo?: { name: string; discount: string }) => (promo ? `${detail}  ${promo.name} -${promo.discount}` : detail);
/**
 * An expiry item's line adds each batch its sale drew ("Lot NEW-1 · Exp 03/2027"), under the item in small
 * print; the printer has one detail line per item, so they follow the quantity there, kept apart by " | ".
 */
export const lotDetail = (detail: string, l: { lots?: string[] | undefined }) => [detail, ...(l.lots ?? [])].join(' | ');

/** The server's receipt document as a thermal-printer receipt: same content, same order, same notice. */
export function receiptToPrintable(r: Receipt): PrintableReceipt {
  const entries = Object.entries(r.totals).filter(([k]) => k !== 'currency' && k !== 'vatLabel');
  return {
    header: [r.seller.name, r.seller.registeredName, ...(r.seller.address ? [r.seller.address] : []), ...(r.seller.tin ? [`${r.seller.tinLabel} ${r.seller.tin}`] : [])],
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
      pairs: r.statutory.length > 1 ? [['Discount', peso(signedTotal('statutoryDiscount', s.discount))] as [string, string]] : [],
      ...(s.signatureLine && { signature: SIGNATURE }),
    })),
    footer: [...(r.customer ? [`Customer: ${r.customer.name}${r.customer.tin ? ` · TIN ${r.customer.tin}` : ''}`] : []), ...(r.reason ? [`Reason: ${r.reason}`] : []), ...(r.legend ? [r.legend] : []), `Cashier: ${r.transaction.cashier} · ${r.transaction.register}`],
  };
}

/** A receipt rung up offline (ADR-0015 §6): its local reference, and that it is not an invoice. */
export function offlineReceiptToPrintable(r: OfflineReceipt, dateTime: string): PrintableReceipt {
  const isVat = r.seller.vatStatus === 'VAT';
  const totals: [string, string][] = isVat
    ? [['gross', r.totals.gross], ['vatableSales', r.totals.vatableSales], ['vatAmount', r.totals.vatAmount], ['vatExemptSales', r.totals.vatExemptSales], ['zeroRatedSales', r.totals.zeroRatedSales], ['amountDue', r.totals.amountDue]]
    : [['gross', r.totals.gross], ['salesSubjectToPercentageTax', r.totals.percentageTaxSales], ['exemptSales', r.totals.vatExemptSales], ['amountDue', r.totals.amountDue]];
  return {
    header: [r.seller.name, r.seller.registeredName, ...(r.seller.tin ? [`${isVat ? 'VAT REG TIN' : 'NON-VAT REG TIN'} ${r.seller.tin}`] : [])],
    notice: r.notice,
    meta: [[r.localReference, dateTime]],
    items: r.lines.map((l) => ({ name: l.name, amount: `${l.amount} ${l.flag}`.trim(), detail: promoDetail(`${l.quantity} x ${l.unitPrice}`, l.promotion) })),
    totals: totals.map(([k, v]) => ({ label: TOTAL_LABELS[k]!, amount: peso(v), ...(k === 'amountDue' && { emphasis: true }) })),
    payments: [{ label: 'CASH', amount: peso(r.totals.amountDue) }, { label: 'Tendered', amount: peso(r.tendered) }, { label: 'Change', amount: peso(r.change) }],
    footer: [...(isVat ? ['V = VATable, E = VAT-exempt, Z = zero-rated'] : []), `Cashier: ${r.cashierName} · ${r.register.name}`],
  };
}

/** How a tender reads on a receipt: an exchange credit names the return it came from. */
export const tenderLabel = (t: { method: string; exchangeReturnNumber?: number }) =>
  t.exchangeReturnNumber ? `EXCHANGE CREDIT (RETURN #${String(t.exchangeReturnNumber).padStart(6, '0')})` : t.method === 'STORE_CREDIT' ? 'STORE CREDIT' : t.method;
