import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FloorController } from './floor.controller.js';
import { FloorService } from './floor.service.js';
import { MenusController } from './menus.controller.js';
import { MenusService } from './menus.service.js';
import { RecipesController } from './recipes.controller.js';
import { RecipesService } from './recipes.service.js';

@Module({
  imports: [CatalogModule],
  controllers: [RecipesController, FloorController, MenusController],
  providers: [RecipesService, FloorService, MenusService],
})
export class RestaurantModule {}
