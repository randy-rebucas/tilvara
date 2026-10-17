import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  approveVarianceSchema,
  cashierSessionListQuerySchema,
  cashMovementSchema,
  closeCashierSessionSchema,
  createCheckSchema,
  createSaleReturnSchema,
  createSaleSchema,
  idParamSchema,
  openCashierSessionSchema,
  previewCheckSchema,
  saleListQuerySchema,
  stockAdjustmentSchema,
  stockQuerySchema,
  type ApproveVarianceInput,
  type CashierSessionListQuery,
  type CashMovementInput,
  type CloseCashierSessionInput,
  type CreateCheckInput,
  type CreateSaleInput,
  type CreateSaleReturnInput,
  type OpenCashierSessionInput,
  type PreviewCheckInput,
  type SaleListQuery,
  type StockAdjustmentInput,
  type StockQuery,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
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

  /** A restaurant check: a sale paying shares of a bill (ADR-0014 §8). Idempotency-Key is mandatory. */
  @Idempotent({ required: true })
  @Post('restaurant/bills/:id/checks')
  createCheck(@Auth() auth: AuthContext, @Param('id', id) billId: string, @Body(new ZodPipe(createCheckSchema)) body: CreateCheckInput) {
    return this.sales.createFromBill(auth, billId, body);
  }

  /** What a check would pay, priced like the check itself; records nothing. */
  @HttpCode(200)
  @Post('restaurant/bills/:id/checks/preview')
  previewCheck(@Auth() auth: AuthContext, @Param('id', id) billId: string, @Body(new ZodPipe(previewCheckSchema)) body: PreviewCheckInput) {
    return this.sales.previewCheck(auth, billId, body);
  }

  @Get('sales')
  listSales(@Auth() auth: AuthContext, @Query(new ZodPipe(saleListQuerySchema)) q: SaleListQuery) {
    return this.sales.list(auth, q);
  }

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

  @Get('sales/:id/returns')
  listReturns(@Auth() auth: AuthContext, @Param('id', id) saleId: string) {
    return this.returns.list(auth, saleId);
  }

  @Get('sale-returns/:id')
  getReturn(@Auth() auth: AuthContext, @Param('id', id) returnId: string) {
    return this.returns.get(auth, returnId);
  }

  @Get('sale-returns/:id/receipt')
  returnReceipt(@Auth() auth: AuthContext, @Param('id', id) returnId: string) {
    return this.returns.receipt(auth, returnId);
  }

  @Get('cash-movements/:id')
  getCashMovement(@Auth() auth: AuthContext, @Param('id', id) movementId: string) {
    return this.cash.getMovement(auth, movementId);
  }

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
