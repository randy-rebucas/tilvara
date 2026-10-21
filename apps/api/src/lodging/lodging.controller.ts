import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  applyDepositSchema,
  cancelStaySchema,
  checkInSchema,
  checkOutSchema,
  createRoomBlockSchema,
  createRoomSchema,
  createRoomTypeSchema,
  createStaySchema,
  folioAdjustmentSchema,
  folioPaymentSchema,
  forfeitDepositSchema,
  housekeepingQuerySchema,
  idParamSchema,
  inHouseQuerySchema,
  lodgingAvailabilityQuerySchema,
  lodgingSettingsSchema,
  nightAuditSchema,
  nightReversalSchema,
  receiveDepositSchema,
  refundDepositSchema,
  roomBlockListQuerySchema,
  roomListQuerySchema,
  roomStatusSchema,
  roomTypeListQuerySchema,
  stayBeneficiarySchema,
  stayGuestSchema,
  stayListQuerySchema,
  updateRoomSchema,
  updateRoomTypeSchema,
  updateStayGuestSchema,
  updateStaySchema,
  type ApplyDepositInput,
  type CancelStayInput,
  type CheckInInput,
  type CheckOutInput,
  type CreateRoomBlockInput,
  type CreateRoomInput,
  type CreateRoomTypeInput,
  type CreateStayInput,
  type FolioAdjustmentInput,
  type FolioPaymentInput,
  type ForfeitDepositInput,
  type HousekeepingQuery,
  type InHouseQuery,
  type LodgingAvailabilityQuery,
  type LodgingSettingsInput,
  type NightAuditInput,
  type NightReversalInput,
  type ReceiveDepositInput,
  type RefundDepositInput,
  type RoomBlockListQuery,
  type RoomListQuery,
  type RoomStatusInput,
  type RoomTypeListQuery,
  type StayBeneficiaryInput,
  type StayGuestInput,
  type StayListQuery,
  type UpdateRoomInput,
  type UpdateRoomTypeInput,
  type UpdateStayGuestInput,
  type UpdateStayInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { DepositsService } from './deposits.service.js';
import { FoliosService } from './folios.service.js';
import { LodgingSetupService } from './setup.service.js';
import { StaysService } from './stays.service.js';

const id = new ZodPipe(idParamSchema);

/**
 * Hotels, resorts and transient houses (ADR-0023): rooms and their set-up, housekeeping, stays and
 * check-in/out, the guest registry, deposits, folios and the night audit. Permissions and the business
 * type are checked in the services.
 */
@RequireTenant()
@Controller()
export class LodgingController {
  constructor(
    @Inject(LodgingSetupService) private readonly setup: LodgingSetupService,
    @Inject(StaysService) private readonly stays: StaysService,
    @Inject(DepositsService) private readonly deposits: DepositsService,
    @Inject(FoliosService) private readonly folios: FoliosService,
  ) {}

  // ---------------------------------------------------------------- room types and rooms

  @Get('room-types')
  listRoomTypes(@Auth() auth: AuthContext, @Query(new ZodPipe(roomTypeListQuerySchema)) q: RoomTypeListQuery) {
    return this.setup.listRoomTypes(auth, q);
  }

  @Idempotent()
  @Post('room-types')
  createRoomType(@Auth() auth: AuthContext, @Body(new ZodPipe(createRoomTypeSchema)) input: CreateRoomTypeInput) {
    return this.setup.createRoomType(auth, input);
  }

  @Get('room-types/:id')
  getRoomType(@Auth() auth: AuthContext, @Param('id', id) roomTypeId: string) {
    return this.setup.getRoomType(auth, roomTypeId);
  }

  @Patch('room-types/:id')
  updateRoomType(@Auth() auth: AuthContext, @Param('id', id) roomTypeId: string, @Body(new ZodPipe(updateRoomTypeSchema)) input: UpdateRoomTypeInput) {
    return this.setup.updateRoomType(auth, roomTypeId, input);
  }

  @Get('rooms')
  listRooms(@Auth() auth: AuthContext, @Query(new ZodPipe(roomListQuerySchema)) q: RoomListQuery) {
    return this.setup.listRooms(auth, q);
  }

  @Idempotent()
  @Post('rooms')
  createRoom(@Auth() auth: AuthContext, @Body(new ZodPipe(createRoomSchema)) input: CreateRoomInput) {
    return this.setup.createRoom(auth, input);
  }

  @Get('rooms/:id')
  getRoom(@Auth() auth: AuthContext, @Param('id', id) roomId: string) {
    return this.setup.getRoom(auth, roomId);
  }

  @Patch('rooms/:id')
  updateRoom(@Auth() auth: AuthContext, @Param('id', id) roomId: string, @Body(new ZodPipe(updateRoomSchema)) input: UpdateRoomInput) {
    return this.setup.updateRoom(auth, roomId, input);
  }

  /** Housekeeping: CLEAN, DIRTY, INSPECTED, OUT_OF_ORDER (with a note). */
  @HttpCode(200)
  @Post('rooms/:id/status')
  setRoomStatus(@Auth() auth: AuthContext, @Param('id', id) roomId: string, @Body(new ZodPipe(roomStatusSchema)) input: RoomStatusInput) {
    return this.setup.setRoomStatus(auth, roomId, input);
  }

  @Get('rooms/:id/status-changes')
  statusChanges(@Auth() auth: AuthContext, @Param('id', id) roomId: string) {
    return this.setup.statusChanges(auth, roomId);
  }

  @Get('room-blocks')
  listBlocks(@Auth() auth: AuthContext, @Query(new ZodPipe(roomBlockListQuerySchema)) q: RoomBlockListQuery) {
    return this.setup.listBlocks(auth, q);
  }

  @Idempotent()
  @Post('room-blocks')
  createBlock(@Auth() auth: AuthContext, @Body(new ZodPipe(createRoomBlockSchema)) input: CreateRoomBlockInput) {
    return this.setup.createBlock(auth, input);
  }

  @Delete('room-blocks/:id')
  removeBlock(@Auth() auth: AuthContext, @Param('id', id) blockId: string) {
    return this.setup.removeBlock(auth, blockId);
  }

  @Get('lodging/housekeeping')
  housekeeping(@Auth() auth: AuthContext, @Query(new ZodPipe(housekeepingQuerySchema)) q: HousekeepingQuery) {
    return this.setup.housekeeping(auth, q);
  }

  @Get('branches/:id/lodging-settings')
  settings(@Auth() auth: AuthContext, @Param('id', id) branchId: string) {
    return this.setup.getSettings(auth, branchId);
  }

  @Patch('branches/:id/lodging-settings')
  updateSettings(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Body(new ZodPipe(lodgingSettingsSchema)) input: LodgingSettingsInput) {
    return this.setup.updateSettings(auth, branchId, input);
  }

  // ---------------------------------------------------------------- stays

  @Get('lodging/availability')
  availability(@Auth() auth: AuthContext, @Query(new ZodPipe(lodgingAvailabilityQuerySchema)) q: LodgingAvailabilityQuery) {
    return this.stays.availability(auth, q);
  }

  /** The night audit now, for a branch. */
  @HttpCode(200)
  @Post('lodging/night-audit')
  nightAudit(@Auth() auth: AuthContext, @Body(new ZodPipe(nightAuditSchema)) input: NightAuditInput) {
    return this.folios.runNightAudit(auth, input);
  }

  @Get('stays')
  listStays(@Auth() auth: AuthContext, @Query(new ZodPipe(stayListQuerySchema)) q: StayListQuery) {
    return this.stays.list(auth, q);
  }

  /** In-house guests of the branch's legal entity, for Charge to room (`sales.create`). */
  @Get('stays/in-house')
  inHouse(@Auth() auth: AuthContext, @Query(new ZodPipe(inHouseQuerySchema)) q: InHouseQuery) {
    return this.stays.inHouse(auth, q);
  }

  @Idempotent()
  @Post('stays')
  book(@Auth() auth: AuthContext, @Body(new ZodPipe(createStaySchema)) input: CreateStayInput) {
    return this.stays.create(auth, input);
  }

  @Get('stays/:id')
  getStay(@Auth() auth: AuthContext, @Param('id', id) stayId: string) {
    return this.stays.get(auth, stayId);
  }

  @Patch('stays/:id')
  updateStay(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(updateStaySchema)) input: UpdateStayInput) {
    return this.stays.update(auth, stayId, input);
  }

  @HttpCode(200)
  @Post('stays/:id/cancel')
  cancel(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(cancelStaySchema)) input: CancelStayInput) {
    return this.stays.cancel(auth, stayId, input);
  }

  @HttpCode(200)
  @Post('stays/:id/no-show')
  noShow(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(cancelStaySchema)) input: CancelStayInput) {
    return this.stays.noShow(auth, stayId, input);
  }

  @HttpCode(200)
  @Post('stays/:id/check-in')
  checkIn(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(checkInSchema)) input: CheckInInput) {
    return this.stays.checkIn(auth, stayId, input);
  }

  /** Charge every night up to departure and apply deposits, so the front desk can settle. */
  @HttpCode(200)
  @Post('stays/:id/prepare-check-out')
  prepareCheckOut(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(checkOutSchema)) input: CheckOutInput) {
    return this.stays.prepareCheckOut(auth, stayId, input);
  }

  @HttpCode(200)
  @Post('stays/:id/check-out')
  checkOut(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(checkOutSchema)) input: CheckOutInput) {
    return this.stays.checkOut(auth, stayId, input);
  }

  @Get('stays/:id/guests')
  guests(@Auth() auth: AuthContext, @Param('id', id) stayId: string) {
    return this.stays.guests(auth, stayId);
  }

  @Post('stays/:id/guests')
  addGuest(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(stayGuestSchema)) input: StayGuestInput) {
    return this.stays.addGuest(auth, stayId, input);
  }

  @Patch('stays/:id/guests/:guestId')
  updateGuest(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Param('guestId', id) guestId: string, @Body(new ZodPipe(updateStayGuestSchema)) input: UpdateStayGuestInput) {
    return this.stays.updateGuest(auth, stayId, guestId, input);
  }

  @Delete('stays/:id/guests/:guestId')
  removeGuest(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Param('guestId', id) guestId: string) {
    return this.stays.removeGuest(auth, stayId, guestId);
  }

  @Get('stays/:id/registration-card')
  registrationCard(@Auth() auth: AuthContext, @Param('id', id) stayId: string) {
    return this.stays.registrationCard(auth, stayId);
  }

  @Post('stays/:id/beneficiaries')
  addBeneficiary(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(stayBeneficiarySchema)) input: StayBeneficiaryInput) {
    return this.stays.addBeneficiary(auth, stayId, input);
  }

  @Delete('stays/:id/beneficiaries/:beneficiaryId')
  removeBeneficiary(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Param('beneficiaryId', id) beneficiaryId: string) {
    return this.stays.removeBeneficiary(auth, stayId, beneficiaryId);
  }

  @Get('stays/:id/deposits')
  listDeposits(@Auth() auth: AuthContext, @Param('id', id) stayId: string) {
    return this.deposits.list(auth, stayId);
  }

  @Idempotent({ required: true })
  @Post('stays/:id/deposits')
  receiveDeposit(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(receiveDepositSchema)) input: ReceiveDepositInput) {
    return this.deposits.receive(auth, stayId, input);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('stays/:id/deposits/apply')
  applyDeposit(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(applyDepositSchema)) input: ApplyDepositInput) {
    return this.deposits.apply(auth, stayId, input);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('stays/:id/deposits/refund')
  refundDeposit(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(refundDepositSchema)) input: RefundDepositInput) {
    return this.deposits.refund(auth, stayId, input);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('stays/:id/deposits/forfeit')
  forfeitDeposit(@Auth() auth: AuthContext, @Param('id', id) stayId: string, @Body(new ZodPipe(forfeitDepositSchema)) input: ForfeitDepositInput) {
    return this.deposits.forfeit(auth, stayId, input);
  }

  @Get('stays/:id/folio')
  stayFolio(@Auth() auth: AuthContext, @Param('id', id) stayId: string) {
    return this.folios.ofStay(auth, stayId);
  }

  // ---------------------------------------------------------------- folios

  @Get('folios/:id')
  folio(@Auth() auth: AuthContext, @Param('id', id) folioId: string) {
    return this.folios.get(auth, folioId);
  }

  @Get('folios/:id/statement')
  statement(@Auth() auth: AuthContext, @Param('id', id) folioId: string) {
    return this.folios.statement(auth, folioId);
  }

  @Idempotent({ required: true })
  @Post('folios/:id/payments')
  pay(@Auth() auth: AuthContext, @Param('id', id) folioId: string, @Body(new ZodPipe(folioPaymentSchema)) input: FolioPaymentInput) {
    return this.folios.pay(auth, folioId, input);
  }

  @Idempotent({ required: true })
  @Post('folios/:id/adjustments')
  adjust(@Auth() auth: AuthContext, @Param('id', id) folioId: string, @Body(new ZodPipe(folioAdjustmentSchema)) input: FolioAdjustmentInput) {
    return this.folios.adjust(auth, folioId, input);
  }

  @Idempotent({ required: true })
  @Post('folios/:id/night-reversals')
  reverseNight(@Auth() auth: AuthContext, @Param('id', id) folioId: string, @Body(new ZodPipe(nightReversalSchema)) input: NightReversalInput) {
    return this.folios.reverseNight(auth, folioId, input);
  }
}
