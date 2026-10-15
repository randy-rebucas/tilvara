import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import {
  acceptInvitationExistingSchema,
  acceptInvitationSchema,
  createInvitationSchema,
  createRoleSchema,
  idParamSchema,
  setMemberRolesSchema,
  updateRoleSchema,
  type AcceptInvitationExistingInput,
  type AcceptInvitationInput,
  type CreateInvitationInput,
  type CreateRoleInput,
  type SetMemberRolesInput,
  type UpdateRoleInput,
} from '@1pos/validation';
import { Auth, Public, RequireTenant, type AuthContext, type AuthedRequest } from '../auth/auth-context.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { TeamService } from './team.service.js';

const id = new ZodPipe(idParamSchema);

@Controller()
export class TeamController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  // invitations
  @RequireTenant()
  @Post('invitations')
  invite(@Auth() auth: AuthContext, @Body(new ZodPipe(createInvitationSchema)) body: CreateInvitationInput) {
    return this.team.createInvitation(auth, body);
  }

  @RequireTenant()
  @Get('invitations')
  async listInvitations(@Auth() auth: AuthContext) {
    return { data: await this.team.listInvitations(auth) };
  }

  @RequireTenant()
  @HttpCode(200)
  @Post('invitations/:id/revoke')
  revokeInvitation(@Auth() auth: AuthContext, @Param('id', id) invitationId: string) {
    return this.team.revokeInvitation(auth, invitationId);
  }

  @Public()
  @RateLimit({ bucket: 'invite-accept', limit: 10, windowSeconds: 600 })
  @Post('invitations/accept')
  accept(@Body(new ZodPipe(acceptInvitationSchema)) body: AcceptInvitationInput, @Req() req: AuthedRequest) {
    return this.team.acceptAsNewUser(body, { userAgent: req.header('user-agent'), correlationId: req.correlationId });
  }

  @RateLimit({ bucket: 'invite-accept', limit: 10, windowSeconds: 600 })
  @HttpCode(200)
  @Post('invitations/accept-existing')
  acceptExisting(@Auth() auth: AuthContext, @Body(new ZodPipe(acceptInvitationExistingSchema)) body: AcceptInvitationExistingInput) {
    return this.team.acceptAsExistingUser(auth, body.token);
  }

  // members
  @RequireTenant()
  @Put('members/:id/roles')
  setRoles(@Auth() auth: AuthContext, @Param('id', id) membershipId: string, @Body(new ZodPipe(setMemberRolesSchema)) body: SetMemberRolesInput) {
    return this.team.setMemberRoles(auth, membershipId, body);
  }

  @RequireTenant()
  @HttpCode(200)
  @Post('members/:id/suspend')
  suspend(@Auth() auth: AuthContext, @Param('id', id) membershipId: string) {
    return this.team.setMemberStatus(auth, membershipId, 'suspend');
  }

  @RequireTenant()
  @HttpCode(200)
  @Post('members/:id/reactivate')
  reactivate(@Auth() auth: AuthContext, @Param('id', id) membershipId: string) {
    return this.team.setMemberStatus(auth, membershipId, 'reactivate');
  }

  @RequireTenant()
  @HttpCode(200)
  @Post('members/:id/remove')
  remove(@Auth() auth: AuthContext, @Param('id', id) membershipId: string) {
    return this.team.setMemberStatus(auth, membershipId, 'remove');
  }

  // custom roles
  @RequireTenant()
  @Post('roles')
  createRole(@Auth() auth: AuthContext, @Body(new ZodPipe(createRoleSchema)) body: CreateRoleInput) {
    return this.team.createRole(auth, body);
  }

  @RequireTenant()
  @Patch('roles/:id')
  updateRole(@Auth() auth: AuthContext, @Param('id', id) roleId: string, @Body(new ZodPipe(updateRoleSchema)) body: UpdateRoleInput) {
    return this.team.updateRole(auth, roleId, body);
  }

  @RequireTenant()
  @HttpCode(200)
  @Post('roles/:id/archive')
  archiveRole(@Auth() auth: AuthContext, @Param('id', id) roleId: string) {
    return this.team.archiveRole(auth, roleId);
  }
}
