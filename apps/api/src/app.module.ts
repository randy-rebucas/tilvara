import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { OrgModule } from './org/org.module.js';
import { CatalogModule } from './catalog/catalog.module.js';

@Module({
  imports: [InfrastructureModule, AuthModule, HealthModule, OrgModule, CatalogModule],
})
export class AppModule {}
