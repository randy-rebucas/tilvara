/** Shapes returned by the Tilvara API that the counter uses (see docs/api/openapi.json). */
export type BusinessType = 'RETAIL' | 'RESTAURANT' | 'HYBRID' | 'GROCERY' | 'SALON' | 'LODGING' | 'LAUNDRY' | 'PHARMACY';

export interface Me {
  userId: string;
  user: { email: string; displayName: string };
  /** businessType: RETAIL, GROCERY and SALON leave out restaurant service (tables, floor, kitchen display). */
  /** features: what the plan includes (absent from an older API: treated as everything). */
  activeTenant: { tenantId: string; businessType?: BusinessType; features?: string[]; permissions: string[] } | null;
  memberships: { tenantId: string; tenantName: string; tenantSlug: string }[];
}

/**
 * Whether the business serves tables at all (business type); permissions decide who does. The
 * cashier's Tables tab follows the type only: after a plan downgrade, bills already printed must
 * still be paid at the counter (the API allows it on purpose).
 */
export const servesTables = (me: Me) => {
  const type = me.activeTenant?.businessType;
  return type !== 'RETAIL' && type !== 'GROCERY' && type !== 'SALON' && type !== 'LAUNDRY' && type !== 'PHARMACY';
};

/**
 * Appointments, service staff and packages (ADR-0022): a salon, spa or barber shop, or a hybrid
 * business. A missing type counts as HYBRID (the old default), as for `servesTables`.
 */
export const servesAppointments = (me: Me) => {
  const type = me.activeTenant?.businessType;
  return type === undefined || type === 'SALON' || type === 'HYBRID';
};

/**
 * Rooms, stays and folios (ADR-0023): a hotel, resort or transient house, or a hybrid business. A
 * missing type counts as HYBRID, as for `servesAppointments`; the Rooms tab also needs `lodging.read`.
 */
export const servesLodging = (me: Me) => {
  const type = me.activeTenant?.businessType;
  return type === undefined || type === 'LODGING' || type === 'HYBRID';
};

/**
 * Job orders, machines and deliveries (ADR-0024): a laundry shop or laundromat, or a hybrid business. A
 * missing type counts as HYBRID; the Laundry tab also needs `laundry.read` (or `laundry.deliver`, a rider).
 */
export const servesLaundry = (me: Me) => {
  const type = me.activeTenant?.businessType;
  return type === undefined || type === 'LAUNDRY' || type === 'HYBRID';
};

/**
 * Prescriptions, the pharmacist's approval and the medicines part of the guide (ADR-0025): a pharmacy or
 * drugstore, or a hybrid business. Drug details (generic, class badge, equivalents) show for any business.
 */
export const servesPharmacy = (me: Me) => {
  const type = me.activeTenant?.businessType;
  return type === undefined || type === 'PHARMACY' || type === 'HYBRID';
};

/** Restaurant service on the plan as well: the kitchen display and server mode take new work. */
export const restaurantOnPlan = (me: Me) => servesTables(me) && (me.activeTenant?.features?.includes('restaurant') ?? true);

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
  /** A laundry service, add-on or self-service cycle (ADR-0024 §2, §7); null or absent otherwise. */
  laundry?: LaundryInfo | null;
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

/** How a job line counts an item, and the machine a self-service cycle runs on (ADR-0024). */
export interface LaundryInfo {
  unit: 'KG' | 'LOAD' | 'PIECE' | null;
  minQuantity: string | null;
  kgPerLoad: string | null;
  addon: boolean;
  machineKind: MachineKind | null;
  machineMinutes: number | null;
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
  modifiers: { id: string; name: string; variantId: string | null; modifierOptionId?: string | null; quantity: string; status: ItemStatus }[];
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
  /** Order, item discount or comp (not SC/PWD). */
  discount: string;
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
  /** `voided`: a check voided since (audit 2026-10-21); its share is owed again and not in `amountPaid`. */
  checks: { id: string; saleNumber: number; amountDue: string; completedAt: string; voided?: boolean }[];
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
  /** COUNTER (session 25): paid at the counter; `orderNumber` is the call number on the customer's receipt. */
  order: { id: string; orderNumber: number; orderType: 'DINE_IN' | 'TAKEAWAY' | 'COUNTER'; tableCode: string | null; customerName: string | null } | null;
  items: { id: string; name: string; quantity: string; seat: number | null; note: string | null; status: ItemStatus; modifiers: { id: string; name: string; status?: ItemStatus }[] }[];
  /** The order's note for this course when it was fired. */
  courseNote?: string | null;
  /** Kitchen printing (session 25): when a till printed it, and how often. */
  printedAt?: string | null;
  printCount?: number;
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
  /** `promotion`: the promotion that gave the line's `discount` (ADR-0021). */
  /** `staff`: who did it (first name); `packageSession`: a prepaid package's session (ADR-0022). */
  /** `generic` and `lots` (ADR-0025 §3, §5): a medicine's generic label and the batches its sale drew. */
  lines: { name: string; quantity: string; unitPrice: string; amount: string; discount?: string; promotion?: string; staff?: string; packageSession?: boolean; flag: string; generic?: string; lots?: string[] }[];
  /** Non-item charges such as the service charge, each printed on its own line. */
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
  /** Counter service (session 25): the number the kitchen calls, and the name given for pickup. */
  callNumber?: number;
  pickupName?: string;
  /** Charge to room (ADR-0023 §5.1): "Charged to room 204 — Cruz", signed by the guest. */
  roomCharge?: { roomNumber: string; guestSurname: string | null; amount: string; line: string; signatureLine: string };
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

// ------------------------------------------------------------------ lodging (ADR-0023)

export type HousekeepingStatus = 'CLEAN' | 'DIRTY' | 'INSPECTED' | 'OUT_OF_ORDER';
export type StayStatus = 'BOOKED' | 'IN_HOUSE' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW';

/** An in-house guest a sale can be charged to (GET /v1/stays/in-house). `available` null = no limit. */
export interface InHouseGuest {
  stayId: string;
  branchId: string;
  branchName: string;
  roomNumber: string;
  guestName: string | null;
  departureDate: string;
  allowCharges: boolean;
  chargeLimit: string | null;
  charged: string;
  available: string | null;
}

/** One room on the housekeeping board (GET /v1/lodging/housekeeping). */
export interface BoardRoom {
  roomId: string;
  number: string;
  floor: string | null;
  roomType: { id: string; code: string; name: string };
  status: HousekeepingStatus;
  lastChange: { at: string; byName: string | null; note: string | null } | null;
  /** A guest in house holds the room (beside the housekeeping status). */
  occupied: boolean;
  /** The guest in house should have left before today. */
  overstay?: boolean;
  departingToday: boolean;
  arrivingToday: boolean;
}

export interface Housekeeping {
  branchId: string;
  /** The branch's calendar date today. */
  day: string | null;
  data: BoardRoom[];
}

export interface StayGuest {
  id: string;
  fullName: string;
  isPrimary: boolean;
}

/** A stay as GET /v1/stays lists it; GET /v1/stays/:id adds the folio's balance and the deposits held. */
export interface Stay {
  id: string;
  branchId: string;
  roomId: string;
  status: StayStatus;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  customerId: string | null;
  guestName: string | null;
  nightlyRate: string | null;
  allowCharges: boolean;
  chargeLimit: string | null;
  source: string;
  room: { id: string; number: string; floor: string | null } | null;
  roomType: { id: string; code: string; name: string } | null;
  guestDisplayName: string | null;
  guests: StayGuest[];
  folio: { id: string; status: 'OPEN' | 'SETTLED'; balance?: string; charged?: string } | null;
  depositsHeld?: string;
  nightsPosted?: number;
  /** In house after the departure date: check-out moves the departure to today and charges the extra nights. */
  overstay?: boolean;
}

export interface FolioEntry {
  id: string;
  kind: 'ROOM_NIGHT' | 'ACCOMMODATION_TAX' | 'CHARGE' | 'CHARGE_RETURN' | 'DEPOSIT_APPLIED' | 'PAYMENT' | 'ADJUSTMENT' | 'NIGHT_REVERSAL';
  amount: string;
  description: string | null;
  nightDate: string | null;
  createdAt: string;
  saleId?: string | null;
}

export interface Folio {
  id: string;
  status: 'OPEN' | 'SETTLED';
  stayId: string;
  stay: { id: string; status: StayStatus; roomNumber: string; arrivalDate: string; departureDate: string; guestName: string | null };
  balance: string;
  depositsHeld: string;
  entries: FolioEntry[];
  payments: { id: string; method: string; amount: string; tendered: string | null; change: string | null; createdAt: string }[];
  deposits: { id: string; kind: string; method: string | null; amount: string; createdAt: string }[];
}

/** What the guest is shown and signs at check-out ("Guest folio — not an invoice" while invoicing is disabled). */
export interface FolioStatement {
  title: string;
  seller: { registeredName: string; tradeName: string | null; tin: string | null; registeredAddress: string | null };
  branch: { name: string; address: string | null };
  folio: { id: string; status: 'OPEN' | 'SETTLED'; openedAt: string; settledAt: string | null; currency: string };
  stay: { id: string; roomNumber: string; roomType: string; arrivalDate: string; departureDate: string; guestName: string | null };
  lines: { id: string; date: string; kind: FolioEntry['kind']; description: string; amount: string; vatAmount: string | null }[];
  totals: { roomNights: string; accommodationTax: string; charges: string; adjustments: string; deposits: string; payments: string; balance: string };
  signatureLine: string;
}

// ------------------------------------------------------------------ laundry (ADR-0024)

export type MachineKind = 'WASHER' | 'DRYER';
export type JobStatus = 'RECEIVED' | 'WASHING' | 'DRYING' | 'FOLDING' | 'READY' | 'OUT_FOR_DELIVERY' | 'CLAIMED' | 'CANCELLED' | 'DISPOSED';

export interface JobLine {
  id: string;
  variantId: string;
  name: string;
  laundryUnit: 'KG' | 'LOAD' | 'PIECE' | null;
  /** What was weighed or counted; `quantity` is what is billed (at least the service's minimum). */
  measuredQuantity: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  amountDue: string;
  customerPackageId: string | null;
  /** The express or delivery charge the server adds by itself. */
  auto: boolean;
}

export interface JobTrip {
  id: string;
  kind: 'PICKUP' | 'DELIVERY';
  status: 'SCHEDULED' | 'DONE' | 'FAILED' | 'CANCELLED';
  address: string | null;
  contactPhone: string | null;
  contactName: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  riderName: string | null;
  failReason: string | null;
}

/** A job order as the server shows it (lines frozen, money in decimal strings). */
export interface JobOrder {
  id: string;
  branchId: string;
  number: number;
  reference: string;
  claimCode: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerDisplayName: string | null;
  serviceLevel: 'REGULAR' | 'EXPRESS';
  promisedAt: string;
  status: JobStatus;
  weightKg: string | null;
  bagCount: number;
  specialInstructions: string | null;
  conditionNotes: string | null;
  pickupRequested: boolean;
  deliveryRequested: boolean;
  notify: boolean;
  pricedAt: string | null;
  amountDue: string;
  depositHeld: string;
  balance: string;
  overdue: boolean;
  unclaimed: boolean;
  storageDays: number;
  readyAt: string | null;
  saleId: string | null;
  createdAt: string;
  lines: JobLine[];
  items: { id: string; label: string; count: number; note: string | null }[];
  trips: JobTrip[];
}

/** A row of the job list: the header and its money, without lines, items or trips. */
export type JobSummary = Omit<JobOrder, 'lines' | 'items' | 'trips' | 'unclaimed' | 'storageDays'> & { unclaimed?: boolean };

/** The customer's stub and the bag tag (ADR-0024 §4), as the server words them. */
export interface JobTicket {
  stub: {
    business: string; legalName: string; branch: string; branchAddress: string | null; timezone: string;
    reference: string; claimCode: string; receivedAt: string; promisedAt: string; serviceLevel: 'REGULAR' | 'EXPRESS';
    customer: string | null; weightKg: string | null; bagCount: number;
    lines: { name: string; measuredQuantity: string; quantity: string; unit: string | null; unitPrice: string; amountDue: string; packageSession: boolean }[];
    amountDue: string; depositHeld: string; balance: string;
    items: { label: string; count: number; note: string | null }[]; pieces: number;
    specialInstructions: string | null; conditionNotes: string | null; claimPolicy: string | null; notice: string;
  };
  tag: { reference: string; customer: string | null; bagCount: number; serviceLevel: 'REGULAR' | 'EXPRESS'; promisedAt: string; specialInstructions: string | null; pieces: number };
}

export interface BoardMachine {
  id: string;
  kind: MachineKind;
  label: string;
  capacityKg: string | null;
  cycleMinutes: number;
  outOfOrderReason: string | null;
  status: 'FREE' | 'RUNNING' | 'OUT_OF_ORDER';
  current: { runId: string; source: 'SELF_SERVICE' | 'JOB'; jobOrderId: string | null; jobReference: string | null; saleId: string | null; saleNumber: number | null; startedAt: string; endsAt: string; secondsLeft: number } | null;
  nextFreeAt: string | null;
}

export interface MachineBoard {
  branchId: string;
  asOf: string;
  data: BoardMachine[];
}

export interface LaundryTrip {
  id: string;
  jobOrderId: string;
  jobReference: string;
  jobStatus: JobStatus;
  kind: 'PICKUP' | 'DELIVERY';
  status: 'SCHEDULED' | 'DONE' | 'FAILED' | 'CANCELLED';
  customer: string | null;
  address: string | null;
  contactPhone: string | null;
  contactName: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  riderName: string | null;
  notes: string | null;
  bagCount: number;
  amountDue: string;
  balance: string;
}

export interface LaundrySettings {
  regularHours: number;
  expressHours: number;
  expressVariantId: string | null;
  deliveryVariantId: string | null;
  storageFeeVariantId: string | null;
  storageFreeDays: number | null;
  unclaimedDays: number;
}
