import type { MessageKey } from '@/i18n/messages';
import type { AccommodationTaxReport, GuestLedgerReport, OccupancyReport, SalesSummaryRooms, ByAttribute, ByBranch, ByCategory, CommissionsReport, ServicePackagesReport, TipsByStaffReport, DiscountsReport, IngredientUsage, ItemPerformance, KitchenVoids, OpenOrders, PaymentExceptions, PrepTimes, PromotionsReport, PurchasesBySupplier, RefundWatch, ServiceChargeReport, TipsReport } from './api';

/**
 * Reports as CSV for a spreadsheet or the accountant. Money and quantities stay the API's exact
 * decimal strings (no ₱, no grouping, never through a float); headers are in the viewer's language.
 */
export type CsvReport =
  | 'sales' | 'products' | 'cashiers' | 'refunds' | 'tenders' | 'tax' | 'statutory'
  | 'items' | 'usage' | 'voids' | 'prep' | 'open' | 'charge' | 'tips'
  | 'category' | 'branches' | 'discounts' | 'purchases' | 'payments'
  | 'promotions' | 'attributes'
  | 'commissions' | 'servicePackages' | 'staffTips'
  | 'occupancy' | 'guestLedger' | 'accommodationTax';

/**
 * API path (under /v1) for each report, given the branch and range (and, for sizes and colours, the
 * attribute; for the guest ledger, the branch's legal entity).
 */
export function reportPath(report: CsvReport, q: { branchId: string; from: string; to: string; day: string; attribute?: string; legalEntityId?: string }): string {
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
    tips: `/reports/tips?${range}`,
    category: `/reports/by-category?${range}`,
    branches: `/reports/by-branch?from=${q.from}&to=${q.to}`,
    discounts: `/reports/discounts?${range}`,
    purchases: `/reports/purchases-by-supplier?${range}`,
    payments: `/reports/payment-exceptions?branchId=${q.branchId}`,
    promotions: `/reports/promotions?${range}`,
    commissions: `/reports/commissions?${range}`,
    servicePackages: `/reports/service-packages?${range}`,
    staffTips: `/reports/tips-by-staff?${range}`,
    occupancy: `/reports/occupancy?${range}`,
    guestLedger: `/reports/guest-ledger?legalEntityId=${q.legalEntityId ?? ''}`,
    accommodationTax: `/reports/accommodation-tax?${range}`,
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
      const r = data as { days: { day: string; salesCount: number; returnsCount: number; voidsCount: number; sales: Buckets; returns: Buckets; net: Buckets }[]; rooms?: SalesSummaryRooms };
      return [
        [t('common.date'), t('csv.part'), t('csv.count'), ...bucketHeads],
        ...r.days.flatMap((d) => [
          [d.day, t('csv.sales'), d.salesCount, ...BUCKETS.map((b) => d.sales[b])],
          [d.day, t('csv.returns'), d.returnsCount + d.voidsCount, ...BUCKETS.map((b) => d.returns[b])],
          [d.day, t('csv.net'), '', ...BUCKETS.map((b) => d.net[b])],
        ]),
        // ADR-0023: room nights are not sales; they follow as their own part, by night.
        ...(r.rooms?.days ?? []).map((d) => [d.day, t('csv.rooms'), d.nights, ...BUCKETS.map((b) => d[b])]),
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
        ['SKU', t('common.item'), t('csv.choiceOf'), t('csv.netQty'), t('rep.netSales'), t('rep.revenueExVat'), t('rep.cogs'), t('rep.grossProfit'), t('rep.margin'), t('rep.ordersCol')],
        ...r.data.flatMap((i) => [
          [i.sku, i.name, '', i.netQuantity, i.netSales, i.revenueExVat, i.cogs, i.grossProfit, i.marginPct ?? '', ''],
          ...i.modifiers.map((m) => [m.sku, m.name, i.name, m.netQuantity, m.netSales, m.revenueExVat, m.cogs, m.grossProfit, m.marginPct ?? '', '']),
          // Free choices (session 25): a count with no money of its own.
          ...(i.freeChoices ?? []).map((c) => ['', c.name, i.name, c.quantity, '', '', '', '', '', c.orders]),
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
    case 'tips': {
      const r = data as TipsReport;
      const figures = (x: TipsReport['totals']) => [x.tips, x.cash, x.electronic, x.taken, x.refunded, x.paidOut, x.owed];
      return [
        [t('common.date'), t('rep.tipsCount'), t('rep.tipsCash'), t('rep.tipsElectronic'), t('rep.tipsTaken'), t('rep.tipsRefunded'), t('rep.tipsPaidOut'), t('rep.tipsOwed')],
        ...r.days.map((d) => [d.day, ...figures(d)]),
        [t('common.total'), ...figures(r.totals)],
        [t('rep.tipsLedger'), '', '', '', '', '', '', r.ledger],
        [],
        [t('csv.cashier'), t('rep.tipsCount'), t('rep.tipsTaken')],
        ...r.byCashier.map((c) => [c.name ?? '', c.tips, c.amount]),
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
    case 'commissions': {
      const r = data as CommissionsReport;
      return [
        [t('rep.staffMember'), t('rep.lines'), t('csv.sales'), t('csv.returns'), t('rep.commissionBase'), t('rep.commission')],
        ...r.staff.map((x) => [x.name, x.lines, x.sales, x.returns, x.netBase, x.commission]),
        [t('common.total'), r.totals.lines, r.totals.sales, r.totals.returns, r.totals.netBase, r.totals.commission],
      ];
    }
    case 'servicePackages': {
      const r = data as ServicePackagesReport;
      return [
        [t('rep.pkgFigure'), t('rep.amount')],
        [t('rep.pkgSold'), r.sold],
        [t('rep.pkgUsed'), r.used],
        [t('rep.pkgRefunded'), r.refunded],
        [t('rep.pkgRestored'), r.restored],
        [t('rep.pkgOwed'), r.owed],
        [t('rep.pkgLedger'), r.ledger],
        [t('rep.pkgCount'), r.packagesSold],
        [t('rep.pkgSessionsSold'), r.sessionsSold],
        [t('rep.pkgSessionsUsed'), r.sessionsUsed],
        [],
        [t('rep.pkgName'), t('doc.customer'), t('rep.pkgExpires'), t('rep.pkgSessionsLeft'), t('rep.pkgValueLeft')],
        ...r.open.map((o) => [o.name, o.customer, o.expiresOn ?? '', o.sessionsLeft, o.valueLeft]),
      ];
    }
    case 'staffTips': {
      const r = data as TipsByStaffReport;
      return [
        [t('rep.staffMember'), t('rep.tipsCount'), t('rep.tipsTaken'), t('rep.tipsVoided')],
        ...r.staff.map((x) => [x.name ?? t('rep.unassigned'), x.tips, x.amount, x.voided]),
        [t('common.total'), '', r.total, ''],
      ];
    }
    case 'occupancy': {
      const r = data as OccupancyReport;
      const row = (x: OccupancyReport['totals']) => [x.roomsAvailable, x.roomsSold, x.occupancyPercent ?? '', x.roomRevenueExVat, x.adr ?? '', x.revpar ?? ''];
      return [
        [t('common.date'), t('rep.roomsAvailable'), t('rep.roomsSold'), t('rep.occupancyPct'), t('rep.roomRevenue'), t('rep.adr'), t('rep.revpar')],
        ...r.days.map((d) => [d.day, ...row(d)]),
        [t('common.total'), ...row(r.totals)],
      ];
    }
    case 'guestLedger': {
      const r = data as GuestLedgerReport;
      return [
        [t('rep.glFigure'), t('rep.amount')],
        [t('rep.glOpenFolios'), r.totals.folios],
        [t('rep.glLedgerBooks'), r.totals.guestLedgerGl],
        [t('rep.glDifference'), r.totals.guestLedgerDifference],
        [t('rep.glDeposits'), r.totals.deposits],
        [t('rep.glDepositsBooks'), r.totals.guestDepositsGl],
        [t('rep.glDifference'), r.totals.depositsDifference],
        [],
        [t('lod.room'), t('lod.guest'), t('lod.arrival'), t('lod.departure'), t('common.status'), t('lod.folioBalance')],
        ...r.folios.map((f) => [f.roomNumber, f.guestName ?? '', f.arrivalDate, f.departureDate, f.stayStatus, f.balance]),
        [],
        [t('lod.room'), t('lod.arrival'), t('common.status'), t('lod.depositsHeld')],
        ...r.deposits.map((d) => [d.roomNumber, d.arrivalDate, d.stayStatus, d.held]),
      ];
    }
    case 'accommodationTax': {
      const r = data as AccommodationTaxReport;
      return [
        [t('rep.month'), t('rep.nights'), t('rep.accTaxBase'), t('rep.accTax')],
        ...r.data.map((x) => [x.month, x.nights, x.base, x.tax]),
        [t('common.total'), '', r.totals.base, r.totals.tax],
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
