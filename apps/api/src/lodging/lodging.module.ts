import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module.js';
import { DepositsService } from './deposits.service.js';
import { FoliosService } from './folios.service.js';
import { LodgingController } from './lodging.controller.js';
import { NightAuditScheduler } from './night-audit.scheduler.js';
import { LodgingSetupService } from './setup.service.js';
import { StaysService } from './stays.service.js';

/** Hotels, resorts and transient houses (ADR-0023). Charge to room at the sale lives in SalesService. */
@Module({
  imports: [TaxModule],
  controllers: [LodgingController],
  providers: [LodgingSetupService, StaysService, DepositsService, FoliosService, NightAuditScheduler],
  exports: [NightAuditScheduler],
})
export class LodgingModule {}
