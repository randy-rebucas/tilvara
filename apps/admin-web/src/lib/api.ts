import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_URL } from './config';
import { ACCESS_COOKIE } from './cookies';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Server-component fetch to the 1POS API with the session's bearer token.
 * 401 → sign-in; other errors throw ApiError for the page to render as a state.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect('/sign-in');
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/sign-in');
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Request failed', e?.details);
  }
  return body as T;
}

/** Like api(), but returns null on 403/404 so a page can show "no access" instead of crashing. */
export async function apiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

// ---- response shapes used by the admin (subset of the API) ----
export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  activeTenant: { tenantId: string; membershipId: string; status: string; permissions: string[] } | null;
  memberships: { membershipId: string; tenantId: string; tenantSlug: string; tenantName: string; tenantStatus: string }[];
}
export interface LegalEntity {
  id: string;
  registeredName: string;
  tradeName: string | null;
  tin: string | null;
  vatStatus: 'VAT' | 'NON_VAT';
  priceDisplay: string;
  invoicingMode: string;
  archivedAt: string | null;
}
export interface Branch {
  id: string;
  legalEntityId: string;
  code: string;
  name: string;
  birBranchCode: string;
  timezone: string;
  address: string | null;
  archivedAt: string | null;
}
export interface Register {
  id: string;
  branchId: string;
  code: string;
  name: string;
  archivedAt: string | null;
}
export interface Terminal {
  id: string;
  registerId: string;
  name: string;
  status: 'ACTIVE' | 'REVOKED';
  credentialHint: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}
export interface Subscription {
  plan: { code: string; name: string; limits: Record<string, number>; features: string[] };
  status: string;
  access: 'FULL' | 'READ_ONLY';
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  usage: Record<string, number>;
}
export interface Product {
  id: string;
  name: string;
  productType: string;
  soldBy: string;
  trackInventory: boolean;
  categoryId: string | null;
  archivedAt: string | null;
  variants: { id: string; sku: string; name: string | null; barcodes: string[]; archivedAt: string | null }[];
}
export interface PriceList {
  id: string;
  name: string;
  currency: string;
  pricesIncludeTax: boolean;
  isDefault: boolean;
  archivedAt: string | null;
}
export interface CurrentPrice {
  priceId: string;
  variantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  amount: string;
  effectiveFrom: string;
  scheduled: { amount: string; effectiveFrom: string } | null;
}
export interface Member {
  membershipId: string;
  status: string;
  user: { id: string; email: string; displayName: string };
  roles: { roleKey: string; scopeType: string; scopeId: string | null }[];
}
export interface Role {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}
export interface Invitation {
  id: string;
  email: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  roles: { roleId: string; scopeType: string; scopeId: string | null }[];
}
export interface Uom {
  id: string;
  code: string;
  name: string;
  allowsFraction: boolean;
}
export interface TaxCategory {
  id: string;
  code: string;
  name: string;
  vatTreatment: string;
}

// ---- purchasing (Phase 3) ----
export interface Supplier {
  id: string;
  code: string;
  name: string;
  tin: string | null;
  email: string | null;
  phone: string | null;
  paymentTermsDays: number;
  archivedAt: string | null;
}
export type OrderStatus = 'DRAFT' | 'APPROVED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';
export interface PurchaseOrderRow {
  id: string;
  branchId: string;
  supplierId: string;
  supplierName: string;
  poNumber: number;
  status: OrderStatus;
  expectedOn: string | null;
  supplierRef: string | null;
  createdAt: string;
  orderedValue: string;
}
export interface PurchaseOrder extends Omit<PurchaseOrderRow, 'supplierName'> {
  notes: string | null;
  approvedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  supplier: { id: string; code: string; name: string };
  receivedValue: string;
  lines: {
    id: string;
    lineNo: number;
    variantId: string;
    sku: string;
    name: string;
    quantity: string;
    unitCost: string;
    lineValue: string;
    receivedQuantity: string;
    rejectedQuantity: string;
    remainingQuantity: string;
  }[];
  receipts: { id: string; receiptNumber: number; supplierInvoiceRef: string | null; createdAt: string }[];
}
export interface GoodsReceiptRow {
  id: string;
  branchId: string;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string | null;
  receiptNumber: number;
  supplierInvoiceRef: string | null;
  supplierDeliveryRef: string | null;
  createdAt: string;
}
export interface GoodsReceipt extends Omit<GoodsReceiptRow, 'supplierName'> {
  notes: string | null;
  receivedValue: string;
  lines: { id: string; purchaseOrderLineId: string | null; variantId: string; quantity: string; rejectedQuantity: string; rejectionReason: string | null; unitCost: string; lineValue: string }[];
}

// ---- inventory (Phase 3) ----
export interface TransferRow {
  id: string;
  fromBranchId: string;
  toBranchId: string;
  transferNumber: number;
  status: 'DISPATCHED' | 'RECEIVED';
  notes: string | null;
  createdAt: string;
  receivedAt: string | null;
}
export interface Transfer extends TransferRow {
  receiveNotes: string | null;
  sentValue: string;
  receivedValue: string | null;
  inTransitValue: string;
  transitLossValue: string | null;
  lines: { id: string; variantId: string; sku: string; name: string; quantity: string; receivedQuantity: string | null; shortQuantity: string | null; discrepancyReason: string | null; unitCost: string }[];
}
export interface CountRow {
  id: string;
  branchId: string;
  countNumber: number;
  notes: string | null;
  createdAt: string;
}
export interface Count extends CountRow {
  varianceValue: string;
  lines: { id: string; variantId: string; sku: string; name: string; countedQuantity: string; systemQuantity: string; varianceQuantity: string; varianceValue: string }[];
}
export interface Adjustment {
  id: string;
  branchId: string;
  kind: 'ADJUSTMENT' | 'WASTE';
  reason: string;
  createdAt: string;
  value: string;
  lines: { movementId: string; variantId: string; sku: string; name: string; quantity: string; unitCost: string; value: string }[];
}
export interface LowStockRow {
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  reorderPoint: string;
  reorderQuantity: string | null;
  low: boolean;
  onOrder: string;
  suggestedOrder: string;
  lastCost: string;
}
export interface Valuation {
  branchId: string;
  data: { variantId: string; sku: string; name: string; quantity: string; avgCost: string; value: string }[];
  totalValue: string;
  ledgerValue: string;
}
export interface MovementSummary {
  data: {
    variantId: string;
    sku: string;
    name: string;
    opening: { quantity: string; value: string };
    movements: Record<string, { quantity: string; value: string }>;
    closing: { quantity: string; value: string };
  }[];
}

// ---- restaurant (Phase 4, ADR-0014) ----
export interface KitchenStation {
  id: string;
  branchId: string;
  code: string;
  name: string;
  isDefault: boolean;
  archivedAt: string | null;
}
export interface RestaurantTable {
  id: string;
  areaId: string;
  code: string;
  seats: number;
  archivedAt: string | null;
}
export interface DiningArea {
  id: string;
  branchId: string;
  name: string;
  sortOrder: number;
  tables: RestaurantTable[];
}
export interface ModifierOption {
  id: string;
  modifierGroupId: string;
  name: string;
  /** A priced choice sells this item; null = free instruction. */
  variantId: string | null;
}
export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  options: ModifierOption[];
}
export interface MenuVersionRef {
  id: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  createdAt: string;
  publishedAt: string | null;
}
export interface Menu {
  id: string;
  name: string;
  archivedAt: string | null;
  draft: MenuVersionRef | null;
  published: MenuVersionRef | null;
  versions: MenuVersionRef[];
  servedBy: { branchId: string; orderTypes: ('DINE_IN' | 'TAKEAWAY')[] }[];
}
export interface MenuItemEntry {
  id: string;
  variantId: string;
  displayName: string | null;
  stationCode: string | null;
  modifierGroupIds: string[];
  sku: string | null;
  name: string | null;
}
export interface MenuVersion extends MenuVersionRef {
  menuId: string;
  sections: { id: string; name: string; items: MenuItemEntry[] }[];
}
export interface RestaurantSettings {
  branchId: string;
  dineInMenuId: string | null;
  takeawayMenuId: string | null;
  serviceChargeRate: string;
  serviceChargeDineIn: boolean;
  serviceChargeTakeaway: boolean;
  serviceChargeVatTreatment: 'VATABLE' | 'VAT_EXEMPT';
  updatedAt: string | null;
}
export interface SoldOutRow {
  variantId: string;
  sku: string;
  name: string | null;
  note: string | null;
  markedAt: string;
}
export interface RecipeVersion {
  id: string;
  version: number;
  effectiveFrom: string;
  note: string | null;
  state: 'IN_FORCE' | 'SCHEDULED' | 'SUPERSEDED';
  ingredients: { variantId: string; sku: string; name: string; unit: string; quantity: string }[];
}

// ---- restaurant reports (ADR-0014 §10) ----
export interface ReportFigures {
  quantitySold: string;
  quantityReturned: string;
  netQuantity: string;
  netSales: string;
  revenueExVat: string;
  cogs: string;
  grossProfit: string;
  marginPct: string | null;
}
export interface ItemPerformance {
  data: (ReportFigures & {
    variantId: string;
    sku: string;
    name: string;
    checks: number;
    modifiers: (ReportFigures & { variantId: string; sku: string; name: string; checks: number })[];
    withModifiers: { netSales: string; revenueExVat: string; cogs: string; grossProfit: string; marginPct: string | null };
  })[];
  totals: { netSales: string; revenueExVat: string; cogs: string; grossProfit: string; marginPct: string | null };
}
type UsageSide = Record<'recipe' | 'sold' | 'expected' | 'preparedWaste' | 'otherWaste' | 'countVariance' | 'actual' | 'variance', string>;
export interface IngredientUsage {
  data: { variantId: string; sku: string; name: string; unit: string; quantity: UsageSide; value: UsageSide; variancePct: string | null }[];
  totals: { expectedValue: string; wasteValue: string; countVarianceValue: string; actualValue: string; varianceValue: string };
}
export interface KitchenVoids {
  data: {
    orderItemId: string;
    voidedAt: string;
    order: { id: string; orderNumber: number; orderType: string; tableCode: string | null };
    stationCode: string | null;
    name: string;
    quantity: string;
    modifiers: string[];
    reason: string;
    voidedBy: { userId: string; displayName: string | null };
    stage: 'FIRED' | 'IN_PREP' | 'READY' | 'SERVED';
    cookingStarted: boolean;
    wasted: boolean;
    wasteAdjustmentId: string | null;
    wasteValue: string;
  }[];
  byReason: { reason: string; voids: number; cookingStarted: number; wasted: number; wasteValue: string }[];
  byUser: { userId: string; displayName: string | null; voids: number; cookingStarted: number; wasted: number; wasteValue: string }[];
  totals: { voids: number; cookingStarted: number; wasted: number; wasteValue: string };
}
export interface PrepFigures {
  tickets: number;
  items: number;
  voided: number;
  timed: number;
  prepSeconds: { average: number | null; median: number | null; p90: number | null; max: number | null };
  waitSeconds: number | null;
  passSeconds: number | null;
}
export interface PrepTimes {
  stations: (PrepFigures & { stationId: string; code: string; name: string })[];
  overall: PrepFigures | null;
}
export interface OpenOrders {
  day: string;
  asOf: string;
  data: {
    orderId: string;
    orderNumber: number;
    orderType: 'DINE_IN' | 'TAKEAWAY';
    tableCode: string | null;
    customerName: string | null;
    guestCount: number | null;
    openedAt: string;
    openedBy: { userId: string; displayName: string | null };
    status: 'OPEN' | 'BILLED';
    statusNow: string;
    bill: { id: string; billNumber: number; amountDue: string; paid: string; remaining: string } | null;
    items: number;
    notServed: number;
  }[];
  totals: { orders: number; unbilled: number; billed: number; unpaid: string };
}
type ChargeParts = { exVat: string; vat: string; amountDue: string };
export interface ServiceChargeReport {
  days: { day: string; checks: number; returns: number; base: string; charged: ChargeParts; returned: ChargeParts; net: ChargeParts }[];
  totals: { checks: number; returns: number; base: string; charged: ChargeParts; returned: ChargeParts; net: ChargeParts };
  distributable: string;
  ledger: string;
}

// ---- books (Phase 3) ----
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export interface Account {
  id: string;
  legalEntityId: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  archivedAt: string | null;
}
export interface JournalRow {
  id: string;
  entryNumber: number;
  entryDate: string;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  reversesEntryId: string | null;
  total: string;
}
export interface JournalEntry extends Omit<JournalRow, 'total'> {
  legalEntityId: string;
  createdAt: string;
  reversedBy: string | null;
  total: string;
  lines: { id: string; accountId: string; accountCode: string; accountName: string; branchId: string | null; debit: string; credit: string; memo: string | null }[];
}
export interface Period {
  id: string;
  month: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
}
export interface TrialBalance {
  from: string;
  to: string;
  data: { accountId: string; code: string; name: string; type: AccountType; opening: string; debit: string; credit: string; closing: string }[];
  totals: { debit: string; credit: string; closing: string };
}

/** An offline sale a terminal delivered (ADR-0015): recorded, waiting for a manager, or dismissed. */
export interface OfflineSale {
  id: string;
  terminalId: string;
  terminalName: string;
  registerCode: string;
  cashierName: string | null;
  saleNumber: number | null;
  terminalTxnId: string;
  deviceSeq: number;
  status: 'RECORDED' | 'QUARANTINED' | 'DISMISSED';
  cashierSessionId: string | null;
  saleId: string | null;
  errorCode: string | null;
  errorDetail: { message?: string; details?: Record<string, unknown> } | null;
  attempts: number;
  receivedAt: string;
  resolvedAt: string | null;
  resolveReason: string | null;
  localReference: string;
  occurredAt: string;
  amountDue: string;
}
