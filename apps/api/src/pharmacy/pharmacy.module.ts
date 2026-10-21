import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { BatchesService } from './batches.service.js';
import { PharmacyBooksService } from './books.service.js';
import { PharmacyController } from './pharmacy.controller.js';
import { PrescriptionsService } from './prescriptions.service.js';

/** Pharmacies and drugstores (ADR-0025). Dispensing (prescription fills, the expired-stock rule) lives in SalesService. */
@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [PharmacyController],
  providers: [PrescriptionsService, BatchesService, PharmacyBooksService],
})
export class PharmacyModule {}
