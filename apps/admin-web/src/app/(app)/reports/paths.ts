export type ReportTab =
  | 'sales' | 'products' | 'cashiers' | 'refunds' | 'tenders' | 'tax' | 'statutory' | 'z'
  | 'promotions' | 'attributes'
  | 'category' | 'branches' | 'discounts' | 'purchases' | 'payments';

/** Each report's page (the CSV route sends a failed download back here). */
export const REPORT_PATHS: Record<ReportTab, string> = {
  sales: '/reports/sales',
  products: '/reports/products',
  promotions: '/reports/promotions',
  attributes: '/reports/sizes-colours',
  cashiers: '/reports/cashiers',
  refunds: '/reports/refunds',
  tenders: '/reports/tenders',
  tax: '/reports/tax',
  statutory: '/reports/statutory',
  z: '/reports/z-readings',
  category: '/reports/categories',
  branches: '/reports/branches',
  discounts: '/reports/discounts',
  purchases: '/reports/purchases',
  payments: '/reports/payments',
};
