import type { MessageKey } from '@/i18n/messages';
import type { IngredientUsage, ItemPerformance, KitchenVoids, OpenOrders, PrepTimes, RefundWatch, ServiceChargeReport } from './api';

/**
 * Reports as CSV for a spreadsheet or the accountant. Money and quantities stay the API's exact
 * decimal strings (no ₱, no grouping, never through a float); headers are in the viewer's language.
 */
export type CsvReport = 'sales' | 'products' | 'cashiers' | 'refunds' | 'tenders' | 'tax' | 'statutory' | 'items' | 'usage' | 'voids' | 'prep' | 'open' | 'charge';

/** API path (under /v1) for each report, given the branch and range. */
export function reportPath(report: CsvReport, q: { branchId: string; from: string; to: string; day: string }): string {
  const range = `branchId=${q.branchId}&from=${q.from}&to=${q.to}`;
  const paths: Record<CsvReport, string> = {
    sales: `/reports/sales-summary?${range}`,
    products: `/reports/by-product?${range}`,
    cashiers: `/reports/by-cashier?${range}`,
    refunds: `/reports/refund-watch?${range}`,
    tenders: `/reports/by-tender?${range}`,
    tax: `/reports/tax-summary?${range}`,
    statutory: `/reports/statutory-book?${range}`,
    items: `/reports/item-performance?${range}`,
    usage: `/reports/ingredient-usage?${range}`,
    voids: `/reports/kitchen-voids?${range}`,
    prep: `/reports/prep-times?${range}`,
    open: `/reports/open-orders?branchId=${q.branchId}&day=${q.day}`,
    charge: `/reports/service-charge?${range}`,
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
      const r = data as { data: { sku: string; name: string; quantitySold: string; quantityReturned: string; netQuantity: string; sales: string; returns: string; netSales: string; revenueExVat: string; cogs: string; grossProfit: string }[]; charges: { kind: string; charged: string; returned: string; net: string; netExVat: string }[] };
      return [
        ['SKU', t('common.item'), t('csv.qtySold'), t('csv.qtyReturned'), t('csv.netQty'), t('csv.sales'), t('csv.returns'), t('rep.netSales'), t('rep.revenueExVat'), t('rep.cogs'), t('rep.grossProfit')],
        ...r.data.map((x) => [x.sku, x.name, x.quantitySold, x.quantityReturned, x.netQuantity, x.sales, x.returns, x.netSales, x.revenueExVat, x.cogs, x.grossProfit]),
        ...r.charges.map((c) => ['', t('doc.serviceCharge'), '', '', '', c.charged, c.returned, c.net, c.netExVat, '', '']),
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
    case 'items': {
      const r = data as ItemPerformance;
      return [
        ['SKU', t('common.item'), t('csv.choiceOf'), t('csv.netQty'), t('rep.netSales'), t('rep.revenueExVat'), t('rep.cogs'), t('rep.grossProfit'), t('rep.margin')],
        ...r.data.flatMap((i) => [
          [i.sku, i.name, '', i.netQuantity, i.netSales, i.revenueExVat, i.cogs, i.grossProfit, i.marginPct ?? ''],
          ...i.modifiers.map((m) => [m.sku, m.name, i.name, m.netQuantity, m.netSales, m.revenueExVat, m.cogs, m.grossProfit, m.marginPct ?? '']),
        ]),
      ];
    }
    case 'usage': {
      const r = data as IngredientUsage;
      const sides = ['expected', 'preparedWaste', 'otherWaste', 'countVariance', 'actual', 'variance'] as const;
      return [
        ['SKU', t('common.item'), t('csv.unit'), ...sides.map((s) => `${t(`csv.usage.${s}` as MessageKey)} (${t('common.quantity')})`), ...sides.map((s) => `${t(`csv.usage.${s}` as MessageKey)} (${t('common.value')})`), t('csv.variancePct')],
        ...r.data.map((x) => [x.sku, x.name, x.unit, ...sides.map((s) => x.quantity[s]), ...sides.map((s) => x.value[s]), x.variancePct ?? '']),
      ];
    }
    case 'voids': {
      const r = data as KitchenVoids;
      return [
        [t('csv.when'), t('csv.order'), t('csv.table'), t('csv.station'), t('common.item'), t('common.quantity'), t('common.reason'), t('csv.by'), t('csv.stage'), t('csv.wasted'), t('csv.wasteValue')],
        ...r.data.map((x) => [x.voidedAt, x.order.orderNumber, x.order.tableCode ?? '', x.stationCode ?? '', x.name, x.quantity, x.reason, x.voidedBy.displayName ?? '', x.stage, x.wasted ? t('csv.yes') : t('csv.no'), x.wasteValue]),
      ];
    }
    case 'prep': {
      const r = data as PrepTimes;
      const row = (code: string, name: string, f: PrepTimes['overall']) =>
        f ? [code, name, f.tickets, f.items, f.timed, f.prepSeconds.average, f.prepSeconds.median, f.prepSeconds.p90, f.prepSeconds.max, f.waitSeconds, f.passSeconds] : [code, name];
      return [
        [t('csv.station'), t('common.name'), t('csv.tickets'), t('csv.items'), t('csv.timed'), t('csv.avgSec'), t('csv.medianSec'), t('csv.p90Sec'), t('csv.maxSec'), t('csv.waitSec'), t('csv.passSec')],
        ...r.stations.map((s) => row(s.code, s.name, s)),
        ...(r.overall ? [row('', t('csv.allStations'), r.overall)] : []),
      ];
    }
    case 'open': {
      const r = data as OpenOrders;
      return [
        [t('csv.order'), t('csv.type'), t('csv.table'), t('csv.customer'), t('csv.openedAt'), t('csv.by'), t('common.status'), t('csv.items'), t('csv.notServed'), t('doc.amountDue'), t('csv.paid'), t('csv.remaining')],
        ...r.data.map((x) => [x.orderNumber, x.orderType, x.tableCode ?? '', x.customerName ?? '', x.openedAt, x.openedBy.displayName ?? '', x.status, x.items, x.notServed, x.bill?.amountDue ?? '', x.bill?.paid ?? '', x.bill?.remaining ?? '']),
      ];
    }
    case 'charge': {
      const r = data as ServiceChargeReport;
      return [
        [t('common.date'), t('csv.checks'), t('csv.returnsCount'), t('csv.base'), t('csv.chargedExVat'), t('csv.chargedVat'), t('csv.returnedExVat'), t('csv.netExVat'), t('csv.netAmountDue')],
        ...r.days.map((d) => [d.day, d.checks, d.returns, d.base, d.charged.exVat, d.charged.vat, d.returned.exVat, d.net.exVat, d.net.amountDue]),
      ];
    }
  }
}
