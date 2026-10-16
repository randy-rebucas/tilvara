import { Module } from '@nestjs/common';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { PurchasingController } from './purchasing.controller.js';
import { ReceivingService } from './receiving.service.js';
import { SuppliersService } from './suppliers.service.js';

@Module({
  controllers: [PurchasingController],
  providers: [SuppliersService, PurchaseOrdersService, ReceivingService],
})
export class PurchasingModule {}
