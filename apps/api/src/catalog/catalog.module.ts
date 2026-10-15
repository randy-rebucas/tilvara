import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { PricingService } from './pricing.service.js';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, PricingService],
  exports: [PricingService],
})
export class CatalogModule {}
