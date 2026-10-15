import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import {
  loginSchema,
  refreshSchema,
  signupSchema,
  switchTenantSchema,
  type LoginInput,
  type RefreshInput,
  type SignupInput,
  type SwitchTenantInput,
} from '@1pos/validation';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { Auth, Public, type AuthContext, type AuthedRequest } from './auth-context.js';
import { permissionCodes } from './authorization.js';
import { AuthService, type RequestMeta } from './auth.service.js';

const AUTH_LIMIT = { bucket: 'auth', limit: 20, windowSeconds: 60 };

function meta(req: AuthedRequest): RequestMeta {
  return { userAgent: req.header('user-agent'), correlationId: req.correlationId };
}

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @RateLimit({ bucket: 'signup', limit: 5, windowSeconds: 600 })
  @Post('auth/signup')
  signup(@Body(new ZodPipe(signupSchema)) body: SignupInput, @Req() req: AuthedRequest) {
    return this.auth.signup(body, meta(req));
  }

  @Public()
  @RateLimit(AUTH_LIMIT)
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

  @Get('me')
  async me(@Auth() auth: AuthContext) {
    return {
      userId: auth.userId,
      activeTenant: auth.tenant
        ? {
            tenantId: auth.tenant.tenantId,
            membershipId: auth.tenant.membershipId,
            status: auth.tenant.status,
            permissions: permissionCodes(auth.tenant.grants),
            grants: auth.tenant.grants,
          }
        : null,
      memberships: await this.auth.memberships(auth.userId),
    };
  }
}
