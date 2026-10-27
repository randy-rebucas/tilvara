import { z } from 'zod';

/** The owner chooses a plan (ADR-0027): a dearer one is billed now, prorated; one costing no more starts at renewal. */
export const choosePlanSchema = z.object({ planCode: z.string().trim().min(1).max(40) });
export type ChoosePlanInput = z.infer<typeof choosePlanSchema>;

/** Stop at the paid-until date (`true`), or keep going (`false`). */
export const cancelSubscriptionSchema = z.object({ cancel: z.boolean() });
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;
