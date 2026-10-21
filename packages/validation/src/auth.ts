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

/** What the business does; it decides which features its people see (`tenants.business_type`). */
export const BUSINESS_TYPES = ['RETAIL', 'RESTAURANT', 'HYBRID', 'GROCERY', 'SALON', 'LODGING', 'LAUNDRY', 'PHARMACY'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const businessTypeSchema = z.enum(BUSINESS_TYPES);
/**
 * Restaurant service (tables, menus, kitchen) is for these types; RETAIL, GROCERY and SALON leave it out
 * (ADR-0020). A hotel or resort serves tables too: its restaurant, bar and room service (ADR-0023 §1).
 */
export const servesTables = (t: BusinessType): boolean => t === 'RESTAURANT' || t === 'HYBRID' || t === 'LODGING';
/** Appointments, service staff and packages (ADR-0022) are for salons, spas and barber shops, and HYBRID. */
export const servesAppointments = (t: BusinessType): boolean => t === 'SALON' || t === 'HYBRID';
/** Rooms, stays, folios and housekeeping (ADR-0023) are for hotels, resorts and transient houses, and HYBRID. */
export const servesLodging = (t: BusinessType): boolean => t === 'LODGING' || t === 'HYBRID';
/** Job orders, machines, pickup and delivery (ADR-0024) are for laundry shops and laundromats, and HYBRID. */
export const servesLaundry = (t: BusinessType): boolean => t === 'LAUNDRY' || t === 'HYBRID';
/** Prescriptions, the pharmacy roles and books, expired stock blocked by default (ADR-0025) are for pharmacies and drugstores, and HYBRID. */
export const servesPharmacy = (t: BusinessType): boolean => t === 'PHARMACY' || t === 'HYBRID';
/** Prepaid packages (ADR-0022 §6): a salon's services, a laundry's loads (ADR-0024 §10), and HYBRID. */
export const usesPackages = (t: BusinessType): boolean => t === 'SALON' || t === 'LAUNDRY' || t === 'HYBRID';
/** Recipes ("supplies used"): restaurant service, a salon's services (ADR-0022 §9), a laundry's loads (ADR-0024 §11). */
export const usesRecipes = (t: BusinessType): boolean => servesTables(t) || t === 'SALON' || t === 'LAUNDRY';

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(200),
  businessName: z.string().trim().min(1).max(200),
  tenantSlug: tenantSlugSchema,
  /** Omitted by older clients: every feature, as before business types. */
  businessType: businessTypeSchema.default('HYBRID'),
});

/** The business's name (as people see it; receipts print the legal entity's names) and/or its type. */
export const businessUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(200), businessType: businessTypeSchema })
  .partial()
  .refine((v) => v.name !== undefined || v.businessType !== undefined, 'Nothing to update');
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

export const isMfaChallenge = (r: LoginResponse): r is MfaChallenge => 'mfaRequired' in r && r.mfaRequired === true;

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
