import { Module } from '@nestjs/common';
import { PayablesService } from './payables.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { PurchasingController } from './purchasing.controller.js';
import { ReceivingService } from './receiving.service.js';
import { SuppliersService } from './suppliers.service.js';
import { SupplierItemsService } from './supplier-items.service.js';

@Module({
  controllers: [PurchasingController],
  providers: [SuppliersService, PurchaseOrdersService, ReceivingService, PayablesService, SupplierItemsService],
})
export class PurchasingModule {}
