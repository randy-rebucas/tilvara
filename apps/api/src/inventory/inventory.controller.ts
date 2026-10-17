import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  branchQuerySchema,
  createStockCountSchema,
  createStockTransferSchema,
  idParamSchema,
  receiveStockTransferSchema,
  setReorderPointsSchema,
  stockTransferListQuerySchema,
  type BranchQuery,
  type CreateStockCountInput,
  type CreateStockTransferInput,
  type ReceiveStockTransferInput,
  type SetReorderPointsInput,
  type StockTransferListQuery,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { InventoryService } from './inventory.service.js';

const id = new ZodPipe(idParamSchema);

/** Transfers, counts, reorder points and low stock. Scope-aware permissions are checked in the service. */
@RequireTenant()
@Controller()
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  /** Inventory evidence: Idempotency-Key is mandatory. */
  @Idempotent({ required: true })
  @Post('stock/transfers')
  dispatch(@Auth() auth: AuthContext, @Body(new ZodPipe(createStockTransferSchema)) body: CreateStockTransferInput) {
    return this.inventory.dispatch(auth, body);
  }

  @Get('stock/transfers')
  listTransfers(@Auth() auth: AuthContext, @Query(new ZodPipe(stockTransferListQuerySchema)) q: StockTransferListQuery) {
    return this.inventory.listTransfers(auth, q);
  }

  @Get('stock/transfers/:id')
  getTransfer(@Auth() auth: AuthContext, @Param('id', id) transferId: string) {
    return this.inventory.getTransfer(auth, transferId);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('stock/transfers/:id/receive')
  receive(@Auth() auth: AuthContext, @Param('id', id) transferId: string, @Body(new ZodPipe(receiveStockTransferSchema)) body: ReceiveStockTransferInput) {
    return this.inventory.receiveTransfer(auth, transferId, body);
  }

  @Idempotent({ required: true })
  @Post('stock/counts')
  count(@Auth() auth: AuthContext, @Body(new ZodPipe(createStockCountSchema)) body: CreateStockCountInput) {
    return this.inventory.count(auth, body);
  }

  @Get('stock/counts')
  listCounts(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery) {
    return this.inventory.listCounts(auth, q);
  }

  @Get('stock/counts/:id')
  getCount(@Auth() auth: AuthContext, @Param('id', id) countId: string) {
    return this.inventory.getCount(auth, countId);
  }

  @Get('stock/reorder-points')
  listReorderPoints(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery) {
    return this.inventory.listReorderPoints(auth, q);
  }

  @Put('stock/reorder-points')
  setReorderPoints(@Auth() auth: AuthContext, @Body(new ZodPipe(setReorderPointsSchema)) body: SetReorderPointsInput) {
    return this.inventory.setReorderPoints(auth, body);
  }

  @Get('stock/low')
  lowStock(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery) {
    return this.inventory.lowStock(auth, q);
  }
}
