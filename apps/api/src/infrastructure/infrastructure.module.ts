import { Global, Module } from '@nestjs/common';
import { DatabasePool } from './database.provider.js';
import { envProvider } from './env.provider.js';
import { TenantDb } from './tenant-db.service.js';

@Global()
@Module({
  providers: [envProvider, DatabasePool, TenantDb],
  exports: [envProvider, DatabasePool, TenantDb],
})
export class InfrastructureModule {}
