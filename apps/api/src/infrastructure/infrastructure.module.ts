import { Global, Module } from '@nestjs/common';
import { DatabasePool } from './database.provider.js';
import { envProvider } from './env.provider.js';
import { RateLimitStore } from './rate-limit.store.js';
import { TenantDb } from './tenant-db.service.js';

@Global()
@Module({
  providers: [envProvider, DatabasePool, TenantDb, RateLimitStore],
  exports: [envProvider, DatabasePool, TenantDb, RateLimitStore],
})
export class InfrastructureModule {}
