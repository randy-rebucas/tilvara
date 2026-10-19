import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_URL } from './config';
import { ACCESS_COOKIE } from './cookies';

export class ApiError extends Error {
  /**
   * Next.js keeps an existing digest instead of hashing the error, and the error page shows it: with
   * the API's correlation id there, the reference a business reads out is the one in the API's logs.
   */
  readonly digest?: string;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly correlationId?: string,
  ) {
    super(message);
    if (correlationId) this.digest = correlationId;
  }
}

/**
 * Server-component fetch to the Tilvara API with the session's bearer token.
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
    const e = (body as { error?: { code: string; message: string; details?: Record<string, unknown>; correlationId?: string } } | null)?.error;
    // A staff member's support view whose grant ended (ADR-0016 slice 6): back to their own session.
    if (e?.code === 'SUPPORT_ACCESS_ENDED') redirect('/api/support-ended');
    const correlationId = e?.correlationId ?? res.headers.get('x-correlation-id') ?? undefined;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Request failed', e?.details, correlationId);
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

/**
 * Every product (following the API's cursor, 200 a page) for pickers and name lookups, so nothing
 * past the first page goes missing. Null when the person cannot read the catalogue.
 */
export async function allProducts(): Promise<{ data: Product[] } | null> {
  const data: Product[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const r: { data: Product[]; nextCursor: string | null } | null = await apiOrNull(`/products?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    if (!r) return page === 0 ? null : { data };
    data.push(...r.data);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return { data };
}

export interface VariantName {
  id: string;
  productId: string;
  sku: string;
  name: string;
  productName: string;
  trackInventory: boolean;
  archivedAt: string | null;
}

/**
 * "SKU · Name" for the variants a document names, however large the catalogue (no first-200 limit).
 * Empty when the person cannot read the catalogue; callers show "—".
 */
export async function variantNamesById(ids: string[]): Promise<Map<string, VariantName>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, VariantName>();
  for (let i = 0; i < unique.length; i += 200) {
    const page = await apiOrNull<{ data: VariantName[] }>(`/variants?ids=${unique.slice(i, i + 200).join(',')}`);
    for (const v of page?.data ?? []) out.set(v.id, v);
  }
  return out;
}

// ---- response shapes used by the admin (subset of the API) ----
export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  activeTenant: { tenantId: string; membershipId: string; status: string; permissions: string[] } | null;
  memberships: { membershipId: string; tenantId: string; tenantSlug: string; tenantName: string; tenantStatus: string }[];
  mfa: MfaStatus;
  /** Tilvara support staff (ADR-0016 slice 6). */
  staff: boolean;
  /** Set while a staff member views a business under its support grant (read-only). */
  support: { grantId: string; tenantName: string; expiresAt: string } | null;
}
/** Support access a business gave Tilvara (ADR-0016 slice 6). */
export interface SupportGrant {
  id: string;
  purpose: string;
  ticketRef: string | null;
  access: 'READ_ONLY';
  status: 'OPEN' | 'REVOKED' | 'EXPIRED';
  grantedBy: { id: string; name: string | null };
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  activity: { sessions: number; requests: number; refusedWrites: number; lastUsedAt: string | null; staff: string[] };
}
/** An open grant as Tilvara staff see it. */
export interface StaffGrant {
  id: string;
  tenant: { id: string; name: string; slug: string };
  purpose: string;
  ticketRef: string | null;
  grantedAt: string;
  expiresAt: string;
}
/** A copy of the business's records (ADR-0016 slice 6). */
export interface DataExport {
  id: string;
  status: 'REQUESTED' | 'READY' | 'FAILED' | 'EXPIRED';
  requestedBy: { id: string; name: string | null };
  requestedAt: string;
  completedAt: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  totalRows: number | null;
  expiresAt: string | null;
  error: string | null;
}
export interface SampleData {
  loaded: number;
  canLoad: boolean;
  reason: 'SAMPLE_DATA_LOADED' | 'NOT_TRIAL' | 'HAS_SALES' | null;
  items: number;
}
/** Two-step sign-in (ADR-0016): required for privileged members, after a grace period. */
export interface MfaStatus {
  enabled: boolean;
  sessionVerified: boolean;
  required: boolean;
  dueAt: string | null;
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
  uomId?: string;
  /** One of the trial's sample items (ADR-0016 slice 6). */
  isSample?: boolean;
  archivedAt: string | null;
  variants: { id: string; sku: string; name: string | null; barcodes: string[]; archivedAt: string | null }[];
}
/** One product as GET /products/:id returns it (the editor's view). */
export interface ProductDetail extends Omit<Product, 'variants'> {
  description: string | null;
  taxCategoryId: string;
  uomId: string;
  variants: { id: string; sku: string; name: string | null; referenceCost: string | null; barcodes: string[]; barcodeIds: { id: string; code: string }[]; archivedAt: string | null }[];
}
export interface PriceList {
  id: string;
  name: string;
  currency: string;
  pricesIncludeTax: boolean;
  isDefault: boolean;
  archivedAt: string | null;
  /** Branches assigned this list; a branch with none uses the default list. */
  branchIds: string[];
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
  roles: { roleId: string; roleKey: string; scopeType: string; scopeId: string | null }[];
}
export interface Role {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  archivedAt: string | null;
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
  address?: string | null;
  notes?: string | null;
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
  lines: { id: string; purchaseOrderLineId: string | null; variantId: string; quantity: string; rejectedQuantity: string; returnedQuantity: string; rejectionReason: string | null; unitCost: string; lineValue: string }[];
  returns: { id: string; returnNumber: number; reason: string; createdAt: string }[];
}
// ---- tax profiles (ADR-0008): versioned, effective-dated, never backdated ----
export interface TaxProfile {
  id: string;
  legalEntityId: string;
  effectiveFrom: string;
  vatStatus: 'VAT' | 'NON_VAT';
  vatRate: string;
  percentageTaxRate: string;
  roundingMode: 'HALF_UP' | 'HALF_EVEN';
  note: string | null;
  createdAt: string;
  state: 'IN_FORCE' | 'SCHEDULED' | 'SUPERSEDED';
}

// ---- sales, returns and shifts (admin document pages) ----
type Buckets = { gross: string; discount: string; statutoryDiscount: string; vatExemptionAmount: string; vatableSales: string; vatAmount: string; vatExemptSales: string; zeroRatedSales: string; percentageTaxSales: string };
export interface Sale extends Buckets {
  id: string;
  legalEntityId: string;
  branchId: string;
  registerId: string;
  cashierSessionId: string;
  cashierUserId: string;
  saleNumber: number;
  status: string;
  origin: string;
  offlineReference: string | null;
  orderBillId: string | null;
  amountDue: string;
  amountTendered: string;
  changeDue: string;
  completedAt: string;
  lines: (Buckets & { id: string; lineNo: number; variantId: string; name: string; quantity: string; unitPrice: string; amountDue: string; returnedQuantity: string; parentLineId: string | null })[];
  charges: { id: string; kind: string; rate: string; amountDue: string }[];
  tenders: { id: string; method: string; amount: string; tendered: string; change: string }[];
}
export interface SaleReturnDoc extends Buckets {
  id: string;
  saleId: string;
  cashierSessionId: string;
  kind: 'RETURN' | 'VOID';
  returnNumber: number;
  reason: string;
  processedBy: string;
  amountDue: string;
  refundMethod: string | null;
  createdAt: string;
  lines: { id: string; saleLineId: string; quantity: string; disposition: string; amountDue: string }[];
}
export interface CashierSession {
  id: string;
  branchId: string;
  registerId: string;
  openedBy: string;
  openedAt: string;
  openingFloat: string;
  status: 'OPEN' | 'CLOSED' | 'RECONCILED';
  closedBy: string | null;
  closedAt: string | null;
  expectedCash: string;
  movements: { type: string; total: string; count: number }[];
  payInOut: { id: string; type: 'PAY_IN' | 'PAY_OUT'; amount: string; reason: string | null; createdBy: string; createdAt: string }[];
  sales: { count: number; total: string };
  reconciliation: { expectedCash: string; countedCash: string; variance: string; countedBy: string; note: string | null; approvedBy: string | null; approvedAt: string | null; approvalNote: string | null } | null;
}

export interface SupplierReturn {
  id: string;
  branchId: string;
  supplierId: string;
  goodsReceiptId: string | null;
  returnNumber: number;
  reason: string;
  createdAt: string;
  creditValue: string;
  lines: { id: string; goodsReceiptLineId: string | null; variantId: string; quantity: string; creditUnitCost: string; creditValue: string }[];
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
  lines: { id: string; variantId: string; sku: string; name: string; countedQuantity: string; systemQuantity: string; varianceQuantity: string; varianceValue: string; frozen: boolean }[];
}
export interface CountSheetRow {
  id: string;
  status: 'OPEN' | 'POSTED' | 'CANCELLED';
  blind: boolean;
  notes: string | null;
  frozenAt: string;
  closedAt: string | null;
  stockCountId: string | null;
  lines: number;
  counted: number;
}
export interface CountSheet {
  id: string;
  branchId: string;
  status: CountSheetRow['status'];
  blind: boolean;
  notes: string | null;
  frozenAt: string;
  closedAt: string | null;
  cancelReason: string | null;
  stockCountId: string | null;
  /** False for someone who may only count a blind sheet that is still open. */
  expectedShown: boolean;
  lines: {
    id: string;
    variantId: string;
    sku: string;
    name: string;
    countedQuantity: string | null;
    countedBy: string | null;
    countedAt: string | null;
    expectedQuantity?: string;
    varianceQuantity?: string | null;
    movedSinceFreeze?: string;
  }[];
}
export type NegativeStockPolicy = 'ALLOW' | 'ALLOW_WITH_FLAG' | 'BLOCK';
export interface InventorySettings {
  branchId: string;
  negativeStockPolicy: NegativeStockPolicy;
  lowStockAlerts: boolean;
  updatedAt: string | null;
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
    /** Movements in the range that left the item below zero. */
    belowZero: number;
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
// ---- retail reports (Phase 2 slice 5) ----
export type SaleBuckets = Record<'gross' | 'discount' | 'statutoryDiscount' | 'vatExemptionAmount' | 'vatableSales' | 'vatAmount' | 'vatExemptSales' | 'zeroRatedSales' | 'percentageTaxSales' | 'amountDue', string>;
export interface SalesSummary {
  days: { day: string; salesCount: number; returnsCount: number; voidsCount: number; sales: SaleBuckets; returns: SaleBuckets; net: SaleBuckets }[];
  totals: { salesCount: number; returnsCount: number; sales: SaleBuckets; returns: SaleBuckets; net: SaleBuckets };
}
export interface ByProduct {
  data: { variantId: string; sku: string; name: string; quantitySold: string; quantityReturned: string; netQuantity: string; sales: string; returns: string; netSales: string; revenueExVat: string; cogs: string; grossProfit: string }[];
  charges: { kind: string; charged: string; returned: string; net: string; netExVat: string }[];
}
export interface ByCashier {
  data: { userId: string; displayName: string | null; salesCount: number; sales: string; returnsProcessed: number; returns: string }[];
}
export interface ByTender {
  data: { method: string; tenders: number; collected: string; refundsCount: number; refunded: string; net: string }[];
}
export interface TaxSummary {
  data: (Omit<SaleBuckets, 'gross' | 'discount'> & { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string })[];
}
export interface StatutoryBook {
  data: { document: 'SALE' | 'RETURN'; day: string; number: number; register: string; schemeCode: string; name: string; idNumber: string; tin: string | null; sales: string; discount: string; net: string }[];
}

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
/** Prep times by local hour fired (`hour`) or by menu item (`variantId`, `name`). */
export interface PrepTimesGrouped {
  by: 'hour' | 'item';
  groups: (PrepFigures & { key: string; hour?: number; variantId?: string; name?: string })[];
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
  /** Flags on the recorded sale (ADR-0015 §5): PRICE_CHANGED, SNAPSHOT_EXPIRED, CLOCK_ADJUSTED. */
  flags: string[];
  /** When a recorded sale counts as having happened (the till's time, corrected into the shift). */
  recordedAt: string | null;
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

/** A till's sync health (`GET /v1/sync/terminals`): silent = an open shift and no contact for `silenceMinutes`. */
export interface TillHealth {
  terminalId: string;
  name: string;
  register: { id: string; code: string };
  branchName: string;
  lastContactAt: string | null;
  quarantined: number;
  shiftOpenedAt: string | null;
  silent: boolean;
}
