import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  approveVarianceSchema,
  cashierSessionListQuerySchema,
  cashMovementSchema,
  closeCashierSessionSchema,
  createExchangeSchema,
  createHeldCartSchema,
  createPriceOverrideSchema,
  heldCartListQuerySchema,
  resumeHeldCartSchema,
  createSaleReturnSchema,
  createSaleSchema,
  idParamSchema,
  openCashierSessionSchema,
  previewSaleReturnSchema,
  saleListQuerySchema,
  stockAdjustmentSchema,
  stockQuerySchema,
  type ApproveVarianceInput,
  type CashierSessionListQuery,
  type CashMovementInput,
  type CloseCashierSessionInput,
  type CreateExchangeInput,
  type CreateHeldCartInput,
  type CreatePriceOverrideInput,
  type HeldCartListQuery,
  type ResumeHeldCartInput,
  type CreateSaleInput,
  type CreateSaleReturnInput,
  type OpenCashierSessionInput,
  type PreviewSaleReturnInput,
  type SaleListQuery,
  type StockAdjustmentInput,
  type StockQuery,
} from '@1pos/validation';
import { ApiKeyRequires, Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { CounterService } from './counter.service.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { CashService } from './cash.service.js';
import { SalesService } from './sales.service.js';
import { StockService } from './stock.service.js';
import { ReturnsService } from './returns.service.js';

const id = new ZodPipe(idParamSchema);

/** Cashier sessions, checkout and the stock ledger. Scope-aware permissions are checked in the services. */
@RequireTenant()
@Controller()
export class SalesController {
  constructor(
    @Inject(CashService) private readonly cash: CashService,
    @Inject(SalesService) private readonly sales: SalesService,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(ReturnsService) private readonly returns: ReturnsService,
    @Inject(CounterService) private readonly counter: CounterService,
  ) {}

  @Get('pos/workstations')
  workstations(@Auth() auth: AuthContext) {
    return this.cash.workstations(auth);
  }

  // cashier sessions
  @Idempotent()
  @Post('cashier-sessions')
  open(@Auth() auth: AuthContext, @Body(new ZodPipe(openCashierSessionSchema)) body: OpenCashierSessionInput) {
    return this.cash.open(auth, body);
  }

  @Get('cashier-sessions')
  listSessions(@Auth() auth: AuthContext, @Query(new ZodPipe(cashierSessionListQuerySchema)) q: CashierSessionListQuery) {
    return this.cash.list(auth, q);
  }

  @Get('cashier-sessions/:id')
  getSession(@Auth() auth: AuthContext, @Param('id', id) sessionId: string) {
    return this.cash.get(auth, sessionId);
  }

  @Idempotent()
  @Post('cashier-sessions/:id/movements')
  addMovement(@Auth() auth: AuthContext, @Param('id', id) sessionId: string, @Body(new ZodPipe(cashMovementSchema)) body: CashMovementInput) {
    return this.cash.addMovement(auth, sessionId, body);
  }

  // A close whose answer was lost is retried with the same key and replays the count (the till keeps one key per count).
  @Idempotent()
  @HttpCode(200)
  @Post('cashier-sessions/:id/close')
  close(@Auth() auth: AuthContext, @Param('id', id) sessionId: string, @Body(new ZodPipe(closeCashierSessionSchema)) body: CloseCashierSessionInput) {
    return this.cash.close(auth, sessionId, body);
  }

  @HttpCode(200)
  @Post('cashier-sessions/:id/approve-variance')
  approve(@Auth() auth: AuthContext, @Param('id', id) sessionId: string, @Body(new ZodPipe(approveVarianceSchema)) body: ApproveVarianceInput) {
    return this.cash.approveVariance(auth, sessionId, body);
  }

  // sales
  /** Financial write: Idempotency-Key is mandatory. */
  @Idempotent({ required: true })
  @Post('sales')
  createSale(@Auth() auth: AuthContext, @Body(new ZodPipe(createSaleSchema)) body: CreateSaleInput) {
    return this.sales.create(auth, body);
  }

  /** Return lines of an earlier sale and sell new items in one go (session 20). Idempotency-Key is mandatory. */
  @Idempotent({ required: true })
  @Post('exchanges')
  createExchange(@Auth() auth: AuthContext, @Body(new ZodPipe(createExchangeSchema)) body: CreateExchangeInput) {
    return this.sales.exchange(auth, body);
  }

  /**
   * A price change on one item, approved by the cashier (if they may) or by a manager signing in on the
   * spot. Rate-limited like a sign-in: per address, and per approver account named in the body, in the
   * same per-account bucket as sign-in (session 40), so the two together never allow more guesses than one.
   */
  @RateLimit({ bucket: 'price-override', limit: 20, windowSeconds: 600 }, { bucket: 'login-account', limit: 10, windowSeconds: 600, by: 'account' })
  @Post('price-overrides')
  createPriceOverride(@Auth() auth: AuthContext, @Body(new ZodPipe(createPriceOverrideSchema)) body: CreatePriceOverrideInput) {
    return this.counter.createPriceOverride(auth, body);
  }

  // held carts (session 20)
  @Get('held-carts')
  listHeldCarts(@Auth() auth: AuthContext, @Query(new ZodPipe(heldCartListQuerySchema)) q: HeldCartListQuery) {
    return this.counter.listHeldCarts(auth, q);
  }

  @Idempotent()
  @Post('held-carts')
  holdCart(@Auth() auth: AuthContext, @Body(new ZodPipe(createHeldCartSchema)) body: CreateHeldCartInput) {
    return this.counter.holdCart(auth, body);
  }

  // A resume whose answer was lost is sent again with the same key and gets the same lines back (the
  // cart forgets them once resumed). Optional, so an older till still resumes (audit 2026-10-27 #32).
  @Idempotent()
  @HttpCode(200)
  @Post('held-carts/:id/resume')
  resumeCart(@Auth() auth: AuthContext, @Param('id', id) cartId: string, @Body(new ZodPipe(resumeHeldCartSchema)) body: ResumeHeldCartInput) {
    return this.counter.resumeCart(auth, cartId, body.cashierSessionId);
  }

  @HttpCode(200)
  @Post('held-carts/:id/discard')
  discardCart(@Auth() auth: AuthContext, @Param('id', id) cartId: string) {
    return this.counter.discardCart(auth, cartId);
  }

  // A cashier reads their own sales without sales.read; an API key answers as the person who made it,
  // so it needs the scope (audit 2026-10-27 #21).
  @ApiKeyRequires('sales.read')
  @Get('sales')
  listSales(@Auth() auth: AuthContext, @Query(new ZodPipe(saleListQuerySchema)) q: SaleListQuery) {
    return this.sales.list(auth, q);
  }

  @ApiKeyRequires('sales.read')
  @Get('sales/:id')
  getSale(@Auth() auth: AuthContext, @Param('id', id) saleId: string) {
    return this.sales.get(auth, saleId);
  }

/** Void or return; refunds cash from an open drawer. Idempotency-Key is mandatory. */
  @Idempotent({ required: true })
  @Post('sales/:id/returns')
  createReturn(@Auth() auth: AuthContext, @Param('id', id) saleId: string, @Body(new ZodPipe(createSaleReturnSchema)) body: CreateSaleReturnInput) {
    return this.returns.create(auth, saleId, body);
  }

  /** What returning these lines would refund (session 20); records nothing. */
  @HttpCode(200)
  @Post('sales/:id/returns/preview')
  previewReturn(@Auth() auth: AuthContext, @Param('id', id) saleId: string, @Body(new ZodPipe(previewSaleReturnSchema)) body: PreviewSaleReturnInput) {
    return this.returns.preview(auth, saleId, body);
  }

  @ApiKeyRequires('sales.read')
  @Get('sales/:id/returns')
  listReturns(@Auth() auth: AuthContext, @Param('id', id) saleId: string) {
    return this.returns.list(auth, saleId);
  }

  @ApiKeyRequires('sales.read')
  @Get('sale-returns/:id')
  getReturn(@Auth() auth: AuthContext, @Param('id', id) returnId: string) {
    return this.returns.get(auth, returnId);
  }

  @ApiKeyRequires('sales.read')
  @Get('sale-returns/:id/receipt')
  returnReceipt(@Auth() auth: AuthContext, @Param('id', id) returnId: string) {
    return this.returns.receipt(auth, returnId);
  }

  @Get('cash-movements/:id')
  getCashMovement(@Auth() auth: AuthContext, @Param('id', id) movementId: string) {
    return this.cash.getMovement(auth, movementId);
  }

  @ApiKeyRequires('sales.read')
  @Get('sales/:id/receipt')
  receipt(@Auth() auth: AuthContext, @Param('id', id) saleId: string) {
    return this.sales.receipt(auth, saleId);
  }

  // stock
  /** Inventory evidence (and a journal entry): Idempotency-Key is mandatory, like every stock document. */
  @Idempotent({ required: true })
  @Post('stock/adjustments')
  adjust(@Auth() auth: AuthContext, @Body(new ZodPipe(stockAdjustmentSchema)) body: StockAdjustmentInput) {
    return this.stock.adjust(auth, body);
  }

  @Get('stock/adjustments')
  listAdjustments(@Auth() auth: AuthContext, @Query(new ZodPipe(stockQuerySchema)) q: StockQuery) {
    return this.stock.listAdjustments(auth, q);
  }

  @Get('stock/adjustments/:id')
  getAdjustment(@Auth() auth: AuthContext, @Param('id', id) adjustmentId: string) {
    return this.stock.getAdjustment(auth, adjustmentId);
  }

  @Get('stock/balances')
  balances(@Auth() auth: AuthContext, @Query(new ZodPipe(stockQuerySchema)) q: StockQuery) {
    return this.stock.balances(auth, q);
  }

  @Get('stock/movements')
  movements(@Auth() auth: AuthContext, @Query(new ZodPipe(stockQuerySchema)) q: StockQuery) {
    return this.stock.movements(auth, q);
  }
}
