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
