import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { TaxModule } from '../tax/tax.module.js';
import { BillsService } from './bills.service.js';
import { FloorController } from './floor.controller.js';
import { FloorService } from './floor.service.js';
import { FloorEvents } from './floor-events.js';
import { KitchenService } from './kitchen.service.js';
import { MenusController } from './menus.controller.js';
import { MenusService } from './menus.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { RecipesController } from './recipes.controller.js';
import { RecipesService } from './recipes.service.js';

@Module({
  imports: [CatalogModule, TaxModule],
  controllers: [RecipesController, FloorController, MenusController, OrdersController],
  providers: [RecipesService, FloorService, MenusService, OrdersService, KitchenService, BillsService, FloorEvents],
})
export class RestaurantModule {}
