import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { PricingService } from './pricing.service.js';
import { PromotionsService } from './promotions.service.js';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, PricingService, PromotionsService],
  exports: [PricingService],
})
export class CatalogModule {}
