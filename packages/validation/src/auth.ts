import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

/** Length-based policy (NIST 800-63B style): 12–128 chars, no composition rules. */
export const passwordSchema = z.string().min(12, 'Password must be at least 12 characters').max(128);

export const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use 2–63 lowercase letters, digits or hyphens');

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(200),
  businessName: z.string().trim().min(1).max(200),
  tenantSlug: tenantSlugSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  tenantId: z.uuid().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(32).max(256),
  /** Tenant to activate in the new access token; membership is re-verified server-side. */
  tenantId: z.uuid().optional(),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const switchTenantSchema = z.object({
  tenantId: z.uuid(),
});
export type SwitchTenantInput = z.infer<typeof switchTenantSchema>;

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface MembershipSummary {
  membershipId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
}

export interface AuthResponse {
  user: { id: string; email: string; displayName: string };
  activeTenantId: string | null;
  memberships: MembershipSummary[];
  tokens: TokenPair;
}
