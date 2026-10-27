import { Body, Controller, Get, Inject, Param, Put, Res } from '@nestjs/common';
import { brandImageSchema, brandingUpdateSchema, tenantSlugSchema, type BrandImageInput, type BrandingUpdateInput } from '@1pos/validation';
import type { Response } from 'express';
import { Auth, Public, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { imageHeaders } from './branding.js';
import { BrandingService } from './branding.service.js';

/** The business's branding (session 39). Images are sent as base64 JSON (up to 2 MB, `bootstrap.ts`). */
@RequireTenant()
@Controller('business/branding')
export class BrandingController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  @Get()
  get(@Auth() auth: AuthContext) {
    return this.branding.get(auth);
  }

  @Put()
  update(@Auth() auth: AuthContext, @Body(new ZodPipe(brandingUpdateSchema)) body: BrandingUpdateInput) {
    return this.branding.update(auth, body);
  }

  @Put('logo')
  setLogo(@Auth() auth: AuthContext, @Body(new ZodPipe(brandImageSchema)) body: BrandImageInput) {
    return this.branding.setImage(auth, 'LOGO', body);
  }

  @Put('background')
  setBackground(@Auth() auth: AuthContext, @Body(new ZodPipe(brandImageSchema)) body: BrandImageInput) {
    return this.branding.setImage(auth, 'BACKGROUND', body);
  }

  @Get('logo')
  async logo(@Auth() auth: AuthContext, @Res() res: Response): Promise<void> {
    const img = await this.branding.image(auth, 'LOGO');
    res.status(200).set(imageHeaders(img, 'private')).end(img.bytes);
  }

  @Get('background')
  async background(@Auth() auth: AuthContext, @Res() res: Response): Promise<void> {
    const img = await this.branding.image(auth, 'BACKGROUND');
    res.status(200).set(imageHeaders(img, 'private')).end(img.bytes);
  }
}

const slug = new ZodPipe(tenantSlugSchema);
const PUBLIC_LIMIT = { bucket: 'public-shop', limit: 120, windowSeconds: 600 } as const;

/**
 * A shop's public sign-in page (/s/<slug> in the admin): its name and look, before anyone signs in.
 * Only for a business that switched the page on; otherwise 404, as for a slug nobody uses.
 */
@Controller('public/shops')
export class PublicShopController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  @Public()
  @RateLimit(PUBLIC_LIMIT)
  @Get(':slug')
  shop(@Param('slug', slug) s: string) {
    return this.branding.publicShop(s);
  }

  @Public()
  @RateLimit(PUBLIC_LIMIT)
  @Get(':slug/logo')
  async logo(@Param('slug', slug) s: string, @Res() res: Response): Promise<void> {
    const img = await this.branding.publicImage(s, 'LOGO');
    res.status(200).set(imageHeaders(img, 'public')).end(img.bytes);
  }

  @Public()
  @RateLimit(PUBLIC_LIMIT)
  @Get(':slug/background')
  async background(@Param('slug', slug) s: string, @Res() res: Response): Promise<void> {
    const img = await this.branding.publicImage(s, 'BACKGROUND');
    res.status(200).set(imageHeaders(img, 'public')).end(img.bytes);
  }
}
