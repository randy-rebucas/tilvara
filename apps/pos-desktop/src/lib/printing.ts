import type { PrintableReceipt } from '@1pos/escpos';
import { toDec } from '@1pos/money';
import type { OfflineReceipt } from '@1pos/pos-offline';
import type { Bill, Receipt } from '../types';
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

/** The server's receipt document as a thermal-printer receipt: same content, same order, same notice. */
export function receiptToPrintable(r: Receipt): PrintableReceipt {
  const entries = Object.entries(r.totals).filter(([k]) => k !== 'currency' && k !== 'vatLabel');
  return {
    header: [r.seller.name, r.seller.registeredName, ...(r.seller.address ? [r.seller.address] : []), ...(r.seller.tin ? [`${r.seller.tinLabel} ${r.seller.tin}`] : [])],
    notice: r.notice,
    meta: [[r.transaction.reference, r.transaction.dateTime]],
    items: [
      ...r.lines.map((l) => ({ name: l.name, amount: `${l.amount} ${l.flag}`.trim(), detail: `${l.quantity} x ${l.unitPrice}` })),
      ...(r.charges ?? []).map((c) => ({ name: c.label, amount: `${c.amount} ${c.flag}`.trim() })),
    ],
    totals: entries
      .filter(([k]) => !SETTLEMENT.includes(k))
      .map(([k, v]) => ({ label: k === 'vatAmount' ? (r.totals.vatLabel ?? 'VAT') : (TOTAL_LABELS[k] ?? k), amount: peso(signedTotal(k, v)), ...((k === 'amountDue' || k === 'refund') && { emphasis: true }) })),
    payments: [
      ...r.tenders.map((t) => ({ label: t.method, amount: peso(t.amount) })),
      ...SETTLEMENT.flatMap((k) => entries.filter(([e]) => e === k).map(([, v]) => ({ label: TOTAL_LABELS[k]!, amount: peso(v) }))),
    ],
    blocks: r.statutory.map((s) => ({
      lines: [`${s.label}: ${s.name}`, `ID ${s.idNumber}`],
      // One beneficiary's discount is the "SC/PWD discount" total already; only a split needs each share.
      pairs: r.statutory.length > 1 ? [['Discount', peso(signedTotal('statutoryDiscount', s.discount))] as [string, string]] : [],
      ...(s.signatureLine && { signature: SIGNATURE }),
    })),
    footer: [...(r.reason ? [`Reason: ${r.reason}`] : []), ...(r.legend ? [r.legend] : []), `Cashier: ${r.transaction.cashier} · ${r.transaction.register}`],
  };
}

/** The notice on a printed bill: it asks for payment, it is not a receipt or an invoice. */
export const BILL_NOTICE = 'BILL - NOT AN OFFICIAL RECEIPT OR INVOICE';

/**
 * A table's bill as handed to the guests before they pay (printed again on request): its lines with
 * choices, the service charge, the total and VAT, what is already paid and what is left. Wording is
 * English like the receipt (BIR document terminology).
 */
export function billToPrintable(b: Bill, place: { branch: string; where: string; dateTime: string }): PrintableReceipt {
  const children = (id: string) => b.lines.filter((l) => l.parentLineId === id);
  return {
    header: [place.branch],
    notice: BILL_NOTICE,
    meta: [[`Bill ${b.billNumber} · ${place.where}`, place.dateTime]],
    items: [
      ...b.lines.filter((l) => !l.parentLineId).flatMap((l) => [
        { name: `${l.quantity} x ${l.name}${l.seat ? ` (seat ${l.seat})` : ''}`, amount: l.amountDue },
        ...children(l.id).map((c) => ({ name: `  + ${c.name}`, amount: c.amountDue })),
      ]),
      ...b.charges.map((c) => ({ name: `Service charge ${toDec(c.rate).times(100).toString()}%`, amount: c.amountDue })),
    ],
    totals: [
      { label: 'TOTAL DUE', amount: peso(b.amountDue), emphasis: true },
      { label: 'VAT', amount: peso(b.vatAmount) },
      ...(b.checks.length ? [{ label: 'Paid', amount: peso(b.amountPaid) }, { label: 'Left to pay', amount: peso(b.amountRemaining) }] : []),
    ],
    payments: [],
    footer: ['Please check your bill before paying.'],
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
    items: r.lines.map((l) => ({ name: l.name, amount: `${l.amount} ${l.flag}`.trim(), detail: `${l.quantity} x ${l.unitPrice}` })),
    totals: totals.map(([k, v]) => ({ label: TOTAL_LABELS[k]!, amount: peso(v), ...(k === 'amountDue' && { emphasis: true }) })),
    payments: [{ label: 'CASH', amount: peso(r.totals.amountDue) }, { label: 'Tendered', amount: peso(r.tendered) }, { label: 'Change', amount: peso(r.change) }],
    footer: [...(isVat ? ['V = VATable, E = VAT-exempt, Z = zero-rated'] : []), `Cashier: ${r.cashierName} · ${r.register.name}`],
  };
}
