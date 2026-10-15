import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  createBranchSchema,
  createLegalEntitySchema,
  createRegisterSchema,
  idParamSchema,
  registerTerminalSchema,
  revokeTerminalSchema,
  updateBranchSchema,
  updateLegalEntitySchema,
  updateRegisterSchema,
  type CreateBranchInput,
  type CreateLegalEntityInput,
  type CreateRegisterInput,
  type RegisterTerminalInput,
  type RevokeTerminalInput,
  type UpdateBranchInput,
  type UpdateLegalEntityInput,
  type UpdateRegisterInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { OrgService } from './org.service.js';

const id = new ZodPipe(idParamSchema);

/**
 * Organization structure. Permission checks are scope-aware and happen in the service,
 * because a branch manager may manage their own branch but not others.
 */
@RequireTenant()
@Controller()
export class OrgController {
  constructor(@Inject(OrgService) private readonly org: OrgService) {}

  @Get('legal-entities')
  async listLegalEntities(@Auth() auth: AuthContext) {
    return { data: await this.org.listLegalEntities(auth) };
  }

  @Post('legal-entities')
  createLegalEntity(@Auth() auth: AuthContext, @Body(new ZodPipe(createLegalEntitySchema)) body: CreateLegalEntityInput) {
    return this.org.createLegalEntity(auth, body);
  }

  @Patch('legal-entities/:id')
  updateLegalEntity(
    @Auth() auth: AuthContext,
    @Param('id', id) entityId: string,
    @Body(new ZodPipe(updateLegalEntitySchema)) body: UpdateLegalEntityInput,
  ) {
    return this.org.updateLegalEntity(auth, entityId, body);
  }

  @HttpCode(200)
  @Post('legal-entities/:id/archive')
  archiveLegalEntity(@Auth() auth: AuthContext, @Param('id', id) entityId: string) {
    return this.org.archiveLegalEntity(auth, entityId);
  }

  @Get('branches')
  async listBranches(@Auth() auth: AuthContext) {
    return { data: await this.org.listBranches(auth) };
  }

  @Post('branches')
  createBranch(@Auth() auth: AuthContext, @Body(new ZodPipe(createBranchSchema)) body: CreateBranchInput) {
    return this.org.createBranch(auth, body);
  }

  @Patch('branches/:id')
  updateBranch(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Body(new ZodPipe(updateBranchSchema)) body: UpdateBranchInput) {
    return this.org.updateBranch(auth, branchId, body);
  }

  @HttpCode(200)
  @Post('branches/:id/archive')
  archiveBranch(@Auth() auth: AuthContext, @Param('id', id) branchId: string) {
    return this.org.archiveBranch(auth, branchId);
  }

  @Get('registers')
  async listRegisters(@Auth() auth: AuthContext) {
    return { data: await this.org.listRegisters(auth) };
  }

  @Post('registers')
  createRegister(@Auth() auth: AuthContext, @Body(new ZodPipe(createRegisterSchema)) body: CreateRegisterInput) {
    return this.org.createRegister(auth, body);
  }

  @Patch('registers/:id')
  updateRegister(
    @Auth() auth: AuthContext,
    @Param('id', id) registerId: string,
    @Body(new ZodPipe(updateRegisterSchema)) body: UpdateRegisterInput,
  ) {
    return this.org.updateRegister(auth, registerId, body);
  }

  @HttpCode(200)
  @Post('registers/:id/archive')
  archiveRegister(@Auth() auth: AuthContext, @Param('id', id) registerId: string) {
    return this.org.archiveRegister(auth, registerId);
  }

  @Get('terminals')
  async listTerminals(@Auth() auth: AuthContext) {
    return { data: await this.org.listTerminals(auth) };
  }

  @Post('terminals')
  registerTerminal(@Auth() auth: AuthContext, @Body(new ZodPipe(registerTerminalSchema)) body: RegisterTerminalInput) {
    return this.org.registerTerminal(auth, body);
  }

  @HttpCode(200)
  @Post('terminals/:id/revoke')
  revokeTerminal(@Auth() auth: AuthContext, @Param('id', id) terminalId: string, @Body(new ZodPipe(revokeTerminalSchema)) body: RevokeTerminalInput) {
    return this.org.revokeTerminal(auth, terminalId, body.reason);
  }
}
