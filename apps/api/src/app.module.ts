import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';

@Module({
  imports: [InfrastructureModule, AuthModule, HealthModule],
})
export class AppModule {}
