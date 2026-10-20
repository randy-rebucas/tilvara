import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, ReservationsService],
})
export class InventoryModule {}
