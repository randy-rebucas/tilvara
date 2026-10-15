import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module.js';
import { CashService } from './cash.service.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { StockService } from './stock.service.js';

@Module({
  imports: [TaxModule],
  controllers: [SalesController],
  providers: [CashService, SalesService, StockService],
})
export class SalesModule {}
