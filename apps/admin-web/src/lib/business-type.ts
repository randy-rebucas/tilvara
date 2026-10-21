/**
 * What the business does (`/me` activeTenant.businessType): it decides which features the screens
 * offer. RETAIL, GROCERY and SALON leave out restaurant service (the API refuses its writes too);
 * RESTAURANT leaves out selling by weight; HYBRID shows everything. GROCERY (a sari-sari store,
 * ADR-0020) also shows packs and expiry dates open on the product form. SALON (a salon, spa or barber
 * shop, ADR-0022) takes appointments, has service staff and sells service packages, as does HYBRID.
 * LODGING (a hotel, resort or transient house, ADR-0023) has rooms, stays, folios and housekeeping,
 * as does HYBRID, and serves tables too (a resort's restaurant and bar charge to the room).
 * LAUNDRY (a laundry shop or laundromat, ADR-0024) has job orders, machines and deliveries, as does
 * HYBRID; it sells service packages and uses recipes (supplies used per load), but serves no tables.
 * PHARMACY (a pharmacy or drugstore, ADR-0025) gates like RETAIL (no tables); it records
 * prescriptions, keeps the two books, and by default never sells expired stock, as does HYBRID.
 * In the order the choice lists them.
 */
export const BUSINESS_TYPES = ['RETAIL', 'GROCERY', 'RESTAURANT', 'SALON', 'LODGING', 'LAUNDRY', 'PHARMACY', 'HYBRID'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Tables, menus and the kitchen: not for a retail shop, a sari-sari store (ADR-0020), a salon (ADR-0022), a laundry (ADR-0024) or a pharmacy (ADR-0025). */
export const servesTables = (t: BusinessType | undefined) => t !== 'RETAIL' && t !== 'GROCERY' && t !== 'SALON' && t !== 'LAUNDRY' && t !== 'PHARMACY';

/** Appointments, service staff and service packages (ADR-0022): a salon, spa or barber shop, and HYBRID. */
export const servesAppointments = (t: BusinessType | undefined) => t === 'SALON' || t === 'HYBRID';

/** Rooms, stays, folios and housekeeping (ADR-0023): a hotel, resort or transient house, and HYBRID. */
export const servesLodging = (t: BusinessType | undefined) => t === 'LODGING' || t === 'HYBRID';

/** Job orders, machines and deliveries (ADR-0024): a laundry shop or laundromat, and HYBRID (the type choice comes with the laundry screens). */
export const servesLaundry = (t: BusinessType | undefined) => t === 'LAUNDRY' || t === 'HYBRID';

/** Prescriptions, the prescription and dangerous drugs books, prescription-only classes (ADR-0025): a pharmacy or drugstore, and HYBRID. */
export const servesPharmacy = (t: BusinessType | undefined) => t === 'PHARMACY' || t === 'HYBRID';

/** Recipes ("supplies used" for a salon's services, ADR-0022 §9, or a laundry's loads, ADR-0024 §11): restaurant service, a salon or a laundry. */
export const usesRecipes = (t: BusinessType | undefined) => servesTables(t) || t === 'SALON' || t === 'LAUNDRY';

/** Prepaid service packages (ADR-0022 §6, ADR-0024 §10): a salon, a laundry, and HYBRID. */
export const usesPackages = (t: BusinessType | undefined) => servesAppointments(t) || t === 'LAUNDRY';

/**
 * Restaurant service is offered when the type serves and the plan includes it (`/me`
 * activeTenant.features). `features` left out = the plan is not known here; the type alone decides.
 */
export const hasRestaurant = (t: BusinessType | undefined, features?: readonly string[]) =>
  servesTables(t) && (features === undefined || features.includes('restaurant'));
/** Why restaurant service is off: the type of business, or the plan (null: it is on). */
export const restaurantOffReason = (t: BusinessType | undefined, features?: readonly string[]): 'type' | 'plan' | null =>
  !servesTables(t) ? 'type' : hasRestaurant(t, features) ? null : 'plan';
export const sellsByWeight = (t: BusinessType | undefined) => t !== 'RESTAURANT';
