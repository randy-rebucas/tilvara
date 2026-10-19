import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BusinessController } from './business.controller.js';
import { BusinessService } from './business.service.js';

/** The business's own details: its type decides which features its people see. */
@Module({
  imports: [AuthModule],
  controllers: [BusinessController],
  providers: [BusinessService],
})
export class BusinessModule {}
