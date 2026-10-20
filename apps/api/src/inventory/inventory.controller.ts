import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  createReservationSchema,
  releaseReservationSchema,
  reservationListQuerySchema,
  type CreateReservationInput,
  type ReleaseReservationInput,
  type ReservationListQuery,
  branchQuerySchema,
  cancelCountSheetSchema,
  countSheetLinesSchema,
  countSheetListQuerySchema,
  createCountSheetSchema,
  inventorySettingsSchema,
  type CancelCountSheetInput,
  type CountSheetLinesInput,
  type CountSheetListQuery,
  type CreateCountSheetInput,
  type InventorySettingsInput,
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
import { ReservationsService } from './reservations.service.js';

const id = new ZodPipe(idParamSchema);

/** Transfers, counts, reorder points and low stock. Scope-aware permissions are checked in the service. */
@RequireTenant()
@Controller()
export class InventoryController {
  constructor(
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
  ) {}

  // reservations (session 20)
  @Idempotent()
  @Post('stock/reservations')
  reserve(@Auth() auth: AuthContext, @Body(new ZodPipe(createReservationSchema)) body: CreateReservationInput) {
    return this.reservations.create(auth, body);
  }

  @Get('stock/reservations')
  listReservations(@Auth() auth: AuthContext, @Query(new ZodPipe(reservationListQuerySchema)) q: ReservationListQuery) {
    return this.reservations.list(auth, q);
  }

  @HttpCode(200)
  @Post('stock/reservations/:id/release')
  release(@Auth() auth: AuthContext, @Param('id', id) reservationId: string, @Body(new ZodPipe(releaseReservationSchema)) body: ReleaseReservationInput) {
    return this.reservations.release(auth, reservationId, body);
  }

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

  // Count sheets (blind counts): open and freeze, count, post or cancel.
  @Post('stock/count-sheets')
  openCountSheet(@Auth() auth: AuthContext, @Body(new ZodPipe(createCountSheetSchema)) body: CreateCountSheetInput) {
    return this.inventory.openCountSheet(auth, body);
  }

  @Get('stock/count-sheets')
  listCountSheets(@Auth() auth: AuthContext, @Query(new ZodPipe(countSheetListQuerySchema)) q: CountSheetListQuery) {
    return this.inventory.listCountSheets(auth, q);
  }

  @Get('stock/count-sheets/:id')
  getCountSheet(@Auth() auth: AuthContext, @Param('id', id) sheetId: string) {
    return this.inventory.getCountSheet(auth, sheetId);
  }

  @Put('stock/count-sheets/:id/lines')
  countSheetLines(@Auth() auth: AuthContext, @Param('id', id) sheetId: string, @Body(new ZodPipe(countSheetLinesSchema)) body: CountSheetLinesInput) {
    return this.inventory.countSheetLines(auth, sheetId, body);
  }

  /** Posting moves stock and books: Idempotency-Key is mandatory. */
  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('stock/count-sheets/:id/post')
  postCountSheet(@Auth() auth: AuthContext, @Param('id', id) sheetId: string) {
    return this.inventory.postCountSheet(auth, sheetId);
  }

  @HttpCode(200)
  @Post('stock/count-sheets/:id/cancel')
  cancelCountSheet(@Auth() auth: AuthContext, @Param('id', id) sheetId: string, @Body(new ZodPipe(cancelCountSheetSchema)) body: CancelCountSheetInput) {
    return this.inventory.cancelCountSheet(auth, sheetId, body);
  }

  @Get('branches/:id/inventory-settings')
  getSettings(@Auth() auth: AuthContext, @Param('id', id) branchId: string) {
    return this.inventory.getSettings(auth, branchId);
  }

  @Put('branches/:id/inventory-settings')
  setSettings(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Body(new ZodPipe(inventorySettingsSchema)) body: InventorySettingsInput) {
    return this.inventory.setSettings(auth, branchId, body);
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
