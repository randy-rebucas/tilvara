import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module.js';
import { CashService } from './cash.service.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { StockService } from './stock.service.js';
import { ReturnsService } from './returns.service.js';
import { ZReadingsController } from './z-readings.controller.js';
import { ZReadingsService } from './z-readings.service.js';

@Module({
  imports: [TaxModule],
  controllers: [SalesController, ZReadingsController],
  providers: [CashService, SalesService, StockService, ReturnsService, ZReadingsService],
  exports: [SalesService],
})
export class SalesModule {}
