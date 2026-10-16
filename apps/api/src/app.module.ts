import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { OrgModule } from './org/org.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { TeamModule } from './team/team.module.js';
import { TaxModule } from './tax/tax.module.js';
import { SalesModule } from './sales/sales.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { PurchasingModule } from './purchasing/purchasing.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { AccountingModule } from './accounting/accounting.module.js';
import { BillingController } from './billing/billing.controller.js';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './infrastructure/idempotency.js';

@Module({
  imports: [InfrastructureModule, NotificationsModule, AuthModule, HealthModule, OrgModule, CatalogModule, TeamModule, TaxModule, SalesModule, PaymentsModule, ReportsModule, PurchasingModule, InventoryModule, AccountingModule],
  controllers: [BillingController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
})
export class AppModule {}
