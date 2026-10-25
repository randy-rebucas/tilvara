import { Module } from '@nestjs/common';
import { RecipesController } from './recipes.controller.js';
import { RecipesService } from './recipes.service.js';

/** Versioned recipes ("supplies used") of items made from stocked supplies (ADR-0014 §4, ADR-0022 §9). */
@Module({
  controllers: [RecipesController],
  providers: [RecipesService],
})
export class RecipesModule {}
