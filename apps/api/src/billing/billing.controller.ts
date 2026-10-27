import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { cancelSubscriptionSchema, choosePlanSchema, type CancelSubscriptionInput, type ChoosePlanInput } from '@1pos/validation';
import type { Request, Response } from 'express';
import { Auth, Public, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { ENV } from '../infrastructure/env.provider.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { ApiMetrics } from '../infrastructure/metrics.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { BillingService } from './billing.service.js';
import { BillingProvider, DevBillingProvider, parsePayMongoEvent, verifyPayMongoWebhook } from './provider.js';

/**
 * The business's subscription (ADR-0027): its plan, bills and payments. The owner chooses a plan, stops
 * or resumes, and pays a bill on the provider's page; nothing here changes the plan without payment.
 * A lapsed business still reaches these writes (that is how it renews); a suspended one does not.
 */
@RequireTenant()
@Controller('subscription')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Get()
  get(@Auth() auth: AuthContext) {
    return this.billing.summary(auth);
  }

  @Get('plans')
  plans(@Auth() auth: AuthContext) {
    return this.billing.plans(auth);
  }

  @Get('bills')
  async bills(@Auth() auth: AuthContext) {
    return { data: await this.billing.bills(auth) };
  }

  @Get('receipts/:id')
  receipt(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.billing.receipt(auth, id);
  }

  @Put('plan')
  choosePlan(@Auth() auth: AuthContext, @Body(new ZodPipe(choosePlanSchema)) body: ChoosePlanInput) {
    return this.billing.choosePlan(auth, body.planCode);
  }

  @Put('cancel')
  setCancel(@Auth() auth: AuthContext, @Body(new ZodPipe(cancelSubscriptionSchema)) body: CancelSubscriptionInput) {
    return this.billing.setCancel(auth, body.cancel);
  }

  @Post('bills/:id/checkout')
  @HttpCode(HttpStatus.OK)
  checkout(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.billing.checkout(auth, id);
  }
}

type RawRequest = Request & { body: unknown };

/**
 * The payment provider's webhook (PayMongo). The raw body is kept for the signature (`bootstrap.ts`);
 * an unsigned, stale or wrongly signed call is refused before anything is read from it.
 */
@Controller('billing')
export class BillingWebhookController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(BillingProvider) private readonly provider: BillingProvider,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
  ) {}

  @Public()
  @RateLimit({ bucket: 'billing-webhook', limit: 600, windowSeconds: 60 })
  @Post('webhooks/paymongo')
  @HttpCode(HttpStatus.OK)
  async paymongo(@Req() req: RawRequest) {
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    const secret = this.env.PAYMONGO_WEBHOOK_SECRET;
    if (this.provider.code !== 'PAYMONGO' || !secret) throw new AppError('NOT_FOUND', 'Not found', HttpStatus.NOT_FOUND);
    if (!raw || !verifyPayMongoWebhook(req.header('paymongo-signature'), raw, secret, this.env.PAYMONGO_SECRET_KEY)) {
      this.metrics.billing.inc({ provider: 'PAYMONGO', step: 'webhook', outcome: 'bad_signature' });
      throw new AppError('UNAUTHORIZED', 'Signature missing or wrong', HttpStatus.UNAUTHORIZED);
    }
    const event = parsePayMongoEvent(raw);
    if (!event) throw new AppError('VALIDATION_FAILED', 'Not a PayMongo event', HttpStatus.BAD_REQUEST);
    return { received: true, outcome: await this.billing.applyEvent('PAYMONGO', event) };
  }

  /**
   * The dev simulator's payment page (BILLING_PROVIDER=dev only; refused in production by @1pos/config).
   * Like a provider's page, its address is the secret: the id is a query value, not a tenant route.
   */
  @Public()
  @Get('dev-checkout')
  async devPage(@Query('id') id: string, @Res() res: Response): Promise<void> {
    const page = await this.openDevPage(id);
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    // The form posts here and is redirected back to the admin (or the shop's own address): the API's own CSP
    // (form-action 'self') would stop that.
    const admin = new URL(page.successUrl).origin;
    res
      .status(200)
      .set('content-security-policy', `default-src 'none'; form-action 'self' ${admin}; frame-ancestors 'none'`)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Dev checkout ${esc(page.number)}</title>` +
          `<h1>Dev checkout (simulated, no money moves)</h1><p>Bill ${esc(page.number)}: ${esc(page.currency)} ${esc(page.amount)}</p>` +
          `<form method="post" action="/v1/billing/dev-checkout/pay?id=${encodeURIComponent(id)}"><label>Method <select name="method">` +
          ['GCASH', 'CARD', 'MAYA', 'QRPH'].map((m) => `<option>${m}</option>`).join('') +
          `</select></label> <button type="submit" id="dev-pay">Pay</button></form><p><a href="${esc(page.cancelUrl)}">Cancel</a></p>`,
      );
  }

  @Public()
  @Post('dev-checkout/pay')
  async devPay(@Query('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const page = await this.openDevPage(id);
    const method = typeof (req.body as { method?: unknown })?.method === 'string' ? String((req.body as { method: string }).method) : 'GCASH';
    const event = (this.provider as DevBillingProvider).paidEvent(id, ['GCASH', 'CARD', 'MAYA', 'QRPH'].includes(method) ? method : 'GCASH')!;
    await this.billing.applyEvent('DEV', event);
    res.redirect(303, page.successUrl);
  }

  /** Like PayMongo's: a page whose bill was voided or paid since is expired (the worker's job there, audit 45 #3). */
  private async openDevPage(id: string) {
    const page = this.devPageOf(id);
    if (!(await this.billing.devCheckoutOpen(id))) throw new AppError('CHECKOUT_EXPIRED', 'This payment page has expired', HttpStatus.GONE);
    return page;
  }

  private devPageOf(id: string) {
    const page = this.provider instanceof DevBillingProvider && typeof id === 'string' ? this.provider.page(id) : null;
    if (!page) throw new AppError('NOT_FOUND', 'Not found', HttpStatus.NOT_FOUND);
    return page;
  }
}
