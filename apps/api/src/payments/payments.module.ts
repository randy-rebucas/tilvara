import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { DevPaymentProvider, PaymentProvider } from './provider.js';

/** PAYMENT_PROVIDER=dev is the only option until PayMongo sandbox keys exist (refused in production). */
@Module({
  controllers: [PaymentsController],
  providers: [DevPaymentProvider, { provide: PaymentProvider, useExisting: DevPaymentProvider }, PaymentsService],
  // A voided sale's card tip is cancelled with the provider (session 25): the same provider instance.
  exports: [PaymentProvider, DevPaymentProvider],
})
export class PaymentsModule {}
