import { Global, Module } from '@nestjs/common';
import { DatabasePool } from './database.provider.js';
import { envProvider } from './env.provider.js';

@Global()
@Module({
  providers: [envProvider, DatabasePool],
  exports: [envProvider, DatabasePool],
})
export class InfrastructureModule {}
