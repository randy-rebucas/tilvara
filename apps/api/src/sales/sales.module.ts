import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { TaxModule } from '../tax/tax.module.js';
import { CashService } from './cash.service.js';
import { CounterService } from './counter.service.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { StockService } from './stock.service.js';
import { ReturnsService } from './returns.service.js';
import { ZReadingsController } from './z-readings.controller.js';
import { ZReadingsService } from './z-readings.service.js';

@Module({
  imports: [TaxModule, CatalogModule, AuthModule],
  controllers: [SalesController, ZReadingsController],
  providers: [CashService, CounterService, SalesService, StockService, ReturnsService, ZReadingsService],
  exports: [SalesService],
})
export class SalesModule {}
