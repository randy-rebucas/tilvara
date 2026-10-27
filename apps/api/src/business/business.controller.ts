import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { businessUpdateSchema, type BusinessUpdateInput } from '@1pos/validation';
import { ApiKeyRequires, Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { BusinessService } from './business.service.js';

/** The active business's details; renaming it needs tenant.manage (checked in the service). */
@RequireTenant()
@Controller('business')
export class BusinessController {
  constructor(@Inject(BusinessService) private readonly business: BusinessService) {}

  /** Every member reads it; an API key needs org.read (audit 45 #21). */
  @ApiKeyRequires('org.read')
  @Get()
  get(@Auth() auth: AuthContext) {
    return this.business.get(auth);
  }

  @Patch()
  update(@Auth() auth: AuthContext, @Body(new ZodPipe(businessUpdateSchema)) body: BusinessUpdateInput) {
    return this.business.update(auth, body);
  }
}
