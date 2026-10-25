/**
 * What the business does (`/me` activeTenant.businessType): it decides which features the screens
 * offer. GROCERY (a sari-sari store, ADR-0020) shows packs and expiry dates open on the product form.
 * SALON (a salon, spa or barber shop, ADR-0022) takes appointments, has service staff and sells
 * service packages, as does HYBRID. PHARMACY (a pharmacy or drugstore, ADR-0025) records
 * prescriptions, keeps the two books, and by default never sells expired stock, as does HYBRID.
 * In the order the choice lists them.
 */
export const BUSINESS_TYPES = ['RETAIL', 'GROCERY', 'SALON', 'PHARMACY', 'HYBRID'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Appointments, service staff and service packages (ADR-0022): a salon, spa or barber shop, and HYBRID. */
export const servesAppointments = (t: BusinessType | undefined) => t === 'SALON' || t === 'HYBRID';

/** Prescriptions, the prescription and dangerous drugs books, prescription-only classes (ADR-0025): a pharmacy or drugstore, and HYBRID. */
export const servesPharmacy = (t: BusinessType | undefined) => t === 'PHARMACY' || t === 'HYBRID';

/** Recipes: "supplies used" for a salon's services (ADR-0022 §9), and HYBRID. */
export const usesRecipes = (t: BusinessType | undefined) => servesAppointments(t);

/** Prepaid service packages (ADR-0022 §6): a salon, and HYBRID. */
export const usesPackages = (t: BusinessType | undefined) => servesAppointments(t);
