import type { PrintableReceipt } from '@1pos/escpos';
import { toDec } from '@1pos/money';
import type { OfflineReceipt } from '@1pos/pos-offline';
import type { Bill, FolioStatement, JobTicket, Receipt } from '../types';
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
/** A salon line (ADR-0022) adds who did it and whether it was a package session, as the server's receipt says. */
const salonDetail = (detail: string, l: { staff?: string; packageSession?: boolean }) =>
  [detail, ...(l.packageSession ? ['Package session'] : []), ...(l.staff ? [l.staff] : [])].join(' · ');

/**
 * A medicine line (ADR-0025 §3, §5) adds its generic label and each batch its sale drew ("Lot NEW-1 ·
 * Exp 03/2027"), under the item in small print; the printer has one detail line per item, so they follow
 * the quantity there, kept apart by " | ".
 */
export const drugDetail = (detail: string, l: { generic?: string | undefined; lots?: string[] | undefined }) =>
  [detail, ...(l.generic ? [l.generic] : []), ...(l.lots ?? [])].join(' | ');

/** Under the SC/PWD details when the discount covered a medicine and the booklet was presented (ADR-0025 §8). */
export const BOOKLET_PRESENTED = 'Purchase booklet presented';

/** The server's receipt document as a thermal-printer receipt: same content, same order, same notice. */
export function receiptToPrintable(r: Receipt): PrintableReceipt {
  const entries = Object.entries(r.totals).filter(([k]) => k !== 'currency' && k !== 'vatLabel');
  return {
    header: [r.seller.name, r.seller.registeredName, ...(r.seller.address ? [r.seller.address] : []), ...(r.seller.tin ? [`${r.seller.tinLabel} ${r.seller.tin}`] : [])],
    notice: r.notice,
    meta: [...(r.callNumber !== undefined ? [[`ORDER #${r.callNumber}`, r.pickupName ?? ''] as [string, string]] : []), [r.transaction.reference, r.transaction.dateTime]],
    items: [
      ...r.lines.map((l) => ({ name: l.name, amount: `${l.amount} ${l.flag}`.trim(), detail: drugDetail(salonDetail(promoDetail(`${l.quantity} x ${l.unitPrice}`, l.promotion && l.discount ? { name: l.promotion, discount: l.discount } : undefined), l), l) })),
      ...(r.charges ?? []).map((c) => ({ name: c.label, amount: `${c.amount} ${c.flag}`.trim() })),
    ],
    totals: entries
      .filter(([k]) => !SETTLEMENT.includes(k))
      .map(([k, v]) => ({ label: k === 'vatAmount' ? (r.totals.vatLabel ?? 'VAT') : (TOTAL_LABELS[k] ?? k), amount: peso(signedTotal(k, v)), ...((k === 'amountDue' || k === 'refund') && { emphasis: true }) })),
    payments: [
      ...r.tenders.map((t) => ({ label: tenderLabel(t), amount: peso(t.amount) })),
      ...SETTLEMENT.flatMap((k) => entries.filter(([e]) => e === k).map(([, v]) => ({ label: TOTAL_LABELS[k]!, amount: peso(v) }))),
      ...(r.tip ? [{ label: tipLabel(r.tip.method), amount: peso(r.tip.amount) }] : []),
    ],
    blocks: [
      // Charge to room (ADR-0023 §5.1): the line and the guest's signature, as the server words them.
      ...(r.roomCharge ? [{ lines: [r.roomCharge.line], pairs: [['Amount', peso(r.roomCharge.amount)] as [string, string]], signature: r.roomCharge.signatureLine }] : []),
      ...r.statutory.map((s) => ({
      lines: [`${s.label}: ${s.name}`, `ID ${s.idNumber}`, ...(s.purchaseBooklet ? [BOOKLET_PRESENTED] : [])],
      // One beneficiary's discount is the "SC/PWD discount" total already; only a split needs each share.
      pairs: r.statutory.length > 1 ? [['Discount', peso(signedTotal('statutoryDiscount', s.discount))] as [string, string]] : [],
      ...(s.signatureLine && { signature: SIGNATURE }),
      })),
    ],
    footer: [...(r.customer ? [`Customer: ${r.customer.name}${r.customer.tin ? ` · TIN ${r.customer.tin}` : ''}`] : []), ...(r.reason ? [`Reason: ${r.reason}`] : []), ...(r.legend ? [r.legend] : []), `Cashier: ${r.transaction.cashier} · ${r.transaction.register}`],
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
        // An order or item discount, or a comp: the guest sees why the line costs less (or nothing).
        ...(toDec(l.discount ?? '0').gt(0) ? [{ name: '  Discount', amount: `-${toDec(l.discount).toFixed(2)}` }] : []),
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
    meta: [...(r.callNumber !== undefined ? [[`ORDER #${r.callNumber}`, r.pickupName ?? ''] as [string, string]] : []), [r.localReference, dateTime]],
    items: r.lines.map((l) => ({ name: l.name, amount: `${l.amount} ${l.flag}`.trim(), detail: drugDetail(promoDetail(`${l.quantity} x ${l.unitPrice}`, l.promotion), l) })),
    totals: totals.map(([k, v]) => ({ label: TOTAL_LABELS[k]!, amount: peso(v), ...(k === 'amountDue' && { emphasis: true }) })),
    payments: [
      { label: 'CASH', amount: peso(r.totals.amountDue) }, { label: 'Tendered', amount: peso(r.tendered) }, { label: 'Change', amount: peso(r.change) },
      ...(r.tip ? [{ label: tipLabel('CASH'), amount: peso(r.tip) }] : []),
    ],
    footer: [...(isVat ? ['V = VATable, E = VAT-exempt, Z = zero-rated'] : []), `Cashier: ${r.cashierName} · ${r.register.name}`],
  };
}

/**
 * The guest folio statement (ADR-0023 §5.2) for a thermal printer: what the guest signs at check-out.
 * Its title ("Guest folio — not an invoice" while invoicing is disabled) is the server's, as printed.
 */
export function statementToPrintable(s: FolioStatement): PrintableReceipt {
  const totals: [string, string][] = [
    ['Room nights', s.totals.roomNights], ['Accommodation tax', s.totals.accommodationTax], ['Charges', s.totals.charges],
    ['Adjustments', s.totals.adjustments], ['Deposits', s.totals.deposits], ['Payments', s.totals.payments],
  ];
  return {
    header: [s.seller.tradeName ?? s.seller.registeredName, s.seller.registeredName, ...(s.seller.registeredAddress ? [s.seller.registeredAddress] : []), ...(s.seller.tin ? [`TIN ${s.seller.tin}`] : [])],
    notice: s.title,
    meta: [[`Room ${s.stay.roomNumber} · ${s.stay.roomType}`, `${s.stay.arrivalDate} - ${s.stay.departureDate}`], ...(s.stay.guestName ? [['Guest', s.stay.guestName] as [string, string]] : [])],
    items: s.lines.map((l) => ({ name: `${l.date} ${l.description}`, amount: l.amount })),
    totals: [...totals.filter(([, v]) => !isZero(v)).map(([label, v]) => ({ label, amount: peso(v) })), { label: 'BALANCE', amount: peso(s.totals.balance), emphasis: true }],
    payments: [],
    blocks: [{ lines: [], signature: s.signatureLine }],
    footer: [s.branch.name],
  };
}

/** A tip on the receipt (session 25): after the payment, for the staff, not part of the total. */
export const tipLabel = (method: string) => (method === 'CASH' ? 'Tip (cash)' : `Tip (${method.toLowerCase()})`);

/** How a tender reads on a receipt: an exchange credit names the return it came from. */
export const tenderLabel = (t: { method: string; exchangeReturnNumber?: number }) =>
  t.exchangeReturnNumber ? `EXCHANGE CREDIT (RETURN #${String(t.exchangeReturnNumber).padStart(6, '0')})` : t.method === 'STORE_CREDIT' ? 'STORE CREDIT' : t.method === 'ROOM_CHARGE' ? 'CHARGE TO ROOM' : t.method === 'JOB_DEPOSIT' ? 'DOWN PAYMENT' : t.method;

/** A date and time on a laundry ticket, in the branch's time zone. */
export const ticketTime = (at: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-PH', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));

/** How a job line's quantity reads on the stub: "3.5 kg (min 5)" when the minimum was billed. */
export function jobQuantity(l: { measuredQuantity: string; quantity: string; unit: string | null }): string {
  const unit = l.unit === 'KG' ? ' kg' : l.unit === 'LOAD' ? (l.quantity === '1' ? ' load' : ' loads') : l.unit === 'PIECE' ? ' pc' : '';
  return l.measuredQuantity !== l.quantity ? `${l.measuredQuantity}${unit} (min ${l.quantity})` : `${l.quantity}${unit}`;
}

/**
 * The customer's claim stub (ADR-0024 §4): number and claim code, promised time, lines and total, the
 * down payment and balance, items and condition, and the branch's claim policy. English, like receipts.
 */
export function stubToPrintable(t: JobTicket): PrintableReceipt {
  const s = t.stub;
  return {
    header: [s.business, s.legalName, s.branch, ...(s.branchAddress ? [s.branchAddress] : [])],
    notice: s.notice,
    meta: [
      [s.reference, `CLAIM CODE ${s.claimCode}`],
      ['Received', ticketTime(s.receivedAt, s.timezone)],
      [s.serviceLevel === 'EXPRESS' ? 'EXPRESS - ready by' : 'Ready by', ticketTime(s.promisedAt, s.timezone)],
      ...(s.customer ? [['Customer', s.customer] as [string, string]] : []),
      [`Bags ${s.bagCount}`, s.weightKg ? `${s.weightKg} kg` : ''],
    ],
    items: s.lines.map((l) => ({ name: l.name, amount: l.amountDue, detail: `${jobQuantity(l)} x ${l.unitPrice}${l.packageSession ? ' · Package session' : ''}` })),
    totals: [
      { label: 'TOTAL', amount: peso(s.amountDue), emphasis: true },
      ...(isZero(s.depositHeld) ? [] : [{ label: 'Down payment', amount: peso(s.depositHeld) }]),
      { label: 'BALANCE AT PICKUP', amount: peso(s.balance), emphasis: true },
    ],
    payments: [],
    blocks: [
      ...(s.items.length ? [{ lines: [`Items (${s.pieces} pcs)`, ...s.items.map((i) => `${i.count} x ${i.label}${i.note ? ` - ${i.note}` : ''}`)] }] : []),
      ...(s.conditionNotes ? [{ lines: ['Condition at drop-off', s.conditionNotes] }] : []),
      ...(s.specialInstructions ? [{ lines: ['Instructions', s.specialInstructions] }] : []),
      ...(s.claimPolicy ? [{ lines: [s.claimPolicy] }] : []),
    ],
    footer: ['Bring this stub to claim your laundry.'],
  };
}

/** The bag tag (ADR-0024 §4): number, name, bags, service level and instructions; no prices. */
export function tagToPrintable(t: JobTicket): PrintableReceipt {
  const g = t.tag;
  return {
    header: [g.reference],
    notice: g.serviceLevel === 'EXPRESS' ? 'EXPRESS' : 'BAG TAG',
    meta: [...(g.customer ? [['Customer', g.customer] as [string, string]] : []), [`Bags ${g.bagCount}`, `${g.pieces} pcs`], ['Ready by', ticketTime(g.promisedAt, t.stub.timezone)]],
    items: [],
    totals: [],
    payments: [],
    blocks: g.specialInstructions ? [{ lines: ['Instructions', g.specialInstructions] }] : [],
    footer: [],
  };
}
