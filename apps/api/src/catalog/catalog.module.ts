import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { PricingService } from './pricing.service.js';
import { ProductImportService } from './product-import.service.js';
import { PromotionsService } from './promotions.service.js';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, PricingService, PromotionsService, ProductImportService],
  exports: [PricingService],
})
export class CatalogModule {}
