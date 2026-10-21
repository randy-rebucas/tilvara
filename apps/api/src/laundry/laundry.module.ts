import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import { TaxModule } from '../tax/tax.module.js';
import { JobDepositsService } from './deposits.service.js';
import { JobOrdersService } from './job-orders.service.js';
import { LaundryController } from './laundry.controller.js';
import { LaundrySetupService } from './setup.service.js';
import { TripsService } from './trips.service.js';

/** Laundromats and laundry shops (ADR-0024). The claim (a sale) and self-service cycles live in SalesService. */
@Module({
  imports: [TaxModule, SalesModule],
  controllers: [LaundryController],
  providers: [LaundrySetupService, JobOrdersService, JobDepositsService, TripsService],
})
export class LaundryModule {}
