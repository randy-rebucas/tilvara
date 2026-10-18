import { z } from 'zod';

/** Longest support access a business can give (ADR-0016 slice 6; also a check in the database). */
export const SUPPORT_GRANT_MAX_HOURS = 72;

/** A business gives Tilvara support read-only access for a stated purpose, for 1–72 hours. */
export const createSupportGrantSchema = z.object({
  purpose: z.string().trim().min(5).max(500),
  hours: z.coerce.number().int().min(1).max(SUPPORT_GRANT_MAX_HOURS).default(24),
  /** The support ticket the business was given, if any. */
  ticketRef: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
});
export type CreateSupportGrantInput = z.infer<typeof createSupportGrantSchema>;

export const revokeSupportGrantSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type RevokeSupportGrantInput = z.infer<typeof revokeSupportGrantSchema>;
