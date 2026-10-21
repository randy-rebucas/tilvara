import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  cancelJobOrderSchema,
  claimJobOrderSchema,
  createGarmentTypeSchema,
  createJobOrderSchema,
  createMachineSchema,
  createTripSchema,
  disposeJobOrderSchema,
  garmentTypeListQuerySchema,
  idParamSchema,
  jobDepositSchema,
  jobMachineRunSchema,
  jobOrderItemsSchema,
  jobOrderLinesSchema,
  jobOrderListQuerySchema,
  jobOrderLookupQuerySchema,
  jobOrderStatusSchema,
  laundrySettingsSchema,
  machineBoardQuerySchema,
  machineListQuerySchema,
  refundJobDepositSchema,
  tripCancelSchema,
  tripFailedSchema,
  tripListQuerySchema,
  updateGarmentTypeSchema,
  updateJobOrderSchema,
  updateMachineSchema,
  updateTripSchema,
  type CancelJobOrderInput,
  type ClaimJobOrderInput,
  type CreateGarmentTypeInput,
  type CreateJobOrderInput,
  type CreateMachineInput,
  type CreateTripInput,
  type DisposeJobOrderInput,
  type GarmentTypeListQuery,
  type JobDepositInput,
  type JobMachineRunInput,
  type JobOrderItemsInput,
  type JobOrderLinesInput,
  type JobOrderListQuery,
  type JobOrderLookupQuery,
  type JobOrderStatusInput,
  type LaundrySettingsInput,
  type MachineBoardQuery,
  type MachineListQuery,
  type RefundJobDepositInput,
  type TripListQuery,
  type TripReasonInput,
  type UpdateGarmentTypeInput,
  type UpdateJobOrderInput,
  type UpdateMachineInput,
  type UpdateTripInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { SalesService } from '../sales/sales.service.js';
import { JobDepositsService } from './deposits.service.js';
import { JobOrdersService } from './job-orders.service.js';
import { LaundrySetupService } from './setup.service.js';
import { TripsService } from './trips.service.js';

const id = new ZodPipe(idParamSchema);

/**
 * Laundromats and laundry shops (ADR-0024): set-up and machines, job orders from drop-off to claim,
 * down payments, pickups and deliveries. Permissions and the business type are checked in the services;
 * the claim is a sale (`SalesService.createFromJobOrder`).
 */
@RequireTenant()
@Controller()
export class LaundryController {
  constructor(
    @Inject(LaundrySetupService) private readonly setup: LaundrySetupService,
    @Inject(JobOrdersService) private readonly jobs: JobOrdersService,
    @Inject(JobDepositsService) private readonly deposits: JobDepositsService,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(SalesService) private readonly sales: SalesService,
  ) {}

  // ---------------------------------------------------------------- set-up

  @Get('branches/:id/laundry-settings')
  getSettings(@Auth() auth: AuthContext, @Param('id', id) branchId: string) {
    return this.setup.getSettings(auth, branchId);
  }

  @Patch('branches/:id/laundry-settings')
  updateSettings(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Body(new ZodPipe(laundrySettingsSchema)) input: LaundrySettingsInput) {
    return this.setup.updateSettings(auth, branchId, input);
  }

  @Get('laundry/garment-types')
  listGarmentTypes(@Auth() auth: AuthContext, @Query(new ZodPipe(garmentTypeListQuerySchema)) q: GarmentTypeListQuery) {
    return this.setup.listGarmentTypes(auth, q.includeArchived);
  }

  @Idempotent()
  @Post('laundry/garment-types')
  createGarmentType(@Auth() auth: AuthContext, @Body(new ZodPipe(createGarmentTypeSchema)) input: CreateGarmentTypeInput) {
    return this.setup.createGarmentType(auth, input);
  }

  @Patch('laundry/garment-types/:id')
  updateGarmentType(@Auth() auth: AuthContext, @Param('id', id) typeId: string, @Body(new ZodPipe(updateGarmentTypeSchema)) input: UpdateGarmentTypeInput) {
    return this.setup.updateGarmentType(auth, typeId, input);
  }

  @Get('laundry/machines')
  listMachines(@Auth() auth: AuthContext, @Query(new ZodPipe(machineListQuerySchema)) q: MachineListQuery) {
    return this.setup.listMachines(auth, q);
  }

  @Get('laundry/machines/board')
  board(@Auth() auth: AuthContext, @Query(new ZodPipe(machineBoardQuerySchema)) q: MachineBoardQuery) {
    return this.setup.board(auth, q);
  }

  @Idempotent()
  @Post('laundry/machines')
  createMachine(@Auth() auth: AuthContext, @Body(new ZodPipe(createMachineSchema)) input: CreateMachineInput) {
    return this.setup.createMachine(auth, input);
  }

  @Patch('laundry/machines/:id')
  updateMachine(@Auth() auth: AuthContext, @Param('id', id) machineId: string, @Body(new ZodPipe(updateMachineSchema)) input: UpdateMachineInput) {
    return this.setup.updateMachine(auth, machineId, input);
  }

  @HttpCode(200)
  @Post('machine-runs/:id/stop')
  stopRun(@Auth() auth: AuthContext, @Param('id', id) runId: string) {
    return this.setup.stopRun(auth, runId);
  }

  // ---------------------------------------------------------------- job orders

  @Idempotent({ required: true })
  @Post('job-orders')
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(createJobOrderSchema)) input: CreateJobOrderInput) {
    return this.jobs.create(auth, input);
  }

  @Get('job-orders')
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(jobOrderListQuerySchema)) q: JobOrderListQuery) {
    return this.jobs.list(auth, q);
  }

  @Get('job-orders/lookup')
  lookup(@Auth() auth: AuthContext, @Query(new ZodPipe(jobOrderLookupQuerySchema)) q: JobOrderLookupQuery) {
    return this.jobs.lookup(auth, q);
  }

  @Get('job-orders/:id')
  get(@Auth() auth: AuthContext, @Param('id', id) jobId: string) {
    return this.jobs.get(auth, jobId);
  }

  @Patch('job-orders/:id')
  update(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(updateJobOrderSchema)) input: UpdateJobOrderInput) {
    return this.jobs.update(auth, jobId, input);
  }

  @Put('job-orders/:id/lines')
  replaceLines(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(jobOrderLinesSchema)) input: JobOrderLinesInput) {
    return this.jobs.replaceLines(auth, jobId, input);
  }

  @Put('job-orders/:id/items')
  replaceItems(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(jobOrderItemsSchema)) input: JobOrderItemsInput) {
    return this.jobs.replaceItems(auth, jobId, input);
  }

  @HttpCode(200)
  @Post('job-orders/:id/status')
  setStatus(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(jobOrderStatusSchema)) input: JobOrderStatusInput) {
    return this.jobs.setStatus(auth, jobId, input);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('job-orders/:id/cancel')
  cancel(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(cancelJobOrderSchema)) input: CancelJobOrderInput) {
    return this.jobs.cancel(auth, jobId, input);
  }

  @Idempotent({ required: true })
  @HttpCode(200)
  @Post('job-orders/:id/dispose')
  dispose(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(disposeJobOrderSchema)) input: DisposeJobOrderInput) {
    return this.jobs.dispose(auth, jobId, input);
  }

  @Get('job-orders/:id/ticket')
  ticket(@Auth() auth: AuthContext, @Param('id', id) jobId: string) {
    return this.jobs.ticket(auth, jobId);
  }

  @Get('job-orders/:id/message')
  message(@Auth() auth: AuthContext, @Param('id', id) jobId: string) {
    return this.jobs.message(auth, jobId);
  }

  @Get('job-orders/:id/notices')
  notices(@Auth() auth: AuthContext, @Param('id', id) jobId: string) {
    return this.jobs.notices(auth, jobId);
  }

  @Post('job-orders/:id/machine-runs')
  runLoad(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(jobMachineRunSchema)) input: JobMachineRunInput) {
    return this.setup.runJobLoad(auth, jobId, input);
  }

  @Get('job-orders/:id/deposits')
  listDeposits(@Auth() auth: AuthContext, @Param('id', id) jobId: string) {
    return this.deposits.list(auth, jobId);
  }

  @Idempotent({ required: true })
  @Post('job-orders/:id/deposits')
  receiveDeposit(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(jobDepositSchema)) input: JobDepositInput) {
    return this.deposits.receive(auth, jobId, input);
  }

  @Idempotent({ required: true })
  @Post('job-orders/:id/deposits/refund')
  refundDeposit(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(refundJobDepositSchema)) input: RefundJobDepositInput) {
    return this.deposits.refund(auth, jobId, input);
  }

  /** The claim (§5): the sale of the job's frozen lines, the down payment first. */
  @Idempotent({ required: true })
  @Post('job-orders/:id/claim')
  claim(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(claimJobOrderSchema)) input: ClaimJobOrderInput) {
    return this.sales.createFromJobOrder(auth, jobId, input);
  }

  // ---------------------------------------------------------------- trips

  @Idempotent()
  @Post('job-orders/:id/trips')
  createTrip(@Auth() auth: AuthContext, @Param('id', id) jobId: string, @Body(new ZodPipe(createTripSchema)) input: CreateTripInput) {
    return this.trips.create(auth, jobId, input);
  }

  @Get('laundry/trips')
  listTrips(@Auth() auth: AuthContext, @Query(new ZodPipe(tripListQuerySchema)) q: TripListQuery) {
    return this.trips.list(auth, q);
  }

  @Patch('laundry/trips/:id')
  updateTrip(@Auth() auth: AuthContext, @Param('id', id) tripId: string, @Body(new ZodPipe(updateTripSchema)) input: UpdateTripInput) {
    return this.trips.update(auth, tripId, input);
  }

  @HttpCode(200)
  @Post('laundry/trips/:id/start')
  startTrip(@Auth() auth: AuthContext, @Param('id', id) tripId: string) {
    return this.trips.start(auth, tripId);
  }

  @HttpCode(200)
  @Post('laundry/trips/:id/done')
  tripDone(@Auth() auth: AuthContext, @Param('id', id) tripId: string) {
    return this.trips.done(auth, tripId);
  }

  @HttpCode(200)
  @Post('laundry/trips/:id/failed')
  tripFailed(@Auth() auth: AuthContext, @Param('id', id) tripId: string, @Body(new ZodPipe(tripFailedSchema)) input: TripReasonInput) {
    return this.trips.failed(auth, tripId, input);
  }

  @HttpCode(200)
  @Post('laundry/trips/:id/cancel')
  cancelTrip(@Auth() auth: AuthContext, @Param('id', id) tripId: string, @Body(new ZodPipe(tripCancelSchema)) input: TripReasonInput) {
    return this.trips.cancel(auth, tripId, input);
  }
}
