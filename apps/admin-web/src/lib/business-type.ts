/**
 * What the business does (`/me` activeTenant.businessType): it decides which features the screens
 * offer. RETAIL leaves out restaurant service (the API refuses its writes too); RESTAURANT leaves out
 * selling by weight; HYBRID shows everything.
 */
export const BUSINESS_TYPES = ['RETAIL', 'RESTAURANT', 'HYBRID'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/**
 * Restaurant service is offered when the type serves and the plan includes it (`/me`
 * activeTenant.features). `features` left out = the plan is not known here; the type alone decides.
 */
export const hasRestaurant = (t: BusinessType | undefined, features?: readonly string[]) =>
  t !== 'RETAIL' && (features === undefined || features.includes('restaurant'));
/** Why restaurant service is off: the type of business, or the plan (null: it is on). */
export const restaurantOffReason = (t: BusinessType | undefined, features?: readonly string[]): 'type' | 'plan' | null =>
  t === 'RETAIL' ? 'type' : hasRestaurant(t, features) ? null : 'plan';
export const sellsByWeight = (t: BusinessType | undefined) => t !== 'RESTAURANT';
