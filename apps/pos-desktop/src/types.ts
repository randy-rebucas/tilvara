/** Shapes returned by the 1POS API that the counter uses (see docs/api/openapi.json). */
export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  activeTenant: { tenantId: string; permissions: string[] } | null;
  memberships: { tenantId: string; tenantName: string; tenantSlug: string }[];
}

export interface Workstation {
  register: { id: string; code: string; name: string };
  branch: { id: string; code: string; name: string; timezone: string };
  openSession: { id: string; openedBy: string; mine: boolean; openedAt: string } | null;
}

export interface LookupItem {
  variantId: string;
  sku: string;
  name: string;
  soldBy: 'UNIT' | 'WEIGHT';
  uom: { code: string; allowsFraction: boolean };
  price: { amount: string } | null;
}

export interface QuoteLine {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  unitPrice: string;
  quantity: string;
  gross: string;
  statutoryDiscount: string;
  amountDue: string;
  vatTreatment: string;
}

export interface Totals {
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
}

export interface Quote {
  taxProfile: { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string };
  lines: QuoteLine[];
  totals: Totals;
  requiresProfessionalReview: boolean;
}

export interface PaymentIntent {
  id: string;
  method: 'CARD' | 'QR' | 'EWALLET';
  amount: string;
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELED';
  failureCode: string | null;
  clientTransactionId: string;
  createdAt: string;
}

export interface SaleSummary {
  id: string;
  saleNumber: number;
  amountDue: string;
  completedAt: string;
}

export interface SaleDetail extends SaleSummary {
  lines: { id: string; name: string; sku: string; quantity: string; returnedQuantity: string; amountDue: string }[];
}

export interface Receipt {
  notice: string;
  seller: { name: string; registeredName: string; address: string | null; tinLabel: string; tin: string | null; branch: string };
  transaction: { reference: string; dateTime: string; register: string; cashier: string };
  lines: { name: string; quantity: string; unitPrice: string; amount: string; discount?: string; flag: string }[];
  totals: Record<string, string>;
  tenders: { method: string; amount: string; tendered?: string; change?: string }[];
  statutory: { label: string; name: string; idNumber: string; discount: string; signatureLine: boolean }[];
  legend: string | null;
}
