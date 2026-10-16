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
  }[];
  tenders: { method: string; amount: string; tendered: string; change: string }[];
  beneficiaries: { id: string; schemeCode: string; name: string; idNumber: string; tin: string | null }[];
}

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
      name: l.name,
      quantity: l.quantity,
      unitPrice: m(l.unitPrice),
      amount: toDec(l.gross).minus(l.discount).toFixed(2),
      ...(positive(l.discount) && { discount: m(l.discount) }),
      flag: flag(l),
    })),
    totals: {
      currency: r.sale.currency,
      gross: r.sale.gross,
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
    tenders: r.tenders.map((t) => ({ method: t.method, amount: t.amount, ...(t.method === 'CASH' && { tendered: t.tendered, change: t.change }) })),
    statutory,
    legend: isVat ? 'V = VATable, E = VAT-exempt, Z = zero-rated' : null,
  };
}
