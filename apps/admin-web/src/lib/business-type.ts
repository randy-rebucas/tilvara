/**
 * What the business does (`/me` activeTenant.businessType): it decides which features the screens
 * offer. RETAIL, GROCERY and SALON leave out restaurant service (the API refuses its writes too);
 * RESTAURANT leaves out selling by weight; HYBRID shows everything. GROCERY (a sari-sari store,
 * ADR-0020) also shows packs and expiry dates open on the product form. SALON (a salon, spa or barber
 * shop, ADR-0022) takes appointments, has service staff and sells service packages, as does HYBRID.
 * LODGING (a hotel, resort or transient house, ADR-0023) has rooms, stays, folios and housekeeping,
 * as does HYBRID, and serves tables too (a resort's restaurant and bar charge to the room).
 * In the order the choice lists them.
 */
export const BUSINESS_TYPES = ['RETAIL', 'GROCERY', 'RESTAURANT', 'SALON', 'LODGING', 'HYBRID'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Tables, menus and the kitchen: not for a retail shop, a sari-sari store (ADR-0020) or a salon (ADR-0022). */
export const servesTables = (t: BusinessType | undefined) => t !== 'RETAIL' && t !== 'GROCERY' && t !== 'SALON';

/** Appointments, service staff and service packages (ADR-0022): a salon, spa or barber shop, and HYBRID. */
export const servesAppointments = (t: BusinessType | undefined) => t === 'SALON' || t === 'HYBRID';

/** Rooms, stays, folios and housekeeping (ADR-0023): a hotel, resort or transient house, and HYBRID. */
export const servesLodging = (t: BusinessType | undefined) => t === 'LODGING' || t === 'HYBRID';

/** Recipes ("supplies used" for a salon's services, ADR-0022 §9): restaurant service, or a salon. */
export const usesRecipes = (t: BusinessType | undefined) => servesTables(t) || t === 'SALON';

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
