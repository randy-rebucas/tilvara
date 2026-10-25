import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { createRecipeVersionSchema, idParamSchema, type CreateRecipeVersionInput } from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { RecipesService } from './recipes.service.js';

const id = new ZodPipe(idParamSchema);

/** Versioned recipes ("supplies used") of sold items (ADR-0014 §4, ADR-0022 §9). */
@RequireTenant()
@Controller()
export class RecipesController {
  constructor(@Inject(RecipesService) private readonly recipes: RecipesService) {}

  @Get('variants/:id/recipe')
  history(@Auth() auth: AuthContext, @Param('id', id) variantId: string) {
    return this.recipes.history(auth, variantId);
  }

  @Idempotent()
  @Post('variants/:id/recipe')
  create(@Auth() auth: AuthContext, @Param('id', id) variantId: string, @Body(new ZodPipe(createRecipeVersionSchema)) body: CreateRecipeVersionInput) {
    return this.recipes.create(auth, variantId, body);
  }
}
