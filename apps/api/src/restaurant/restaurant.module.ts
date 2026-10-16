import { Module } from '@nestjs/common';
import { RecipesController } from './recipes.controller.js';
import { RecipesService } from './recipes.service.js';

@Module({
  controllers: [RecipesController],
  providers: [RecipesService],
})
export class RestaurantModule {}
