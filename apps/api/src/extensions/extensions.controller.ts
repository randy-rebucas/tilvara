import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { extensionCodeSchema } from '@1pos/validation';
import { Auth, RequirePermissions, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { ExtensionsService } from './extensions.service.js';

const code = new ZodPipe(extensionCodeSchema);

/** The extensions this business may switch on, and switching them (ADR-0026). */
@RequirePermissions('tenant.manage')
@Controller('extensions')
export class ExtensionsController {
  constructor(@Inject(ExtensionsService) private readonly extensions: ExtensionsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.extensions.list(auth);
  }

  @Idempotent()
  @HttpCode(200)
  @Post(':code/enable')
  enable(@Auth() auth: AuthContext, @Param('code', code) extension: string) {
    return this.extensions.enable(auth, extension);
  }

  @Idempotent()
  @HttpCode(200)
  @Post(':code/disable')
  disable(@Auth() auth: AuthContext, @Param('code', code) extension: string) {
    return this.extensions.disable(auth, extension);
  }
}
