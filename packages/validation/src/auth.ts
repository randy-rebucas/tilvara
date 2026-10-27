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

/**
 * Names a business may not take as its web address, because `<slug>.<shop domain>` is also the
 * business's own address (session 40): Tilvara's own hosts and words people would take for them.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin', 'api', 'app', 'apps', 'assets', 'auth', 'billing', 'blog', 'cdn', 'console', 'dashboard', 'demo', 'dev',
  'docs', 'email', 'ftp', 'help', 'imap', 'internal', 'login', 'mail', 'metrics', 'mx', 'my', 'ns1', 'ns2', 'onepos',
  'pop', 'pos', 'public', 'root', 'security', 'shop', 'shops', 'sign-in', 'sign-up', 'signin', 'signup', 'smtp',
  'staging', 'static', 'status', 'support', 'test', 'tilvara', 'till', 'webhooks', 'webmail', 'www', '1pos',
]);

/**
 * Whether a slug can also be the business's subdomain: a DNS label (no hyphen at the end, no `xn--`-style
 * prefix) that is not reserved. Older slugs that fail keep their `/s/<slug>` page, without a subdomain.
 */
export function isSubdomainSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && slug.length >= 2 && slug.slice(2, 4) !== '--' && !RESERVED_SLUGS.has(slug);
}

/**
 * What the business does (`tenants.business_type`). Retail only for now: GROCERY, SALON, PHARMACY and
 * HYBRID were removed on 2026-10-25 (migration 0112), after RESTAURANT, LODGING and LAUNDRY (0110–0111).
 */
export const BUSINESS_TYPES = ['RETAIL'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const businessTypeSchema = z.enum(BUSINESS_TYPES);

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(200),
  businessName: z.string().trim().min(1).max(200),
  tenantSlug: tenantSlugSchema,
  businessType: businessTypeSchema.default('RETAIL'),
});

/**
 * The business's name (as people see it; receipts print the legal entity's names). The type is no longer
 * changed here: retail is the base and a trade comes as an extension (ADR-0026); other fields are dropped.
 */
export const businessUpdateSchema = z.object({ name: z.string().trim().min(1).max(200) });
export type BusinessUpdateInput = z.infer<typeof businessUpdateSchema>;
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

/** Second sign-in step: a 6-digit code from the authenticator app, or one recovery code. */
export const mfaVerifySchema = z
  .object({
    challengeToken: z.string().min(20).max(2000),
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
    recoveryCode: z.string().trim().min(10).max(20).optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), {
    message: 'Send either a code or a recovery code',
    path: ['code'],
  });
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

/** Starting enrolment re-checks the password, so a stolen access token cannot bind another phone. */
export const mfaEnrollSchema = z.object({ password: z.string().min(1).max(128) });
export type MfaEnrollInput = z.infer<typeof mfaEnrollSchema>;

export const mfaConfirmSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });
export type MfaConfirmInput = z.infer<typeof mfaConfirmSchema>;

export const mfaDisableSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;

/** New recovery codes replace every old one; needs the password and a current code from the app. */
export const mfaRecoveryCodesSchema = mfaDisableSchema;
export type MfaRecoveryCodesInput = MfaDisableInput;

export const passwordResetRequestSchema = z.object({ email: emailSchema });
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(32).max(256),
  password: passwordSchema,
});
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;

// Your own account (privacy pack: correction and erasure by the person) ---------------------
const mfaCodeIfOn = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code').optional();

export const profileUpdateSchema = z.object({ displayName: z.string().trim().min(1).max(200) });
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/**
 * A new sign-in email takes the password and, when two-step sign-in is on, a current code: a stolen
 * session alone cannot move the account to another inbox. The change waits for the link sent there.
 */
export const emailChangeRequestSchema = z.object({
  newEmail: emailSchema,
  password: z.string().min(1).max(128),
  code: mfaCodeIfOn,
});
export type EmailChangeRequestInput = z.infer<typeof emailChangeRequestSchema>;

export const emailChangeConfirmSchema = z.object({ token: z.string().min(32).max(256) });
export type EmailChangeConfirmInput = z.infer<typeof emailChangeConfirmSchema>;

/** Closing your account: the password and, when two-step sign-in is on, a current code. */
export const accountCloseSchema = z.object({
  password: z.string().min(1).max(128),
  code: mfaCodeIfOn,
});
export type AccountCloseInput = z.infer<typeof accountCloseSchema>;

/** Login answer for an account with two-step sign-in: no session yet, only a 5-minute challenge. */
export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  challengeExpiresAt: string;
}

export type LoginResponse = AuthResponse | MfaChallenge;

/** What /me says about two-step sign-in. */
export interface MfaStatus {
  enabled: boolean;
  sessionVerified: boolean;
  /** Privileged in the active tenant, so it is (or will be) required. */
  required: boolean;
  /** When it becomes required for a privileged member without it (grace period); null otherwise. */
  dueAt: string | null;
}

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
