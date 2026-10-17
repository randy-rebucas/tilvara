import { Module } from '@nestjs/common';
import { AuditLogController, AuditLogService } from '../audit/audit-log.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TeamController, AuditLogController],
  providers: [TeamService, AuditLogService],
})
export class TeamModule {}
