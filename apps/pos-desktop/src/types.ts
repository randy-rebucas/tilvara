/** Shapes returned by the Tilvara API that the counter uses (see docs/api/openapi.json). */
export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  /** businessType: RETAIL leaves out restaurant service (tables, floor, kitchen display). */
  activeTenant: { tenantId: string; businessType?: 'RETAIL' | 'RESTAURANT' | 'HYBRID'; permissions: string[] } | null;
  memberships: { tenantId: string; tenantName: string; tenantSlug: string }[];
}

/** Whether the business serves tables at all (business type); permissions decide who does. */
export const servesTables = (me: Me) => me.activeTenant?.businessType !== 'RETAIL';

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
  /** A weighing-scale label carried this quantity (kg): the line takes it as weighed. */
  quantity?: string;
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
  /** How it was paid (CASH, CARD, QR) and what happened since: voided, or items returned. */
  tenderMethods?: string[];
  voided?: boolean;
  returnCount?: number;
}

export interface SaleDetail extends Omit<SaleSummary, 'tenderMethods' | 'voided' | 'returnCount'> {
  lines: { id: string; name: string; sku: string; quantity: string; returnedQuantity: string; amountDue: string }[];
}

// ------------------------------------------------------------------ restaurant (ADR-0014)

export interface DiningTable {
  id: string;
  code: string;
  seats: number;
  areaId: string;
}

export interface DiningArea {
  id: string;
  name: string;
  tables: DiningTable[];
}

export type OrderStatus = 'OPEN' | 'BILLED' | 'SETTLED' | 'CANCELLED' | 'MERGED';
export type ItemStatus = 'PENDING' | 'FIRED' | 'IN_PREP' | 'READY' | 'SERVED' | 'VOIDED';

export interface OrderSummary {
  id: string;
  orderNumber: number;
  orderType: 'DINE_IN' | 'TAKEAWAY';
  tableId: string | null;
  customerName: string | null;
  guestCount: number | null;
  status: OrderStatus;
  openedAt: string;
  /** Count of items (not quantities) per status. */
  items: Partial<Record<ItemStatus, number>>;
}

export interface OrderItem {
  id: string;
  variantId: string | null;
  name: string;
  quantity: string;
  course: number;
  seat: number | null;
  note: string | null;
  status: ItemStatus;
  voidReason: string | null;
  wasteAdjustmentId: string | null;
  modifiers: { id: string; name: string; variantId: string | null; quantity: string; status: ItemStatus }[];
}

export interface Order extends Omit<OrderSummary, 'items'> {
  table: { id: string; code: string } | null;
  bill: { id: string; billNumber: number; status: 'ACTIVE' | 'SETTLED'; amountDue: string } | null;
  items: OrderItem[];
  /** Notes per course (session 16); each fired ticket keeps the note it was fired with. */
  courseNotes?: { course: number; note: string }[];
}

export interface MenuOption {
  id: string;
  name: string;
  variantId: string | null;
  price: string | null;
  available: boolean;
}

export interface MenuItem {
  id: string;
  variantId: string;
  name: string;
  price: string | null;
  soldOut: boolean;
  available: boolean;
  modifierGroups: { id: string; name: string; minSelect: number; maxSelect: number; options: MenuOption[] }[];
}

export interface BranchMenu {
  menu: { id: string; name: string; sections: { id: string; name: string; items: MenuItem[] }[] } | null;
}

export interface BillLine {
  id: string;
  parentLineId: string | null;
  name: string;
  quantity: string;
  amountDue: string;
  statutoryDiscount: string;
  beneficiaryId: string | null;
  /** "n/d" of the line already paid. */
  paidShare: string;
  paidQuantity: string;
  fullyPaid: boolean;
  /** The seat the item was ordered for (split by seat), when the server took one. */
  seat?: number | null;
}

export interface Bill extends Totals {
  id: string;
  orderId: string;
  billNumber: number;
  status: 'ACTIVE' | 'SETTLED' | 'VOIDED';
  requiresProfessionalReview: boolean;
  lines: BillLine[];
  charges: { id: string; kind: string; rate: string; amountDue: string }[];
  checks: { id: string; saleNumber: number; amountDue: string; completedAt: string }[];
  amountPaid: string;
  amountRemaining: string;
}

export interface KitchenTicket {
  id: string;
  ticketNumber: number;
  course: number;
  firedAt: string;
  bumpedAt?: string | null;
  station: { id: string; code: string; name: string };
  /** Where the food goes now (the order may have moved tables since firing). */
  order: { id: string; orderNumber: number; orderType: 'DINE_IN' | 'TAKEAWAY'; tableCode: string | null; customerName: string | null } | null;
  items: { id: string; name: string; quantity: string; seat: number | null; note: string | null; status: ItemStatus; modifiers: { id: string; name: string; status?: ItemStatus }[] }[];
  /** The order's note for this course when it was fired. */
  courseNote?: string | null;
}

export interface CheckPreview {
  settles: boolean;
  amountDue: string;
  lines: { billLineId: string; parentBillLineId: string | null; name: string; quantity: string; amountDue: string }[];
  charges: { kind: string; amountDue: string }[];
}

export interface Receipt {
  notice: string;
  seller: { name: string; registeredName: string; address: string | null; tinLabel: string; tin: string | null; branch: string };
  transaction: { reference: string; dateTime: string; register: string; cashier: string };
  lines: { name: string; quantity: string; unitPrice: string; amount: string; discount?: string; flag: string }[];
  /** Non-item charges such as the service charge, each printed on its own line. */
  charges?: { kind: string; label: string; amount: string; flag: string }[];
  totals: Record<string, string>;
  tenders: { method: string; amount: string; tendered?: string; change?: string }[];
  statutory: { label: string; name: string; idNumber: string; discount: string; signatureLine: boolean }[];
  legend: string | null;
  /** A return or void slip: why the goods came back. */
  reason?: string;
}
