import { Dec, toDec } from '@1pos/money';

/**
 * Receipt document for a completed sale. While a legal entity's invoicing mode is DISABLED this is
 * explicitly NOT an invoice; DEV_SERIES output is marked as test numbering. Never prints
 * "Official Receipt" (RR 7-2024 replaced ORs with invoices; see PH_COMPLIANCE_ASSUMPTIONS §1).
 */
export interface ReceiptInput {
  invoicingMode: 'DISABLED' | 'DEV_SERIES';
  seller: {
    registeredName: string;
    tradeName: string | null;
    registeredAddress: string | null;
    tin: string | null;
    vatStatus: 'VAT' | 'NON_VAT';
  };
  branch: { name: string; code: string; birBranchCode: string; address: string | null; timezone: string };
  register: { code: string; name: string };
  cashierName: string;
  sale: {
    saleNumber: number;
    completedAt: Date;
    currency: string;
    gross: string;
    discount: string;
    statutoryDiscount: string;
    vatExemptionAmount: string;
    vatableSales: string;
    vatAmount: string;
    vatExemptSales: string;
    zeroRatedSales: string;
    percentageTaxSales: string;
    amountDue: string;
    amountTendered: string;
    changeDue: string;
    vatRate: string;
  };
  lines: {
    name: string;
    quantity: string;
    unitPrice: string;
    gross: string;
    discount: string;
    statutoryDiscount: string;
    vatTreatment: string;
    vatableSales: string;
    vatExemptSales: string;
    beneficiaryId: string | null;
    /** A priced choice of the line above it (`parent_line_id`, kept on sales rung up before 0111): printed indented with a "+". */
    isChoice?: boolean;
    /** The promotion that priced the line (ADR-0021): printed with its discount. */
    promotion?: string | null;
    /** Who did it (ADR-0022): the staff member's first name. */
    staff?: string | null;
    /** A session of a prepaid package (ADR-0022 §6): printed as such at ₱0.00. */
    packageSession?: boolean;
    /** A medicine (ADR-0025 §3, §5): "generic strength form" under the brand, and the lots it came from. */
    drugLabel?: string | null;
    lots?: { lotCode: string | null; expiresOn: string }[];
  }[];
  /** A tip given with the sale (session 25): printed below the payment, never in the totals. */
  tip?: { method: string; amount: string } | null;
  /** `exchangeReturnNumber`: this cash is the refund of that return, put towards this sale (an exchange). */
  tenders: { method: string; amount: string; tendered: string; change: string; exchangeReturnNumber?: number | null }[];
  /** `purchaseBooklet` (ADR-0025 §8): set when the discount covered a medicine. */
  beneficiaries: { id: string; schemeCode: string; name: string; idNumber: string; tin: string | null; purchaseBooklet?: boolean | null }[];
  /** Charges that are not items (a service charge on sales rung up before 0111); included in the sale totals. */
  /** `gross` is the charge ex VAT (its sales); `amountDue` adds its VAT. */
  charges?: { kind: string; rate: string; gross: string; amountDue: string; vatTreatment: string }[];
  /** The customer the sale was rung up for (ADR-0018): printed with their TIN when they gave one. */
  customer?: { name: string; tin: string | null } | null;
}

const CHARGE_LABELS: Record<string, string> = { SERVICE_CHARGE: 'Service charge' };

export const NOT_AN_INVOICE = 'THIS IS NOT AN OFFICIAL INVOICE';
export const DEV_SERIES_NOTICE = 'TEST NUMBERING — NOT AN OFFICIAL INVOICE — NOT VALID FOR CLAIM OF INPUT TAX';

const SCHEME_LABELS: Record<string, string> = { SC: 'Senior citizen', PWD: 'PWD' };

export function formatTin(tin: string | null, birBranchCode: string): string | null {
  if (!tin) return null;
  return `${tin.slice(0, 3)}-${tin.slice(3, 6)}-${tin.slice(6, 9)}-${birBranchCode}`;
}

const pct = (rate: string) => `${toDec(rate).times(100).toString()}%`;
const m = (v: string) => toDec(v).toFixed(2);
const positive = (v: string) => toDec(v).gt(0);

export const RETURN_NOTICE = 'RETURN / REFUND — NOT AN OFFICIAL INVOICE';
export const VOID_NOTICE = 'VOID — NOT AN OFFICIAL INVOICE';

export interface ReturnReceiptInput extends Pick<ReceiptInput, 'invoicingMode' | 'seller' | 'branch' | 'register'> {
  processedBy: string;
  sale: { saleNumber: number; registerCode: string; vatRate: string; currency: string };
  doc: {
    kind: 'RETURN' | 'VOID';
    returnNumber: number;
    reason: string;
    createdAt: Date;
    refundMethod: string | null;
    vatableSales: string;
    vatAmount: string;
    vatExemptSales: string;
    zeroRatedSales: string;
    percentageTaxSales: string;
    statutoryDiscount: string;
    vatExemptionAmount: string;
    amountDue: string;
  };
  lines: { name: string; quantity: string; unitPrice: string; amountDue: string; vatTreatment: string; vatableSales: string; vatExemptSales: string; disposition: string }[];
  /** How a refund split between methods was given back (store credit, cash); omitted when it went one way. */
  refunds?: { method: string; amount: string }[];
}

/**
 * The slip handed over with a refund or a void: what came back, the refund and how it was paid
 * back, against which sale. Same shape as the sale receipt (so tills print it the same way); never
 * an invoice, and never called an official receipt.
 */
export function buildReturnReceipt(r: ReturnReceiptInput) {
  const isVat = r.seller.vatStatus === 'VAT';
  const local = new Intl.DateTimeFormat('en-PH', {
    timeZone: r.branch.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(r.doc.createdAt);
  const flag = (l: ReturnReceiptInput['lines'][number]) => {
    if (!isVat) return '';
    if (l.vatTreatment === 'ZERO_RATED') return 'Z';
    if (l.vatTreatment === 'VAT_EXEMPT') return 'E';
    const vatable = positive(l.vatableSales);
    const exempt = positive(l.vatExemptSales);
    return vatable && exempt ? 'V/E' : exempt ? 'E' : 'V';
  };
  const saleRef = `${r.sale.registerCode}-${String(r.sale.saleNumber).padStart(6, '0')}`;
  return {
    documentType: r.doc.kind === 'VOID' ? 'VOID_SLIP' : 'RETURN_SLIP',
    notice: r.invoicingMode === 'DEV_SERIES' ? DEV_SERIES_NOTICE : r.doc.kind === 'VOID' ? VOID_NOTICE : RETURN_NOTICE,
    seller: {
      name: r.seller.tradeName ?? r.seller.registeredName,
      registeredName: r.seller.registeredName,
      address: r.branch.address ?? r.seller.registeredAddress,
      tinLabel: isVat ? 'VAT REG TIN' : 'NON-VAT REG TIN',
      tin: formatTin(r.seller.tin, r.branch.birBranchCode),
      branch: r.branch.name,
    },
    transaction: {
      reference: `${r.doc.kind === 'VOID' ? 'VOID' : 'RETURN'} ${r.doc.returnNumber} of ${saleRef}`,
      saleNumber: r.sale.saleNumber,
      dateTime: local,
      timezone: r.branch.timezone,
      register: r.register.name,
      cashier: r.processedBy,
    },
    lines: r.lines.map((l) => ({
      name: l.disposition === 'DAMAGED' ? `${l.name} (damaged)` : l.name,
      quantity: l.quantity,
      unitPrice: m(l.unitPrice),
      amount: m(l.amountDue),
      flag: flag(l),
    })),
    charges: [],
    totals: {
      currency: r.sale.currency,
      // Stored with 4 decimals; the slip shows centavos like the sale receipt.
      ...(isVat
        ? {
            vatableSales: m(r.doc.vatableSales),
            vatLabel: `VAT ${pct(r.sale.vatRate)}`,
            vatAmount: m(r.doc.vatAmount),
            vatExemptSales: m(r.doc.vatExemptSales),
            zeroRatedSales: m(r.doc.zeroRatedSales),
            ...(positive(r.doc.vatExemptionAmount) && { vatExemption: m(r.doc.vatExemptionAmount) }),
          }
        : { salesSubjectToPercentageTax: m(r.doc.percentageTaxSales), exemptSales: m(r.doc.vatExemptSales) }),
      ...(positive(r.doc.statutoryDiscount) && { statutoryDiscount: m(r.doc.statutoryDiscount) }),
      refund: m(r.doc.amountDue),
    },
    tenders: r.refunds?.length ? r.refunds.map((t) => ({ method: t.method, amount: m(t.amount) })) : [{ method: r.doc.refundMethod ?? 'CASH', amount: m(r.doc.amountDue) }],
    statutory: [],
    reason: r.doc.reason,
    legend: isVat ? 'V = VATable, E = VAT-exempt, Z = zero-rated' : null,
  };
}

export function buildReceipt(r: ReceiptInput) {
  const isVat = r.seller.vatStatus === 'VAT';
  const local = new Intl.DateTimeFormat('en-PH', {
    timeZone: r.branch.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(r.sale.completedAt);
  // What the line was actually taxed as: an SC/PWD share of a VATable item is a VAT-exempt sale.
  const flag = (l: ReceiptInput['lines'][number]) => {
    if (!isVat) return '';
    if (l.vatTreatment === 'ZERO_RATED') return 'Z';
    if (l.vatTreatment === 'VAT_EXEMPT') return 'E';
    const vatable = positive(l.vatableSales);
    const exempt = positive(l.vatExemptSales);
    return vatable && exempt ? 'V/E' : exempt ? 'E' : 'V';
  };
  const statutory = r.beneficiaries.map((b) => {
    const lines = r.lines.filter((l) => l.beneficiaryId === b.id);
    const discount = lines.reduce((a, l) => a.plus(l.statutoryDiscount), new Dec(0));
    return {
      scheme: b.schemeCode,
      label: SCHEME_LABELS[b.schemeCode] ?? b.schemeCode,
      name: b.name,
      idNumber: b.idNumber,
      tin: b.tin,
      discount: discount.toFixed(2),
      // In-store statutory discounts need the beneficiary's signature (PH_COMPLIANCE_ASSUMPTIONS §7).
      signatureLine: true,
      ...(b.purchaseBooklet != null && { purchaseBooklet: b.purchaseBooklet }),
    };
  });

  return {
    documentType: r.invoicingMode === 'DEV_SERIES' ? 'DEV_TEST_DOCUMENT' : 'SALES_RECEIPT',
    notice: r.invoicingMode === 'DEV_SERIES' ? DEV_SERIES_NOTICE : NOT_AN_INVOICE,
    seller: {
      name: r.seller.tradeName ?? r.seller.registeredName,
      registeredName: r.seller.registeredName,
      address: r.branch.address ?? r.seller.registeredAddress,
      tinLabel: isVat ? 'VAT REG TIN' : 'NON-VAT REG TIN',
      tin: formatTin(r.seller.tin, r.branch.birBranchCode),
      branch: r.branch.name,
    },
    transaction: {
      reference: `${r.register.code}-${String(r.sale.saleNumber).padStart(6, '0')}`,
      saleNumber: r.sale.saleNumber,
      dateTime: local,
      timezone: r.branch.timezone,
      register: r.register.name,
      cashier: r.cashierName,
    },
    lines: r.lines.map((l) => ({
      name: l.isChoice ? `+ ${l.name}` : l.name,
      quantity: l.quantity,
      unitPrice: m(l.unitPrice),
      amount: toDec(l.gross).minus(l.discount).toFixed(2),
      ...(positive(l.discount) && { discount: m(l.discount) }),
      ...(l.promotion && positive(l.discount) && { promotion: l.promotion }),
      ...(l.staff && { staff: l.staff }),
      ...(l.packageSession && { packageSession: true }),
      ...(l.drugLabel && { generic: l.drugLabel }),
      // "Lot A123 · Exp 03/2027" per lot the line was drawn from.
      ...(l.lots?.length && { lots: l.lots.map((x) => [x.lotCode ? `Lot ${x.lotCode}` : null, `Exp ${x.expiresOn.slice(5, 7)}/${x.expiresOn.slice(0, 4)}`].filter(Boolean).join(' · ')) }),
      flag: flag(l),
    })),
    // Shown separately, never inside item prices (RA 11360); with its VAT, like the item lines above it.
    charges: (r.charges ?? []).map((c) => ({
      kind: c.kind,
      label: `${CHARGE_LABELS[c.kind] ?? c.kind} ${pct(c.rate)}`,
      amount: m(c.amountDue),
      flag: !isVat ? '' : c.vatTreatment === 'VAT_EXEMPT' ? 'E' : c.vatTreatment === 'ZERO_RATED' ? 'Z' : 'V',
    })),
    totals: {
      currency: r.sale.currency,
      // The sale's gross counts a charge ex VAT; the receipt's gross is the sum of the printed lines.
      gross: (r.charges ?? []).reduce((a, c) => a.plus(c.amountDue).minus(c.gross), toDec(r.sale.gross)).toFixed(2),
      ...(positive(r.sale.discount) && { discount: r.sale.discount }),
      ...(isVat
        ? {
            vatableSales: r.sale.vatableSales,
            vatLabel: `VAT ${pct(r.sale.vatRate)}`,
            vatAmount: r.sale.vatAmount,
            vatExemptSales: r.sale.vatExemptSales,
            zeroRatedSales: r.sale.zeroRatedSales,
            ...(positive(r.sale.vatExemptionAmount) && { vatExemption: r.sale.vatExemptionAmount }),
          }
        : { salesSubjectToPercentageTax: r.sale.percentageTaxSales, exemptSales: r.sale.vatExemptSales }),
      ...(positive(r.sale.statutoryDiscount) && { statutoryDiscount: r.sale.statutoryDiscount }),
      amountDue: r.sale.amountDue,
      tendered: r.sale.amountTendered,
      change: r.sale.changeDue,
    },
    tenders: r.tenders.map((t) => ({ method: t.method, amount: t.amount, ...(t.method === 'CASH' && { tendered: t.tendered, change: t.change }), ...(t.exchangeReturnNumber && { exchangeReturnNumber: t.exchangeReturnNumber }) })),
    statutory,
    ...(r.customer && { customer: { name: r.customer.name, ...(r.customer.tin && { tin: r.customer.tin }) } }),
    ...(r.tip && { tip: { method: r.tip.method, amount: m(r.tip.amount) } }),
    legend: isVat ? 'V = VATable, E = VAT-exempt, Z = zero-rated' : null,
  };
}
