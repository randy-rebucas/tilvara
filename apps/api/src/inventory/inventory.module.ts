import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { LotHoldsService } from './lot-holds.service.js';
import { LotsService } from './lots.service.js';
import { PacksService } from './packs.service.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, ReservationsService, PacksService, LotsService, LotHoldsService],
})
export class InventoryModule {}
