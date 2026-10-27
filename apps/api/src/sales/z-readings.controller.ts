import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { idParamSchema, zReadingSchema, type ZReadingInput } from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { ZReadingsService } from './z-readings.service.js';

const id = new ZodPipe(idParamSchema);

/** Z-readings per register (session 16; not BIR-accredited). */
@RequireTenant()
@Controller()
export class ZReadingsController {
  constructor(@Inject(ZReadingsService) private readonly readings: ZReadingsService) {}

  // A reading whose answer was lost is sent again with the same key and gets it back, not "already
  // taken" (audit 2026-10-27 #43). Optional, so a client without a key still takes one.
  @Idempotent()
  @Post('registers/:id/z-readings')
  create(@Auth() auth: AuthContext, @Param('id', id) registerId: string, @Body(new ZodPipe(zReadingSchema)) body: ZReadingInput) {
    return this.readings.create(auth, registerId, body.day);
  }

  @Get('registers/:id/z-readings')
  list(@Auth() auth: AuthContext, @Param('id', id) registerId: string) {
    return this.readings.list(auth, registerId);
  }

  @Get('z-readings/:id')
  get(@Auth() auth: AuthContext, @Param('id', id) zId: string) {
    return this.readings.get(auth, zId);
  }
}
