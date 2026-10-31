import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_URL } from './config';
import { ACCESS_COOKIE } from './cookies';
import { visitorHeaders } from './visitor';

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
 * 401 → sign-in (clearing the session's cookies); other errors throw ApiError for the page to render as a state.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) redirect('/sign-in');
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...visitorHeaders(await headers()), authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    cache: 'no-store',
  });
  // Through a route that can clear the refused cookies (a server component cannot).
  if (res.status === 401) redirect('/api/session-ended');
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
export interface Business {
  id: string;
  slug: string;
  name: string;
}

/** The business's look as /me carries it; the images by hash (`brandImageUrl`). */
export interface MeBranding {
  displayName: string | null;
  brandColor: string | null;
  logoSha256: string | null;
  backgroundSha256: string | null;
}

export interface BrandImage {
  sha256: string;
  contentType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/** `GET /business/branding` (session 39). */
export interface Branding {
  displayName: string | null;
  brandColor: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  facebook: string | null;
  instagram: string | null;
  displayWelcome: string | null;
  displayThanks: string | null;
  publicSignIn: boolean;
  logo: BrandImage | null;
  background: BrandImage | null;
  updatedAt: string | null;
}

/** `GET /public/shops/:slug`: what a shop's public sign-in page shows. */
export interface PublicShop {
  tenantId: string;
  name: string;
  brandColor: string | null;
  logoSha256: string | null;
  backgroundSha256: string | null;
}

export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  /**
   * `features`: what the plan includes (multi_entity, api_access, advanced_reports).
   * Absent from an API older than session 22: treat as "not known" (show everything; the API still refuses).
   */
  activeTenant: {
    tenantId: string;
    membershipId: string;
    status: string;
    features?: string[];
    /** Usable extensions (ADR-0026); absent from older APIs. */
    extensions?: string[];
    /** The business's look (session 39); absent from older APIs (Tilvara's own). */
    branding?: MeBranding;
    /** Whether the subscription lets the business make changes; absent from older APIs. */
    access?: 'FULL' | 'READ_ONLY';
    permissions: string[];
  } | null;
  memberships: { membershipId: string; tenantId: string; tenantSlug: string; tenantName: string; tenantStatus: string }[];
  mfa: MfaStatus;
  /** Tilvara support staff (ADR-0016 slice 6). */
  staff: boolean;
  /** Set while a staff member views a business under its support grant (read-only). */
  support: { grantId: string; tenantName: string; expiresAt: string } | null;
}
/** Support access a business gave Tilvara (ADR-0016 slice 6). */
/** An extension as this business sees it (ADR-0026; `GET /extensions`). */
export interface Extension {
  code: string;
  name: string;
  description: string;
  enabled: boolean;
  allowedByPlan: boolean;
  /** On, active and on the plan: what `/me` lists. */
  usable: boolean;
  requires: string[];
  /** Extensions it requires that are off. */
  missing: string[];
}

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
  /** This person may load the set now (trial, no sales, none loaded, catalog.manage and prices.manage). */
  canLoad: boolean;
  /** Sample items are on the list and this person may remove them (catalog.manage). */
  canRemove: boolean;
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
  registeredAddress: string | null;
  rdoCode: string | null;
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
  /** `extensions`: the codes a business on this plan may switch on (ADR-0026). */
  plan: { code: string; name: string; limits: Record<string, number>; features: string[]; extensions: string[]; monthlyPrice?: string; currency?: string };
  status: string;
  access: 'FULL' | 'READ_ONLY';
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  usage: Record<string, number>;
  /** ADR-0027: a plan costing no more, starting at the next renewal; and a stop asked for at the period end. */
  scheduledPlan?: { code: string; name: string } | null;
  cancelAtPeriodEnd?: boolean;
  /** The open bill to pay next (not an upgrade the owner just asked for). */
  openBill?: { id: string; number: string; amount: string; currency: string; dueAt: string } | null;
}
/** A plan on offer (GET /subscription/plans, ADR-0027). */
export interface PlanOffer {
  code: string;
  name: string;
  monthlyPrice: string;
  currency: string;
  limits: Record<string, number>;
  features: string[];
  current: boolean;
  /** Plans priced 0 are never billed (prices not set yet). */
  priced: boolean;
  /** Limits the business already exceeds on that plan. */
  overLimits: string[];
}
/** What the business owes Tilvara for a period (GET /subscription/bills). */
export interface Bill {
  id: string;
  number: string;
  kind: 'START' | 'RENEWAL' | 'UPGRADE';
  planCode: string;
  planName: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
  /** The 12% VAT inside `amount`. */
  vatAmount: string;
  currency: string;
  status: 'OPEN' | 'PAID' | 'VOID';
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  voidReason: string | null;
  payments: { amount: string; method: string; reference: string; applied: boolean; receivedAt: string }[];
  /** The system-generated receipt for the payment that settled it. */
  receipt?: { id: string; number: string } | null;
}
/** A system-generated receipt for a subscription payment (GET /subscription/receipts/:id). */
export interface BillingReceipt {
  id: string;
  number: string;
  issuedAt: string;
  seller: { registeredName: string; tradeName: string | null; tin: string | null; address: string | null; vatRegistered: boolean; permitNote: string | null };
  buyer: { businessName: string; registeredName: string | null; tradeName: string | null; tin: string | null; address: string | null };
  description: string;
  amount: string;
  vatableAmount: string;
  vatAmount: string;
  currency: string;
  method: string;
  reference: string;
  billNumber: string;
}
export interface Product {
  id: string;
  name: string;
  productType: string;
  soldBy: string;
  trackInventory: boolean;
  /** Stock comes in with expiry dates (ADR-0020). */
  tracksExpiry?: boolean;
  categoryId: string | null;
  uomId?: string;
  /** One of the trial's sample items (ADR-0016 slice 6). */
  isSample?: boolean;
  archivedAt: string | null;
  variants: { id: string; sku: string; name: string | null; barcodes: string[]; archivedAt: string | null; attributes?: Record<string, string> | null; quickKeyPosition?: number | null }[];
}
/** One product as GET /products/:id returns it (the editor's view). */
export interface ProductDetail extends Omit<Product, 'variants'> {
  description: string | null;
  taxCategoryId: string;
  uomId: string;
  variants: {
    id: string;
    sku: string;
    name: string | null;
    referenceCost: string | null;
    barcodes: string[];
    barcodeIds: { id: string; code: string }[];
    archivedAt: string | null;
    /** Sizes and colours (ADR-0021 §2), e.g. {"Size": "M", "Colour": "Black"}. */
    attributes?: Record<string, string> | null;
    /** Its button on the till's quick keys, 1–48 (ADR-0021 §3). */
    quickKeyPosition?: number | null;
  }[];
}
/** A promotion (ADR-0021 §1): terms never change once made; only the name, or ending it. */
export type PromotionKind = 'MULTI_BUY' | 'BUY_X_GET_Y' | 'QUANTITY_BREAK';
export interface Promotion {
  id: string;
  name: string;
  kind: PromotionKind;
  quantity: number | null;
  price: string | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  getRate: string | null;
  tiers: { minQuantity: string; rate: string }[] | null;
  allBranches: boolean;
  branchIds: string[];
  startsAt: string;
  endsAt: string | null;
  state: 'RUNNING' | 'SCHEDULED' | 'ENDED';
  items: { variantId: string; sku: string; name: string }[];
  createdAt: string;
}
export interface QuickKey {
  position: number;
  variantId: string;
  sku: string;
  name: string;
  price: string | null;
}
/** Where an item sits in a branch (ADR-0021 §5): a label, not stock. */
export interface ItemLocation {
  variantId: string;
  sku: string;
  name: string;
  location: string;
  updatedAt: string;
}
export interface StockByBranch {
  branches: { id: string; code: string; name: string }[];
  data: { variantId: string; sku: string; name: string; total: string; branches: Record<string, { quantity: string; available: string }> }[];
  /** More than 2,000 items: active items first, by SKU. */
  truncated?: boolean;
}
export interface PromotionsReport {
  data: { promotionId: string; name: string; kind: PromotionKind; salesCount: number; netQuantity: string; discount: string; netSales: string }[];
}
export interface ByAttribute {
  attribute: string | null;
  attributes: string[];
  data: { value: string | null; quantitySold: string; quantityReturned: string; netQuantity: string; netSales: string; revenueExVat: string }[];
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
  archivedAt?: string | null;
}
export interface TaxCategory {
  id: string;
  code: string;
  name: string;
  vatTreatment: string;
  archivedAt?: string | null;
}
/** A product category (GET /categories); `parentId` makes the tree. */
export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  isSample?: boolean;
  archivedAt: string | null;
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
/** A customer (ADR-0018). The list carries the summary; one customer adds the rest. */
export interface CustomerSummary {
  id: string;
  code: string | null;
  displayName: string;
  phone: string | null;
  email: string | null;
  tin: string | null;
  marketingConsent: boolean;
  archivedAt: string | null;
  anonymisedAt: string | null;
  createdAt: string;
}
export interface Customer extends CustomerSummary {
  address: string | null;
  notes: string | null;
  marketingConsentAt: string | null;
  updatedAt: string;
  storeCredit: { legalEntityId: string; legalEntityName: string | null; balance: string }[];
  canManage: boolean;
}
export interface CustomerSale {
  id: string;
  saleNumber: number;
  reference: string;
  branchId: string;
  completedAt: string;
  amountDue: string;
}
export interface CreditEntry {
  id: string;
  legalEntityId: string;
  branchId: string;
  kind: 'RETURN' | 'REDEEM';
  amount: string;
  saleId: string | null;
  saleReturnId: string | null;
  createdAt: string;
  /** The person may open the sale or return behind it. */
  canOpen: boolean;
}
/** A supplier's catalog entry for an item (session 20). */
export interface SupplierItem {
  id: string;
  supplierId: string;
  variantId: string;
  supplierSku: string | null;
  supplierItemName: string | null;
  unitCost: string | null;
  preferred: boolean;
  sku: string;
  name: string;
  supplierCode: string;
  supplierName: string;
}
/** Stock set aside at a branch (session 20). */
export interface Reservation {
  id: string;
  branchId: string;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  note: string;
  customerId: string | null;
  status: 'ACTIVE' | 'RELEASED';
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
  createdByName: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
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
    /** What the supplier calls it (their catalog, session 20). */
    supplierSku?: string | null;
    /** The item keeps expiry dates: receiving asks for the date (ADR-0020). */
    tracksExpiry?: boolean;
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
  lines: { id: string; purchaseOrderLineId: string | null; variantId: string; quantity: string; rejectedQuantity: string; returnedQuantity: string; rejectionReason: string | null; unitCost: string; lineValue: string; expiresOn: string | null; lotCode: string | null }[];
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
  /** From the API (GET /sales/:id); readers of a sale need not read the team. */
  cashierName?: string | null;
  saleNumber: number;
  status: string;
  origin: string;
  offlineReference: string | null;
  amountDue: string;
  amountTendered: string;
  changeDue: string;
  completedAt: string;
  lines: (Buckets & {
    id: string;
    lineNo: number;
    variantId: string;
    name: string;
    quantity: string;
    unitPrice: string;
    amountDue: string;
    returnedQuantity: string;
    parentLineId: string | null;
    /** The promotion that priced the line (ADR-0021 §1); its discount is the line's `discount`. */
    promotionId?: string | null;
    promotionName?: string | null;
  })[];
  /** SC/PWD beneficiaries. */
  beneficiaries?: { id: string; schemeCode: string; name: string; idNumber: string; tin: string | null }[];
  /** Service charges of restaurant checks rung before 0111 (none since); the lines and these add up to `amountDue`. */
  charges: { id: string; kind: string; rate: string; amountDue: string }[];
  tenders: { id: string; method: string; amount: string; tendered: string; change: string }[];
  /** The customer it was rung up for (ADR-0018). */
  customerId?: string | null;
}
export interface SaleReturnDoc extends Buckets {
  id: string;
  saleId: string;
  cashierSessionId: string;
  kind: 'RETURN' | 'VOID';
  returnNumber: number;
  reason: string;
  processedBy: string;
  processedByName?: string | null;
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
  /** `SUPPLIER_PAYMENT`: a supplier paid from the drawer (negative) or that cash put back on a void (positive); `supplierPaymentId` names it. */
  payInOut: { id: string; type: 'PAY_IN' | 'PAY_OUT' | 'SUPPLIER_PAYMENT'; amount: string; reason: string | null; supplierPaymentId?: string | null; createdBy: string; createdByName?: string | null; createdAt: string }[];
  sales: { count: number; total: string };
  /** Names travel with the shift (a branch manager may not read /members). */
  openedByName: string | null;
  reconciliation: { expectedCash: string; countedCash: string; variance: string; countedBy: string; countedByName: string | null; countedAt: string; note: string | null; approvedBy: string | null; approvedByName: string | null; approvedAt: string | null; approvalNote: string | null } | null;
}
/** A shift in `/cashier-sessions` (the list): the drawer count without the shift's sales and movements. */
export type CashierSessionRow = Omit<CashierSession, 'movements' | 'payInOut' | 'sales'>;

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

// ---- supplier invoices and payables (ADR-0013 amendment) ----
export type SupplierInvoiceStatus = 'OPEN' | 'PAID' | 'CANCELLED';
export interface SupplierInvoiceRow {
  id: string;
  entryNumber: number;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  branchId: string;
  supplier: { id: string; code: string; name: string };
  totalAmount: string;
  paidAmount: string;
  balance: string;
  status: SupplierInvoiceStatus;
}
export interface SupplierInvoice extends Omit<SupplierInvoiceRow, 'paidAmount' | 'balance'> {
  legalEntityId: string;
  netAmount: string;
  vatAmount: string;
  matchedAmount: string;
  inputVat: string;
  priceVariance: string;
  paidAmount: string;
  balance: string;
  notes: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  receipts: { goodsReceiptId: string; receiptNumber: number; matchedAmount: string; active: boolean }[];
  /** `amount`: what the payment settles of this invoice; `paymentAmount`: the whole payment (it may settle others too). */
  payments: {
    id: string; paymentNumber: number; amount: string; paymentAmount: string; paidOn: string; method: SupplierPaymentMethod; reference: string | null; createdAt: string;
    status: 'RECORDED' | 'VOIDED'; voidedAt: string | null; voidReason: string | null;
  }[];
  creditedAmount: string;
  debitedAmount: string;
  /** Credit and debit notes (session 22). */
  adjustments: SupplierNote[];
}
/** CASH_DRAWER: cash taken from a till's drawer during an open shift (session 36). */
export type SupplierPaymentMethod = 'BANK_TRANSFER' | 'CHECK' | 'OTHER' | 'CASH_DRAWER';
export interface SupplierNote {
  id: string;
  supplierInvoiceId: string;
  legalEntityId: string;
  kind: 'CREDIT' | 'DEBIT';
  entryNumber: number;
  noteNumber: string;
  noteDate: string;
  netAmount: string;
  vatAmount: string;
  totalAmount: string;
  inputVat: string;
  grniCleared: string;
  reason: string;
  createdAt: string;
}
/** One payment to a supplier, over one or more invoices (session 22). */
export interface SupplierPayment {
  id: string;
  legalEntityId: string;
  branchId: string;
  supplier: { id: string; code: string; name: string };
  paymentNumber: number;
  amount: string;
  paidOn: string;
  method: SupplierPaymentMethod;
  reference: string | null;
  createdAt: string;
  status: 'RECORDED' | 'VOIDED';
  voidedAt: string | null;
  voidReason: string | null;
  allocations: { supplierInvoiceId: string; invoiceNumber: string; branchId: string; amount: string }[];
  journalEntryId: string | null;
  reversalEntryId: string | null;
  /** Cash from a drawer: the shift that paid it, and the one that took it back when the payment was voided. */
  paidFromSessionId?: string | null;
  returnedToSessionId?: string | null;
}
export interface UninvoicedReceipt {
  id: string;
  receiptNumber: number;
  supplierInvoiceRef: string | null;
  receivedAt: string;
  uninvoicedAmount: string;
}
type AgingBuckets = { current: string; days1to30: string; days31to60: string; days61to90: string; over90: string; total: string };
export interface PayablesAging {
  legalEntityId: string;
  asOf: string;
  suppliers: (AgingBuckets & { supplier: { id: string; code: string; name: string }; invoices: number })[];
  totals: AgingBuckets;
  ledgerBalance: string;
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
  /** `GET /stock/transfers/:id`: still in transit and this person may receive it at the destination. */
  canReceive?: boolean;
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
    /** Shelf location at the branch (ADR-0021 §5); lines come ordered by it. */
    location?: string | null;
  }[];
}
export type NegativeStockPolicy = 'ALLOW' | 'ALLOW_WITH_FLAG' | 'BLOCK';
export interface InventorySettings {
  branchId: string;
  negativeStockPolicy: NegativeStockPolicy;
  lowStockAlerts: boolean;
  /** Mail about lots expiring within this many days; 0 = off (ADR-0020). */
  expiryAlertDays?: number;
  /** ADR-0025 §4: as set (null = no choice, which allows) and the rule in force. */
  expiredStock?: 'ALLOW' | 'BLOCK' | null;
  expiredStockRule?: 'ALLOW' | 'BLOCK';
  updatedAt: string | null;
}

// ---- packs and pieces, expiry lots (ADR-0020) ----
export interface PackLink {
  id: string;
  pack: { variantId: string; sku: string; name: string };
  piece: { variantId: string; sku: string; name: string };
  piecesPerPack: string;
  autoOpen: boolean;
  archivedAt: string | null;
  createdAt: string;
}
export interface PackOpening {
  id: string;
  branchId: string;
  conversionId: string;
  pack: PackLink['pack'];
  piece: PackLink['piece'];
  packs: string;
  pieces: string;
  saleId: string | null;
  saleNumber: string | null;
  reason: string | null;
  packsValue: string;
  piecesValue: string;
  createdAt: string;
}
export interface StockLot {
  lotId: string;
  variantId: string;
  sku: string;
  name: string;
  expiresOn: string;
  lotCode: string | null;
  quantity: string;
  value: string;
  daysLeft: number;
  /** A hold (recall, advisory) covers the lot (ADR-0025 §5). */
  held?: boolean;
}
/** `GET /stock/in-use`: whether the business uses dated stock (expiry dates, lots, holds) and packs. */
export interface StockInUse {
  expiry: boolean;
  packs: boolean;
}

export interface Expiring {
  withinDays: number;
  data: StockLot[];
  expired: { lots: number; value: string };
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
  data: { variantId: string; sku: string; name: string; quantity: string; avgCost: string; value: string; reserved?: string; available?: string }[];
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

// ---- retail reports (Phase 2 slice 5) ----
export type SaleBuckets = Record<'gross' | 'discount' | 'statutoryDiscount' | 'vatExemptionAmount' | 'vatableSales' | 'vatAmount' | 'vatExemptSales' | 'zeroRatedSales' | 'percentageTaxSales' | 'amountDue', string>;
export interface SalesSummary {
  days: { day: string; salesCount: number; returnsCount: number; voidsCount: number; sales: SaleBuckets; returns: SaleBuckets; net: SaleBuckets }[];
  totals: { salesCount: number; returnsCount: number; sales: SaleBuckets; returns: SaleBuckets; net: SaleBuckets };
}
export interface ByProduct {
  data: { variantId: string; sku: string; name: string; quantitySold: string; quantityReturned: string; netQuantity: string; sales: string; returns: string; netSales: string; revenueExVat: string; cogs: string; grossProfit: string }[];
  /** Service charges of sales before 0111, listed apart so Σ products + Σ charges = the summary. */
  charges: { kind: string; charged: string; returned: string; net: string; netExVat: string }[];
}
export interface ByCashier {
  data: { userId: string; displayName: string | null; salesCount: number; sales: string; returnsProcessed: number; returns: string }[];
}
export interface ByTender {
  data: { method: string; tenders: number; collected: string; refundsCount: number; refunded: string; net: string }[];
}
/** Session 20 reports (SPEC §6.10). */
type Figures = { sales: string; returns: string; netSales: string; revenueExVat: string; cogs: string; grossProfit: string };
export interface ByCategory {
  data: (Figures & { categoryId: string | null; name: string | null; path: string[]; netQuantity: string })[];
  top: (Figures & { categoryId: string | null; name: string | null })[];
  totals: Figures;
}
export interface ByBranch {
  from: string;
  to: string;
  /** `archivedAt`: an archived branch, listed only when it sold or took returns in the range. */
  data: { branchId: string; code: string; name: string; archivedAt: string | null; salesCount: number; sales: string; returnsCount: number; returns: string; netSales: string; vatAmount: string; netExVat: string; discount: string; statutoryDiscount: string }[];
  totals: { salesCount: number; returnsCount: number; sales: string; returns: string; netSales: string; vatAmount: string; netExVat: string; discount: string; statutoryDiscount: string };
}
export interface DiscountsReport {
  data: { saleId: string; lineId: string; reference: string; completedAt: string; name: string; quantity: string; listUnitPrice: string; unitPrice: string; discount: string; priceChange: string; cashierName: string | null; approvedByName: string | null; approvalMethod: 'SELF' | 'CREDENTIALS' | null; priceReason: string | null }[];
  byCashier: { userId: string; displayName: string | null; lines: number; discount: string; priceChange: string }[];
  totals: { lines: number; discount: string; priceChange: string };
}
export interface PurchasesBySupplier {
  data: { supplierId: string; code: string; name: string; receipts: number; received: string; supplierReturns: number; returned: string; netReceived: string; invoices: number; invoiced: string }[];
  totals: { received: string; returned: string; netReceived: string; invoiced: string };
}
export interface PaymentExceptions {
  data: { id: string; method: string; amount: string; status: string; createdAt: string; cashierSessionId: string; shiftStatus: string; registerCode: string; cashierName: string | null; ageSeconds: number; problem: 'NO_ANSWER' | 'WAITING' | 'NOT_IN_A_SALE' }[];
  totals: { count: number; amount: string };
}
export interface TaxSummary {
  data: (Omit<SaleBuckets, 'gross' | 'discount'> & { vatStatus: 'VAT' | 'NON_VAT'; vatRate: string })[];
}
export interface StatutoryBook {
  data: { document: 'SALE' | 'RETURN'; day: string; number: number; register: string; schemeCode: string; name: string; idNumber: string; tin: string | null; sales: string; discount: string; net: string }[];
}

/** A register's Z-reading (session 16; not BIR-accredited). Money as 2-dp strings. */
export interface ZReading {
  id: string;
  registerId: string;
  businessDay: string;
  zNumber: number;
  resetCounter: number;
  firstSaleNumber: number | null;
  lastSaleNumber: number | null;
  salesCount: number;
  gross: string;
  discount: string;
  statutoryDiscount: string;
  vatableSales: string;
  vatAmount: string;
  vatExemptSales: string;
  zeroRatedSales: string;
  salesAmount: string;
  returnsCount: number;
  returnsAmount: string;
  voidsCount: number;
  voidsAmount: string;
  netAmount: string;
  previousGrandTotal: string;
  grandTotal: string;
  tenders: Record<string, string>;
  statutory: Record<string, string>;
  createdAt: string;
  note: string;
}
/** GET /v1/reports/refund-watch (THREAT_MODEL T5). Rates are 4-dp ratio strings; null without sales. */
export interface RefundWatch {
  data: {
    userId: string;
    displayName: string | null;
    salesCount: number;
    sales: string;
    returnsCount: number;
    returns: string;
    voidsCount: number;
    voids: string;
    ownSalesRefunded: number;
    refunded: string;
    refundRate: string | null;
    flags: ('HIGH_RATE' | 'OWN_SALES')[];
  }[];
  branch: { sales: string; refunded: string; refundRate: string | null };
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
  /** Whether a manual journal entry may post to it (audit 2026-10-27 #11). */
  manualAllowed?: boolean;
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
  /** From the envelope as delivered: null when a sale quarantined as unreadable (VALIDATION_FAILED) lacks it. */
  localReference: string | null;
  occurredAt: string | null;
  amountDue: string | null;
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

// ---- lots: holds (recalls) and the batch trace (ADR-0025 §5, every shop) ----
export interface LotHold {
  id: string;
  variantId: string;
  lotCode: string;
  branchId: string | null;
  branchName: string | null;
  reason: string;
  reference: string | null;
  placedBy: string | null;
  placedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  /** Who placed and released it, by name (null for an account that is gone). */
  placedByName?: string | null;
  releasedByName?: string | null;
  sku: string;
  name: string;
}
export interface LotTrace {
  variantId: string;
  lotCode: string;
  /** Whether this person may place a hold at every branch. */
  canHoldEverywhere?: boolean;
  /** More than 5,000 movements: the oldest 5,000 are listed. */
  truncated?: boolean;
  movements: {
    at: string;
    branchId: string;
    branch: string;
    variantId: string;
    sku: string;
    name: string;
    type: string;
    quantity: string;
    expiresOn: string | null;
    sale: { id: string; saleNumber: number; reference: string } | null;
    customer: { id: string; name: string | null } | null;
    goodsReceiptId: string | null;
    supplier: string | null;
    stockAdjustmentId: string | null;
    packOpeningId: string | null;
    stockTransferId: string | null;
    reason: string | null;
  }[];
  onHand: { branchId: string; branch: string; variantId: string; sku: string; name: string; expiresOn: string | null; quantity: string }[];
}
