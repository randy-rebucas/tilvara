/**
 * What the business does (`/me` activeTenant.businessType): it decides which features the screens
 * offer. RETAIL leaves out restaurant service (the API refuses its writes too); RESTAURANT leaves out
 * selling by weight; HYBRID shows everything.
 */
export const BUSINESS_TYPES = ['RETAIL', 'RESTAURANT', 'HYBRID'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const hasRestaurant = (t: BusinessType | undefined) => t !== 'RETAIL';
export const sellsByWeight = (t: BusinessType | undefined) => t !== 'RESTAURANT';
