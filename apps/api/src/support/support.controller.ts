import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  createSupportGrantSchema,
  idParamSchema,
  revokeSupportGrantSchema,
  type CreateSupportGrantInput,
  type RevokeSupportGrantInput,
} from '@1pos/validation';
import { AllowReadOnlyBusiness, Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { SupportService } from './support.service.js';

const id = new ZodPipe(idParamSchema);

/** The business's side: give, list and end support access (tenant.manage, checked in the service). */
@RequireTenant()
@Controller('support-access')
export class SupportAccessController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.support.listGrants(auth);
  }

  @AllowReadOnlyBusiness()
  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(createSupportGrantSchema)) body: CreateSupportGrantInput) {
    return this.support.createGrant(auth, body);
  }

  @AllowReadOnlyBusiness()
  @HttpCode(200)
  @Post(':id/revoke')
  revoke(@Auth() auth: AuthContext, @Param('id', id) grantId: string, @Body(new ZodPipe(revokeSupportGrantSchema)) body: RevokeSupportGrantInput) {
    return this.support.revokeGrant(auth, grantId, body.reason);
  }
}

/** 1POS staff's side: no business needed; staff status and two-step sign-in are checked in the service. */
@Controller('support')
export class SupportStaffController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get('grants')
  grants(@Auth() auth: AuthContext) {
    return this.support.openGrants(auth);
  }

  @RateLimit({ bucket: 'support-open', limit: 30, windowSeconds: 600 })
  @HttpCode(200)
  @Post('grants/:id/open')
  open(@Auth() auth: AuthContext, @Param('id', id) grantId: string) {
    return this.support.openGrant(auth, grantId);
  }
}
