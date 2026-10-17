import { Global, Module } from '@nestjs/common';
import { DatabasePool } from './database.provider.js';
import { envProvider } from './env.provider.js';
import { ApiMetrics } from './metrics.js';
import { MonitoringService } from './monitoring.service.js';
import { RateLimitStore } from './rate-limit.store.js';
import { TenantDb } from './tenant-db.service.js';

@Global()
@Module({
  providers: [envProvider, ApiMetrics, DatabasePool, TenantDb, RateLimitStore, MonitoringService],
  exports: [envProvider, ApiMetrics, DatabasePool, TenantDb, RateLimitStore, MonitoringService],
})
export class InfrastructureModule {}
