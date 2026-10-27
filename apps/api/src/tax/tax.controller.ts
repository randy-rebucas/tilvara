import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  createTaxProfileSchema,
  idParamSchema,
  taxQuoteSchema,
  type CreateTaxProfileInput,
  type TaxQuoteInput,
} from '@1pos/validation';
import { ApiKeyRequires, Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { TaxService } from './tax.service.js';

const id = new ZodPipe(idParamSchema);

/** Tax profiles (versioned per legal entity), statutory discount schemes and cart quotes (ADR-0008). */
@RequireTenant()
@Controller()
export class TaxController {
  constructor(@Inject(TaxService) private readonly tax: TaxService) {}

  @Get('legal-entities/:id/tax-profiles')
  listProfiles(@Auth() auth: AuthContext, @Param('id', id) legalEntityId: string) {
    return this.tax.listProfiles(auth, legalEntityId);
  }

  @Idempotent()
  @Post('legal-entities/:id/tax-profiles')
  createProfile(@Auth() auth: AuthContext, @Param('id', id) legalEntityId: string, @Body(new ZodPipe(createTaxProfileSchema)) body: CreateTaxProfileInput) {
    return this.tax.createProfile(auth, legalEntityId, body);
  }

  // Every member reads them (the till prices with them); a key needs a scope (#21).
  @ApiKeyRequires('catalog.read')
  @Get('discount-schemes')
  listSchemes(@Auth() auth: AuthContext) {
    return this.tax.listSchemes(auth);
  }

  /** Read-only computation; POST only because carts do not fit in a query string. */
  @HttpCode(200)
  @Post('tax/quote')
  quote(@Auth() auth: AuthContext, @Body(new ZodPipe(taxQuoteSchema)) body: TaxQuoteInput) {
    return this.tax.quote(auth, body);
  }
}
