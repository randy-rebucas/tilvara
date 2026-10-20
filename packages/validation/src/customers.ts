import { z } from 'zod';

// ------------------------------------------------------------------ customers (SPEC §6.9, ADR-0018)

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
/** Empty strings from forms mean "none". */
const blankToNull = <T extends z.ZodType>(s: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), s);

export const CONSENT_SOURCES = ['COUNTER', 'ADMIN', 'REQUEST'] as const;

const fields = {
  displayName: z.string().trim().min(1).max(200),
  /** The business's own number or card number. */
  code: blankToNull(z.string().trim().max(40).nullable().optional()),
  phone: blankToNull(z.string().trim().regex(/^[0-9+() -]{5,30}$/, 'Use digits, spaces, +, ( ) or -').nullable().optional()),
  email: blankToNull(z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable().optional()),
  tin: blankToNull(z.string().trim().regex(/^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/, 'TIN is 9 digits, optionally with the branch code').nullable().optional()),
  address: blankToNull(optionalText(500)),
  notes: blankToNull(optionalText(1000)),
};

/**
 * Collect only what the business needs (SPEC §6.9): a name is enough. Marketing consent is its own
 * yes/no, asked separately from the purchase; `consentSource` says how it was given.
 */
export const createCustomerSchema = z.object({
  ...fields,
  marketingConsent: z.boolean().default(false),
  consentSource: z.enum(CONSENT_SOURCES).default('ADMIN'),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

/** A correction of the profile (the customer asked, or a typo). Consent changes go through `consent`. */
export const updateCustomerSchema = z
  .object({ ...fields, displayName: fields.displayName.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customerConsentSchema = z.object({ marketingConsent: z.boolean(), source: z.enum(CONSENT_SOURCES) });
export type CustomerConsentInput = z.infer<typeof customerConsentSchema>;

/** Blank every personal field for good (the customer asked to be forgotten, or their records' time is up). */
export const anonymiseCustomerSchema = z.object({ reason: z.string().trim().min(1).max(200) });
export type AnonymiseCustomerInput = z.infer<typeof anonymiseCustomerSchema>;

export const customerListQuerySchema = z.object({
  /** Name, phone, email or code (contains, case-insensitive). */
  q: z.string().trim().max(100).optional(),
  includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const customerHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});
export type CustomerHistoryQuery = z.infer<typeof customerHistoryQuerySchema>;
