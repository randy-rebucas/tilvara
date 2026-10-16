import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  branchMenuQuerySchema,
  createMenuSchema,
  createModifierGroupSchema,
  createModifierOptionSchema,
  idParamSchema,
  menuContentSchema,
  updateMenuSchema,
  updateModifierGroupSchema,
  type BranchMenuQuery,
  type CreateMenuInput,
  type CreateModifierGroupInput,
  type CreateModifierOptionInput,
  type MenuContentInput,
  type UpdateMenuInput,
  type UpdateModifierGroupInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { MenusService } from './menus.service.js';

const id = new ZodPipe(idParamSchema);

/** Menus, versions and modifiers (ADR-0014 §2, §3). */
@RequireTenant()
@Controller()
export class MenusController {
  constructor(@Inject(MenusService) private readonly menus: MenusService) {}

  @Get('modifier-groups')
  listModifierGroups(@Auth() auth: AuthContext) {
    return this.menus.listModifierGroups(auth);
  }

  @Idempotent()
  @Post('modifier-groups')
  createModifierGroup(@Auth() auth: AuthContext, @Body(new ZodPipe(createModifierGroupSchema)) body: CreateModifierGroupInput) {
    return this.menus.createModifierGroup(auth, body);
  }

  @Patch('modifier-groups/:id')
  updateModifierGroup(@Auth() auth: AuthContext, @Param('id', id) groupId: string, @Body(new ZodPipe(updateModifierGroupSchema)) body: UpdateModifierGroupInput) {
    return this.menus.updateModifierGroup(auth, groupId, body);
  }

  @Idempotent()
  @Post('modifier-groups/:id/options')
  addModifierOption(@Auth() auth: AuthContext, @Param('id', id) groupId: string, @Body(new ZodPipe(createModifierOptionSchema)) body: CreateModifierOptionInput) {
    return this.menus.addModifierOption(auth, groupId, body);
  }

  @HttpCode(200)
  @Post('modifier-groups/:id/archive')
  archiveModifierGroup(@Auth() auth: AuthContext, @Param('id', id) groupId: string) {
    return this.menus.archiveModifierGroup(auth, groupId);
  }

  @HttpCode(200)
  @Post('modifier-options/:id/archive')
  archiveModifierOption(@Auth() auth: AuthContext, @Param('id', id) optionId: string) {
    return this.menus.archiveModifierOption(auth, optionId);
  }

  @Get('menus')
  listMenus(@Auth() auth: AuthContext) {
    return this.menus.listMenus(auth);
  }

  @Idempotent()
  @Post('menus')
  createMenu(@Auth() auth: AuthContext, @Body(new ZodPipe(createMenuSchema)) body: CreateMenuInput) {
    return this.menus.createMenu(auth, body);
  }

  @Get('menus/:id')
  getMenu(@Auth() auth: AuthContext, @Param('id', id) menuId: string) {
    return this.menus.getMenu(auth, menuId);
  }

  @Patch('menus/:id')
  renameMenu(@Auth() auth: AuthContext, @Param('id', id) menuId: string, @Body(new ZodPipe(updateMenuSchema)) body: UpdateMenuInput) {
    return this.menus.renameMenu(auth, menuId, body);
  }

  @HttpCode(200)
  @Post('menus/:id/archive')
  archiveMenu(@Auth() auth: AuthContext, @Param('id', id) menuId: string) {
    return this.menus.archiveMenu(auth, menuId);
  }

  @Idempotent()
  @Post('menus/:id/drafts')
  createDraft(@Auth() auth: AuthContext, @Param('id', id) menuId: string) {
    return this.menus.createDraft(auth, menuId);
  }

  @Get('menu-versions/:id')
  getVersion(@Auth() auth: AuthContext, @Param('id', id) versionId: string) {
    return this.menus.getVersion(auth, versionId);
  }

  @Put('menu-versions/:id/content')
  putContent(@Auth() auth: AuthContext, @Param('id', id) versionId: string, @Body(new ZodPipe(menuContentSchema)) body: MenuContentInput) {
    return this.menus.putContent(auth, versionId, body);
  }

  @HttpCode(200)
  @Post('menu-versions/:id/publish')
  publish(@Auth() auth: AuthContext, @Param('id', id) versionId: string) {
    return this.menus.publish(auth, versionId);
  }

  /** What the POS shows for a branch: published menu, branch prices, sold-out flags, modifiers. */
  @Get('branches/:id/menu')
  branchMenu(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Query(new ZodPipe(branchMenuQuerySchema)) q: BranchMenuQuery) {
    return this.menus.branchMenu(auth, branchId, q);
  }
}
