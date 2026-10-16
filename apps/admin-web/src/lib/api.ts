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
