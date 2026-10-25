import type { MessageKey } from '@/i18n/messages';
import type { ByAttribute, ByBranch, ByCategory, DiscountsReport, PaymentExceptions, PromotionsReport, PurchasesBySupplier, RefundWatch } from './api';

/**
 * Reports as CSV for a spreadsheet or the accountant. Money and quantities stay the API's exact
 * decimal strings (no ₱, no grouping, never through a float); headers are in the viewer's language.
 */
export type CsvReport =
  | 'sales' | 'products' | 'cashiers' | 'refunds' | 'tenders' | 'tax' | 'statutory'
  | 'category' | 'branches' | 'discounts' | 'purchases' | 'payments'
  | 'promotions' | 'attributes';

/** API path (under /v1) for each report, given the branch and range (and, for sizes and colours, the attribute). */
export function reportPath(report: CsvReport, q: { branchId: string; from: string; to: string; attribute?: string }): string {
  const range = `branchId=${q.branchId}&from=${q.from}&to=${q.to}`;
  const paths: Record<CsvReport, string> = {
    sales: `/reports/sales-summary?${range}`,
    products: `/reports/by-product?${range}`,
    cashiers: `/reports/by-cashier?${range}`,
    refunds: `/reports/refund-watch?${range}`,
    tenders: `/reports/by-tender?${range}`,
    tax: `/reports/tax-summary?${range}`,
    statutory: `/reports/statutory-book?${range}`,
    category: `/reports/by-category?${range}`,
    branches: `/reports/by-branch?from=${q.from}&to=${q.to}`,
    discounts: `/reports/discounts?${range}`,
    purchases: `/reports/purchases-by-supplier?${range}`,
    payments: `/reports/payment-exceptions?branchId=${q.branchId}`,
    promotions: `/reports/promotions?${range}`,
    attributes: `/reports/by-attribute?${range}${q.attribute ? `&attribute=${encodeURIComponent(q.attribute)}` : ''}`,
  };
  return paths[report];
}

const BUCKETS = ['gross', 'discount', 'statutoryDiscount', 'vatExemptionAmount', 'vatableSales', 'vatAmount', 'vatExemptSales', 'zeroRatedSales', 'percentageTaxSales', 'amountDue'] as const;
type Bucket = (typeof BUCKETS)[number];
type Buckets = Record<Bucket, string>;
type Cell = string | number | null | undefined;
type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** One CSV field: quoted when needed; a leading = + - @ is prefixed so a spreadsheet never runs it as a formula. */
export function csvField(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+@\t\r]/.test(s) || (s.startsWith('-') && !/^-\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Cell[][]): string {
  // BOM so Excel opens UTF-8 (₱, ñ) correctly; CRLF line ends per RFC 4180.
  return `﻿${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** Header + rows for one report's API answer. */
export function reportRows(report: CsvReport, data: unknown, t: T): Cell[][] {
  const bucketHeads = BUCKETS.map((b) => t(`csv.${b}` as MessageKey));
  switch (report) {
    case 'sales': {
      const r = data as { days: { day: string; salesCount: number; returnsCount: number; voidsCount: number; sales: Buckets; returns: Buckets; net: Buckets }[] };
      return [
        [t('common.date'), t('csv.part'), t('csv.count'), ...bucketHeads],
        ...r.days.flatMap((d) => [
          [d.day, t('csv.sales'), d.salesCount, ...BUCKETS.map((b) => d.sales[b])],
          [d.day, t('csv.returns'), d.returnsCount + d.voidsCount, ...BUCKETS.map((b) => d.returns[b])],
          [d.day, t('csv.net'), '', ...BUCKETS.map((b) => d.net[b])],
        ]),
      ];
    }
    case 'products': {
      const r = data as { data: { sku: string; name: string; quantitySold: string; quantityReturned: string; netQuantity: string; sales: string; returns: string; netSales: string; revenueExVat: string; cogs: string; grossProfit: string }[] };
      return [
        ['SKU', t('common.item'), t('csv.qtySold'), t('csv.qtyReturned'), t('csv.netQty'), t('csv.sales'), t('csv.returns'), t('rep.netSales'), t('rep.revenueExVat'), t('rep.cogs'), t('rep.grossProfit')],
        ...r.data.map((x) => [x.sku, x.name, x.quantitySold, x.quantityReturned, x.netQuantity, x.sales, x.returns, x.netSales, x.revenueExVat, x.cogs, x.grossProfit]),
      ];
    }
    case 'cashiers': {
      const r = data as { data: { displayName: string | null; salesCount: number; sales: string; returnsProcessed: number; returns: string }[] };
      return [[t('csv.cashier'), t('csv.salesCount'), t('csv.sales'), t('csv.returnsCount'), t('csv.returns')], ...r.data.map((x) => [x.displayName ?? '', x.salesCount, x.sales, x.returnsProcessed, x.returns])];
    }
    case 'refunds': {
      const r = data as RefundWatch;
      return [
        [t('csv.cashier'), t('csv.salesCount'), t('csv.sales'), t('csv.returnsCount'), t('csv.returns'), t('rep.voidsCol'), t('csv.voids'), t('rep.ownRefunds'), t('rep.refundRate'), t('rep.flags')],
        ...r.data.map((x) => [x.displayName ?? '', x.salesCount, x.sales, x.returnsCount, x.returns, x.voidsCount, x.voids, x.ownSalesRefunded, x.refundRate ?? '', x.flags.join(' ')]),
      ];
    }
    case 'tenders': {
      const r = data as { data: { method: string; tenders: number; collected: string; refundsCount: number; refunded: string; net: string }[] };
      return [[t('csv.method'), t('csv.count'), t('csv.collected'), t('csv.returnsCount'), t('csv.refunded'), t('csv.net')], ...r.data.map((x) => [x.method, x.tenders, x.collected, x.refundsCount, x.refunded, x.net])];
    }
    case 'tax': {
      const r = data as { data: (Omit<Buckets, 'gross' | 'discount'> & { vatStatus: string; vatRate: string })[] };
      const cols = BUCKETS.filter((b) => b !== 'gross' && b !== 'discount') as Exclude<Bucket, 'gross' | 'discount'>[];
      return [[t('loc.vat'), t('csv.vatRate'), ...cols.map((b) => t(`csv.${b}` as MessageKey))], ...r.data.map((x) => [x.vatStatus, x.vatRate, ...cols.map((b) => x[b])])];
    }
    case 'statutory': {
      const r = data as { data: { document: string; day: string; number: number; register: string; schemeCode: string; name: string; idNumber: string; tin: string | null; sales: string; discount: string; net: string }[] };
      return [
        [t('common.date'), t('csv.document'), t('common.number'), t('csv.register'), t('csv.scheme'), t('csv.beneficiary'), t('csv.idNumber'), 'TIN', t('csv.sales'), t('csv.discount'), t('csv.net')],
        ...r.data.map((x) => [x.day, x.document, x.number, x.register, x.schemeCode, x.name, x.idNumber, x.tin ?? '', x.sales, x.discount, x.net]),
      ];
    }
    case 'category': {
      const r = data as ByCategory;
      return [
        [t('rep.category'), t('csv.netQty'), t('csv.sales'), t('csv.returns'), t('rep.netSales'), t('rep.revenueExVat'), t('rep.cogs'), t('rep.grossProfit')],
        ...r.data.map((x) => [x.path.join(' > ') || t('rep.noCategory'), x.netQuantity, x.sales, x.returns, x.netSales, x.revenueExVat, x.cogs, x.grossProfit]),
      ];
    }
    case 'branches': {
      const r = data as ByBranch;
      return [
        [t('common.branch'), t('csv.salesCount'), t('csv.sales'), t('csv.returnsCount'), t('csv.returns'), t('rep.netSales'), t('csv.vatAmount'), t('rep.revenueExVat'), t('csv.discount'), t('csv.statutoryDiscount')],
        ...r.data.map((x) => [`${x.code} ${x.name}`, x.salesCount, x.sales, x.returnsCount, x.returns, x.netSales, x.vatAmount, x.netExVat, x.discount, x.statutoryDiscount]),
        [t('rep.allBranches'), r.totals.salesCount, r.totals.sales, r.totals.returnsCount, r.totals.returns, r.totals.netSales, r.totals.vatAmount, r.totals.netExVat, r.totals.discount, r.totals.statutoryDiscount],
      ];
    }
    case 'discounts': {
      const r = data as DiscountsReport;
      return [
        [t('cust.receipt'), t('cust.when'), t('common.item'), t('common.quantity'), t('rep.listPrice'), t('rep.soldAt'), t('csv.discount'), t('rep.priceChange'), t('csv.cashier'), t('rep.approvedBy'), t('common.reason')],
        ...r.data.map((l) => [l.reference, l.completedAt, l.name, l.quantity, l.listUnitPrice, l.unitPrice, l.discount, l.priceChange, l.cashierName ?? '', l.approvedByName ?? '', l.priceReason ?? '']),
      ];
    }
    case 'purchases': {
      const r = data as PurchasesBySupplier;
      return [
        [t('rep.supplier'), t('rep.receipts'), t('rep.received'), t('rep.returnedToSupplier'), t('rep.netReceived'), t('rep.invoices'), t('rep.invoiced')],
        ...r.data.map((x) => [`${x.code} ${x.name}`, x.receipts, x.received, x.returned, x.netReceived, x.invoices, x.invoiced]),
      ];
    }
    case 'promotions': {
      const r = data as PromotionsReport;
      return [
        [t('promo.name'), t('promo.kind'), t('csv.salesCount'), t('csv.netQty'), t('rep.promoDiscount'), t('rep.netSales')],
        ...r.data.map((x) => [x.name, t(`promo.kind.${x.kind}` as MessageKey), x.salesCount, x.netQuantity, x.discount, x.netSales]),
      ];
    }
    case 'attributes': {
      const r = data as ByAttribute;
      const attribute = r.attribute ?? '';
      return [
        [attribute || t('rep.attribute'), t('csv.qtySold'), t('csv.qtyReturned'), t('csv.netQty'), t('rep.netSales'), t('rep.revenueExVat')],
        ...r.data.map((x) => [x.value ?? t('rep.attrNone', { attribute }), x.quantitySold, x.quantityReturned, x.netQuantity, x.netSales, x.revenueExVat]),
      ];
    }
    case 'payments': {
      const r = data as PaymentExceptions;
      return [
        [t('rep.problem'), t('csv.method'), t('rep.takenAt'), t('rep.shift'), t('rep.amount')],
        ...r.data.map((x) => [t(`rep.problem.${x.problem}` as MessageKey), x.method, x.createdAt, `${x.registerCode} ${x.cashierName ?? ''}`.trim(), x.amount]),
      ];
    }
  }
}
