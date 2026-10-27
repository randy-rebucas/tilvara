import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessController } from './business.controller.js';
import { BusinessService } from './business.service.js';
import { BrandingController, PublicShopController } from './branding.controller.js';
import { BrandingService } from './branding.service.js';

/** The business's own details and branding (what it offers beyond the retail base is its extensions, ADR-0026). */
@Module({
  imports: [AuthModule],
  controllers: [BusinessController, BrandingController, PublicShopController],
  providers: [BusinessService, BrandingService],
  exports: [BrandingService],
})
export class BusinessModule {}
