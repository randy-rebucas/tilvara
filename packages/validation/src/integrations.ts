import { z } from 'zod';

// ------------------------------------------------------------------ integrations (session 20, SPEC §6.11, ADR-0019)

/** What an API key may read: always GET, always the whole business. */
export const API_KEY_SCOPES = ['org.read', 'catalog.read', 'sales.read', 'inventory.read', 'reports.read', 'customers.read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Events a webhook may listen for (same list as `WEBHOOK_TOPICS` in @1pos/database; a unit test keeps them equal). */
export const WEBHOOK_TOPIC_NAMES = ['sale.completed', 'sale.returned', 'sale.voided', 'stock.low', 'stock.below_zero'] as const;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).refine((s) => new Set(s).size === s.length, 'Each scope once'),
  /** Omitted: until revoked. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

const url = z.string().trim().max(500).pipe(z.url({ protocol: /^https?$/ }));

export const createWebhookSchema = z.object({
  url,
  topics: z.array(z.enum(WEBHOOK_TOPIC_NAMES)).min(1).refine((s) => new Set(s).size === s.length, 'Each event once'),
  description: z.string().trim().max(200).nullable().optional(),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z
  .object({
    url: url.optional(),
    topics: z.array(z.enum(WEBHOOK_TOPIC_NAMES)).min(1).optional(),
    description: z.string().trim().max(200).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
