import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { TaxController } from './tax.controller.js';
import { TaxService } from './tax.service.js';

@Module({
  imports: [CatalogModule],
  controllers: [TaxController],
  providers: [TaxService],
})
export class TaxModule {}
