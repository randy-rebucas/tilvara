import { z } from 'zod';

/** Accepts "123-456-789", "123 456 789" or "123456789"; a trailing 3/5-digit branch suffix is rejected (use birBranchCode). */
export const tinSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{9}$/, 'TIN must have 9 digits (enter the branch code separately)'));

const orgCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Use up to 20 letters, digits or hyphens');

const ianaTimezone = z
  .string()
  .trim()
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

const name = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const createLegalEntitySchema = z.object({
  registeredName: name,
  tradeName: optionalText(200),
  tin: tinSchema.nullable().optional(),
  vatStatus: z.enum(['VAT', 'NON_VAT']),
  registeredAddress: optionalText(500),
  rdoCode: z.string().trim().regex(/^\d{3}[A-Z]?$/, 'RDO code is 3 digits (optionally a letter)').nullable().optional(),
  priceDisplay: z.enum(['TAX_INCLUSIVE', 'TAX_EXCLUSIVE']).default('TAX_INCLUSIVE'),
  roundingMode: z.enum(['HALF_UP', 'HALF_EVEN']).default('HALF_UP'),
});
export type CreateLegalEntityInput = z.infer<typeof createLegalEntitySchema>;

/** VAT status and rounding are versioned tax profiles (POST /legal-entities/:id/tax-profiles), not editable here. */
export const updateLegalEntitySchema = createLegalEntitySchema
  .omit({ priceDisplay: true, roundingMode: true, vatStatus: true })
  .partial()
  .extend({
    priceDisplay: z.enum(['TAX_INCLUSIVE', 'TAX_EXCLUSIVE']).optional(),
    invoicingMode: z.enum(['DISABLED', 'DEV_SERIES']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateLegalEntityInput = z.infer<typeof updateLegalEntitySchema>;

export const createBranchSchema = z.object({
  legalEntityId: z.uuid(),
  code: orgCode,
  name,
  birBranchCode: z.string().trim().regex(/^\d{5}$/, 'BIR branch code is 5 digits').default('00000'),
  address: optionalText(500),
  timezone: ianaTimezone.default('Asia/Manila'),
});
export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = createBranchSchema
  .pick({ name: true, birBranchCode: true, address: true })
  .partial()
  .extend({ timezone: ianaTimezone.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const createRegisterSchema = z.object({
  branchId: z.uuid(),
  code: orgCode,
  name,
});
export type CreateRegisterInput = z.infer<typeof createRegisterSchema>;

export const updateRegisterSchema = z.object({ name }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateRegisterInput = z.infer<typeof updateRegisterSchema>;

export const registerTerminalSchema = z.object({
  registerId: z.uuid(),
  name,
});
export type RegisterTerminalInput = z.infer<typeof registerTerminalSchema>;

export const revokeTerminalSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});
export type RevokeTerminalInput = z.infer<typeof revokeTerminalSchema>;

export const idParamSchema = z.uuid();
