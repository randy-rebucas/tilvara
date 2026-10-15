import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { OrgModule } from './org/org.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { TeamModule } from './team/team.module.js';
import { BillingController } from './billing/billing.controller.js';

@Module({
  imports: [InfrastructureModule, NotificationsModule, AuthModule, HealthModule, OrgModule, CatalogModule, TeamModule],
  controllers: [BillingController],
})
export class AppModule {}
