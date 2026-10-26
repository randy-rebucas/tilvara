/** Shapes returned by the Tilvara API that the counter uses (see docs/api/openapi.json). */
export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  /** `extensions`: the business's usable extensions (ADR-0026); absent from older servers. */
  activeTenant: { tenantId: string; permissions: string[]; extensions?: string[] } | null;
  memberships: { tenantId: string; tenantName: string; tenantSlug: string }[];
}

export interface Workstation {
  register: { id: string; code: string; name: string };
  /** legalEntityId: whose store credit a customer can spend here (ADR-0018). */
  branch: { id: string; code: string; name: string; timezone: string; legalEntityId?: string };
  openSession: { id: string; openedBy: string; mine: boolean; openedAt: string } | null;
}

export interface LookupItem {
  variantId: string;
  sku: string;
  name: string;
  soldBy: 'UNIT' | 'WEIGHT';
  uom: { code: string; allowsFraction: boolean };
  price: { amount: string } | null;
  /** A weighing-scale label carried this quantity (kg): the line takes it as weighed. */
  quantity?: string;
  /** STANDARD or SERVICE, when the source gives it (the till's snapshot does). */
  productType?: ProductType;
  /** An expiry item where expired or held stock may not be sold: what is sellable here now (online only). */
  sellable?: { onHand: string; expiredOrHeld: string; sellable: string };
}

export type ProductType = 'STANDARD' | 'SERVICE';

export interface QuoteLine {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  unitPrice: string;
  quantity: string;
  gross: string;
  /** Ordinary discount on the line (online only). */
  discount?: string;
  statutoryDiscount: string;
  amountDue: string;
  vatTreatment: string;
  /** An approved price change: the list price it replaced. */
  priceOverrideId?: string | null;
  listUnitPrice?: string;
  /** The promotion that priced the line (ADR-0021); its discount is `discount`. */
  promotionId?: string | null;
  promotionName?: string;
  productType?: ProductType;
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
  /** How it was paid (CASH, CARD, QR) and what happened since: voided, or items returned. */
  tenderMethods?: string[];
  voided?: boolean;
  returnCount?: number;
}

/** A customer at the counter (ADR-0018): who, and the store credit they hold with each company. */
export interface CounterCustomer {
  id: string;
  displayName: string;
  phone: string | null;
  code: string | null;
  marketingConsent: boolean;
  storeCredit: { legalEntityId: string; balance: string }[];
  canManage: boolean;
}

export interface SaleDetail extends Omit<SaleSummary, 'tenderMethods' | 'voided' | 'returnCount'> {
  customerId?: string | null;
  lines: { id: string; name: string; sku: string; quantity: string; returnedQuantity: string; amountDue: string }[];
}

export interface Receipt {
  notice: string;
  seller: { name: string; registeredName: string; address: string | null; tinLabel: string; tin: string | null; branch: string };
  transaction: { reference: string; dateTime: string; register: string; cashier: string };
  /** `promotion`: the promotion that gave the line's `discount` (ADR-0021); `lots`: the expiry batches its sale drew. */
  lines: { name: string; quantity: string; unitPrice: string; amount: string; discount?: string; promotion?: string; flag: string; lots?: string[] }[];
  /** A sale made before table service was removed may carry a service charge: its own line, never an item. */
  charges?: { kind: string; label: string; amount: string; flag: string }[];
  totals: Record<string, string>;
  /** `exchangeReturnNumber`: this cash is the refund of that return, put towards the sale (an exchange). */
  tenders: { method: string; amount: string; tendered?: string; change?: string; exchangeReturnNumber?: number }[];
  statutory: { label: string; name: string; idNumber: string; discount: string; signatureLine: boolean }[];
  legend: string | null;
  /** A return or void slip: why the goods came back. */
  reason?: string;
  /** The customer the sale was rung up for (ADR-0018), with their TIN when they gave one. */
  customer?: { name: string; tin?: string };
}
