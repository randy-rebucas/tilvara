import { Module } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { ENV } from '../infrastructure/env.provider.js';
import { BillingController, BillingWebhookController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { BillingProvider, DevBillingProvider, PayMongoBillingProvider } from './provider.js';

/** Subscription billing (ADR-0027). BILLING_PROVIDER=dev is refused in production by @1pos/config. */
@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [
    {
      provide: BillingProvider,
      inject: [ENV],
      useFactory: (env: ServerEnv): BillingProvider =>
        env.BILLING_PROVIDER === 'paymongo' ? new PayMongoBillingProvider(env.PAYMONGO_SECRET_KEY!) : new DevBillingProvider(env.API_PUBLIC_URL),
    },
    BillingService,
  ],
  exports: [BillingProvider],
})
export class BillingModule {}
