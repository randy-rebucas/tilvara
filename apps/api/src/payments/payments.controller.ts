import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { createPaymentIntentSchema, idParamSchema, type CreatePaymentIntentInput } from '@1pos/validation';
import { z } from 'zod';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';

const id = new ZodPipe(idParamSchema);
const sessionQuery = new ZodPipe(z.object({ cashierSessionId: z.uuid() }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Non-cash payments (ADR-0010). */
@RequireTenant()
@Controller('payment-intents')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  /**
   * Requires an Idempotency-Key header. It is stored on the intent itself: a retry returns the
   * intent in its current state and never authorizes twice (not the generic replay cache).
   */
  @Post()
  create(@Auth() auth: AuthContext, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(createPaymentIntentSchema)) body: CreatePaymentIntentInput) {
    if (!key) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'This operation requires an Idempotency-Key header', HttpStatus.BAD_REQUEST);
    if (!UUID.test(key)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must be a UUID', HttpStatus.BAD_REQUEST);
    return this.payments.create(auth, body, key.toLowerCase());
  }

  @Get()
  list(@Auth() auth: AuthContext, @Query(sessionQuery) q: { cashierSessionId: string }) {
    return this.payments.list(auth, q.cashierSessionId);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id', id) intentId: string) {
    return this.payments.get(auth, intentId);
  }

  @HttpCode(200)
  @Post(':id/reconcile')
  reconcile(@Auth() auth: AuthContext, @Param('id', id) intentId: string) {
    return this.payments.reconcile(auth, intentId);
  }

  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@Auth() auth: AuthContext, @Param('id', id) intentId: string) {
    return this.payments.cancel(auth, intentId);
  }
}
