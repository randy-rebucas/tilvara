/** Shapes returned by the Tilvara API that the counter uses (see docs/api/openapi.json). */
export type BusinessType = 'RETAIL' | 'HYBRID' | 'GROCERY' | 'SALON' | 'PHARMACY';

export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  activeTenant: { tenantId: string; businessType?: BusinessType; permissions: string[] } | null;
  memberships: { tenantId: string; tenantName: string; tenantSlug: string }[];
}

/**
 * Appointments, service staff and packages (ADR-0022): a salon, spa or barber shop, or a hybrid
 * business. A missing type counts as HYBRID (the old default).
 */
export const servesAppointments = (me: Me) => {
  const type = me.activeTenant?.businessType;
  return type === undefined || type === 'SALON' || type === 'HYBRID';
};

/**
 * Prescriptions, the pharmacist's approval and the medicines part of the guide (ADR-0025): a pharmacy or
 * drugstore, or a hybrid business. Drug details (generic, class badge, equivalents) show for any business.
 */
export const servesPharmacy = (me: Me) => {
  const type = me.activeTenant?.businessType;
  return type === undefined || type === 'PHARMACY' || type === 'HYBRID';
};

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
  /** STANDARD, SERVICE or PACKAGE (ADR-0022), when the source gives it (the till's snapshot does). */
  productType?: ProductType;
  /** A medicine (ADR-0025 §3); null or absent for other items. */
  drug?: DrugInfo | null;
  /** An expiry item where expired or held stock may not be sold: what is sellable here now (online only). */
  sellable?: { onHand: string; expiredOrHeld: string; sellable: string };
}

export type DrugClass = 'OTC' | 'RX' | 'ANTIBIOTIC' | 'DANGEROUS';
export type DosageForm = 'TABLET' | 'CAPSULE' | 'SYRUP' | 'SUSPENSION' | 'DROPS' | 'CREAM' | 'OINTMENT' | 'INJECTION' | 'INHALER' | 'SACHET' | 'OTHER';

/** A medicine's details as the lookup, the product list and the snapshot give them. */
export interface DrugInfo {
  drugClass: DrugClass;
  genericName: string;
  strength: string | null;
  dosageForm: string;
  genericKey: string;
  /** Pieces in one unit of the item (a box of 10 strips of 10 is "100"; decimal string); absent = 1 (a piece, or an older server). */
  piecesPerUnit?: string;
}

/** A prescription of the customer's with something left (GET /v1/customers/:id/prescriptions). */
export interface PrescriptionSummary {
  id: string;
  branchId: string;
  customerId: string | null;
  patientName: string;
  prescriberName: string;
  issuedOn: string;
  yellowFormNo: string | null;
  status: 'OPEN' | 'PARTLY_FILLED' | 'FILLED' | 'VOIDED';
  prescribed?: string;
  dispensed?: string;
}

/** One prescription on record (GET /v1/prescriptions/:id), with what is left of each item. */
export interface PrescriptionDetail extends PrescriptionSummary {
  prescriberLicenseNo: string;
  items: { id: string; lineNo: number; genericName: string; strength: string | null; dosageForm: string; drugClass: DrugClass; directions: string | null; quantity: string; dispensed: string; left: string }[];
}

/** Items of the same generic, strength and form (GET /v1/catalog/equivalents). */
export interface Equivalents {
  generic: string | null;
  data: { variantId: string; sku: string; name: string; drugClass: DrugClass | null; unitPrice: string | null; sellable: string | null }[];
}

export type ProductType = 'STANDARD' | 'SERVICE' | 'PACKAGE';

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
  /** ADR-0022: what kind of item it is; a package session (`packageId`) is priced at zero. */
  productType?: ProductType;
  packageId?: string | null;
  staffId?: string | null;
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
  /** TIP (session 25): the charge of a tip, never one of the sale's tenders. */
  purpose?: 'SALE' | 'TIP';
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
  /** `promotion`: the promotion that gave the line's `discount` (ADR-0021). */
  /** `staff`: who did it (first name); `packageSession`: a prepaid package's session (ADR-0022). */
  /** `generic` and `lots` (ADR-0025 §3, §5): a medicine's generic label and the batches its sale drew. */
  lines: { name: string; quantity: string; unitPrice: string; amount: string; discount?: string; promotion?: string; staff?: string; packageSession?: boolean; flag: string; generic?: string; lots?: string[] }[];
  /** A sale made before table service was removed may carry a service charge: its own line, never an item. */
  charges?: { kind: string; label: string; amount: string; flag: string }[];
  totals: Record<string, string>;
  /** `exchangeReturnNumber`: this cash is the refund of that return, put towards the sale (an exchange). */
  tenders: { method: string; amount: string; tendered?: string; change?: string; exchangeReturnNumber?: number }[];
  /** `purchaseBooklet` (ADR-0025 §8): present when the discount covered a medicine. */
  statutory: { label: string; name: string; idNumber: string; discount: string; signatureLine: boolean; purchaseBooklet?: boolean }[];
  legend: string | null;
  /** A return or void slip: why the goods came back. */
  reason?: string;
  /** The customer the sale was rung up for (ADR-0018), with their TIN when they gave one. */
  customer?: { name: string; tin?: string };
  /** A tip given with the sale (session 25): printed after the payment, never in the totals. */
  tip?: { method: string; amount: string };
}

// ------------------------------------------------------------------ salons (ADR-0022)

/** A person who performs services at a branch (need not sign in). No services listed = every service. */
export interface ServiceStaff {
  id: string;
  branchId: string;
  displayName: string;
  color: string | null;
  archivedAt: string | null;
  services: { variantId: string }[];
  /** Weekly hours in the branch's calendar: weekday 0 = Sunday, times 'HH:MM'. */
  hours: { weekday: number; startsAt: string; endsAt: string }[];
}

export type AppointmentStatus = 'BOOKED' | 'ARRIVED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';

export interface Appointment {
  id: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  hasEmail: boolean;
  guestName: string | null;
  notes: string | null;
  remind: boolean;
  saleId: string | null;
  cancelReason: string | null;
  services: { id: string; variantId: string; name: string; staffId: string; staffName: string; staffColor: string | null; startsAt: string; endsAt: string }[];
}

export interface Availability {
  date: string;
  minutes: number;
  staff: { staffId: string; displayName: string; color: string | null; slots: string[] }[];
}

/** A customer's prepaid package with sessions left (GET /v1/customers/:id/packages?open=true). */
export interface CustomerPackage {
  id: string;
  name: string;
  expiresOn: string | null;
  expired: boolean;
  valueLeft: string;
  services: { itemId: string; variantId: string; name: string; sessions: number; sessionsLeft: number }[];
}

export interface CustomerNote {
  id: string;
  body: string;
  pinned: boolean;
  updatedAt: string;
}

/** An appointment handed from the Appointments tab to Sell to be rung up. */
export interface AppointmentRingUp {
  appointment: Appointment;
  /** Changes on every press, so the same appointment can be rung up again after a cleared cart. */
  nonce: string;
}
