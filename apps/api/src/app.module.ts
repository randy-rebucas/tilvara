import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';

@Module({
  imports: [InfrastructureModule, HealthModule],
})
export class AppModule {}
