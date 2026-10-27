import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req } from '@nestjs/common';
import {
  accountCloseSchema,
  emailChangeConfirmSchema,
  emailChangeRequestSchema,
  profileUpdateSchema,
  type AccountCloseInput,
  type EmailChangeConfirmInput,
  type EmailChangeRequestInput,
  type ProfileUpdateInput,
  loginSchema,
  mfaConfirmSchema,
  mfaDisableSchema,
  mfaEnrollSchema,
  mfaRecoveryCodesSchema,
  mfaVerifySchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshSchema,
  signupSchema,
  switchTenantSchema,
  type LoginInput,
  type MfaConfirmInput,
  type MfaDisableInput,
  type MfaEnrollInput,
  type MfaRecoveryCodesInput,
  type MfaVerifyInput,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
  type RefreshInput,
  type SignupInput,
  type SwitchTenantInput,
} from '@1pos/validation';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { AccountSecurityService, mfaStatus } from './account-security.service.js';
import { AccountService } from './account.service.js';
import { Auth, Public, type AuthContext, type AuthedRequest } from './auth-context.js';
import { permissionCodes } from './authorization.js';
import { AuthService, type RequestMeta } from './auth.service.js';

const AUTH_LIMIT = { bucket: 'auth', limit: 20, windowSeconds: 60 };
const MFA_LIMIT = { bucket: 'mfa-setup', limit: 10, windowSeconds: 600 };

function meta(req: AuthedRequest): RequestMeta {
  return { userAgent: req.header('user-agent'), correlationId: req.correlationId };
}

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AccountSecurityService) private readonly security: AccountSecurityService,
    @Inject(AccountService) private readonly account: AccountService,
  ) {}

  @Public()
  @RateLimit({ bucket: 'signup', limit: 5, windowSeconds: 600 })
  @Post('auth/signup')
  signup(@Body(new ZodPipe(signupSchema)) body: SignupInput, @Req() req: AuthedRequest) {
    return this.auth.signup(body, meta(req));
  }

  @Public()
  // Per IP, and per account so a spread-out attack on one person is slowed too (the DB lock still applies).
  @RateLimit(AUTH_LIMIT, { bucket: 'login-account', limit: 10, windowSeconds: 600, by: 'account' })
  @HttpCode(200)
  @Post('auth/login')
  login(@Body(new ZodPipe(loginSchema)) body: LoginInput, @Req() req: AuthedRequest) {
    return this.auth.login(body, meta(req));
  }

  @Public()
  @RateLimit(AUTH_LIMIT)
  @HttpCode(200)
  @Post('auth/refresh')
  refresh(@Body(new ZodPipe(refreshSchema)) body: RefreshInput) {
    return this.auth.refresh(body.refreshToken, body.tenantId);
  }

  @Public()
  @RateLimit(AUTH_LIMIT)
  @HttpCode(200)
  @Post('auth/mfa/verify')
  verifyMfa(@Body(new ZodPipe(mfaVerifySchema)) body: MfaVerifyInput, @Req() req: AuthedRequest) {
    return this.auth.verifyMfa(body, meta(req));
  }

  @Get('auth/mfa')
  mfaStatus(@Auth() auth: AuthContext) {
    return this.security.status(auth);
  }

  @RateLimit(MFA_LIMIT)
  @HttpCode(200)
  @Post('auth/mfa/enroll')
  enrollMfa(@Auth() auth: AuthContext, @Body(new ZodPipe(mfaEnrollSchema)) body: MfaEnrollInput) {
    return this.security.enroll(auth, body.password);
  }

  @RateLimit(MFA_LIMIT)
  @HttpCode(200)
  @Post('auth/mfa/confirm')
  confirmMfa(@Auth() auth: AuthContext, @Body(new ZodPipe(mfaConfirmSchema)) body: MfaConfirmInput) {
    return this.security.confirm(auth, body.code);
  }

  @RateLimit(MFA_LIMIT)
  @HttpCode(204)
  @Post('auth/mfa/disable')
  async disableMfa(@Auth() auth: AuthContext, @Body(new ZodPipe(mfaDisableSchema)) body: MfaDisableInput): Promise<void> {
    await this.security.disable(auth, body.password, body.code);
  }

  @RateLimit(MFA_LIMIT)
  @HttpCode(200)
  @Post('auth/mfa/recovery-codes')
  regenerateRecoveryCodes(@Auth() auth: AuthContext, @Body(new ZodPipe(mfaRecoveryCodesSchema)) body: MfaRecoveryCodesInput) {
    return this.security.regenerateRecoveryCodes(auth, body.password, body.code);
  }

  @Public()
  // Per account as well: nobody can fill a person's inbox with reset mails from many addresses.
  @RateLimit({ bucket: 'password-reset', limit: 5, windowSeconds: 600 }, { bucket: 'password-reset-account', limit: 3, windowSeconds: 3600, by: 'account' })
  @HttpCode(202)
  @Post('auth/password-reset/request')
  async requestPasswordReset(@Body(new ZodPipe(passwordResetRequestSchema)) body: PasswordResetRequestInput, @Req() req: AuthedRequest) {
    await this.security.requestReset(body.email, meta(req));
    return { accepted: true };
  }

  @Public()
  @RateLimit(AUTH_LIMIT)
  @HttpCode(204)
  @Post('auth/password-reset/confirm')
  async confirmPasswordReset(@Body(new ZodPipe(passwordResetConfirmSchema)) body: PasswordResetConfirmInput, @Req() req: AuthedRequest) {
    await this.security.confirmReset(body, meta(req));
  }

  // Your own account (privacy pack): name, sign-in email, closing it. ---------------------------
  @Patch('me')
  updateProfile(@Auth() auth: AuthContext, @Body(new ZodPipe(profileUpdateSchema)) body: ProfileUpdateInput) {
    return this.account.updateProfile(auth, body.displayName);
  }

  @RateLimit(MFA_LIMIT)
  @HttpCode(202)
  @Post('auth/email-change')
  requestEmailChange(@Auth() auth: AuthContext, @Body(new ZodPipe(emailChangeRequestSchema)) body: EmailChangeRequestInput) {
    return this.account.requestEmailChange(auth, body);
  }

  @Public()
  @RateLimit(AUTH_LIMIT)
  @HttpCode(200)
  @Post('auth/email-change/confirm')
  confirmEmailChange(@Body(new ZodPipe(emailChangeConfirmSchema)) body: EmailChangeConfirmInput, @Req() req: AuthedRequest): Promise<{ userId: string }> {
    return this.account.confirmEmailChange(body.token, meta(req));
  }

  @Get('auth/account/closure')
  closureStatus(@Auth() auth: AuthContext) {
    return this.account.closureStatus(auth.userId);
  }

  @RateLimit(MFA_LIMIT)
  @HttpCode(204)
  @Post('auth/account/close')
  async closeAccount(@Auth() auth: AuthContext, @Body(new ZodPipe(accountCloseSchema)) body: AccountCloseInput): Promise<void> {
    await this.account.close(auth, body);
  }

  @HttpCode(204)
  @Post('auth/logout')
  async logout(@Auth() auth: AuthContext): Promise<void> {
    await this.auth.logout(auth);
  }

  @HttpCode(200)
  @Post('auth/switch-tenant')
  switchTenant(@Auth() auth: AuthContext, @Body(new ZodPipe(switchTenantSchema)) body: SwitchTenantInput) {
    return this.auth.switchTenant(auth, body.tenantId);
  }

  /** A one-time sign-in for the business's own address (session 41; `AuthService.handoff`). */
  @HttpCode(200)
  @RateLimit({ bucket: 'auth-handoff', limit: 30, windowSeconds: 600 })
  @Post('auth/handoff')
  handoff(@Auth() auth: AuthContext, @Req() req: AuthedRequest) {
    return this.auth.handoff(auth, meta(req));
  }

  @Get('me')
  async me(@Auth() auth: AuthContext) {
    const business = auth.tenant ? await this.auth.tenantProfile(auth.tenant.tenantId, auth) : null;
    return {
      userId: auth.userId,
      user: await this.auth.profile(auth.userId),
      activeTenant: auth.tenant
        ? {
            tenantId: auth.tenant.tenantId,
            membershipId: auth.tenant.membershipId,
            status: auth.tenant.status,
            // The business type (RETAIL only since 0112; kept so the screens and older tills read it as before).
            businessType: business!.businessType,
            // What the plan includes (multi_entity, api_access, advanced_reports): the screens
            // hide the rest, which the server refuses anyway (`assertFeature`).
            features: business!.features,
            // Usable extensions (ADR-0026: on, and allowed by the plan): the screens show their areas;
            // the server refuses their writes when off (`@RequiresExtension`, `assertExtension`).
            extensions: business!.extensions,
            // Whether the subscription lets the business make changes (as `GET /subscription` → access), for
            // every member: the screens say why a save is refused. A suspended business is `status` SUSPENDED.
            access: business!.access,
            // The business's look (session 39): the band and the till; images from /business/branding/logo|background?v=<sha256>.
            branding: business!.branding,
            permissions: permissionCodes(auth.tenant.grants),
            grants: auth.tenant.grants,
          }
        : null,
      memberships: await this.auth.memberships(auth.userId),
      mfa: mfaStatus(auth),
      // Tilvara support staff (ADR-0016 slice 6): whether this account may use support grants, and the
      // support session this token is, if any (read-only, until expiresAt at the latest).
      staff: await this.auth.isStaff(auth.userId),
      support: auth.support
        ? { grantId: auth.support.grantId, tenantName: business!.name, expiresAt: auth.support.expiresAt.toISOString() }
        : null,
    };
  }
}
