import { z } from 'zod';

/** Offline deliveries a manager reviews (ADR-0015 §5). */
export const offlineListQuerySchema = z.object({
  status: z.enum(['RECORDED', 'QUARANTINED', 'DISMISSED']).optional(),
  terminalId: z.uuid().optional(),
});
export type OfflineListQuery = z.infer<typeof offlineListQuerySchema>;

export const dismissOfflineSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type DismissOfflineInput = z.infer<typeof dismissOfflineSchema>;
