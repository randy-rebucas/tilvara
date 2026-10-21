import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  createDispenseApprovalSchema,
  createLotHoldSchema,
  createPrescriptionSchema,
  equivalentsQuerySchema,
  idParamSchema,
  lotHoldListQuerySchema,
  lotTraceQuerySchema,
  pharmacistLicenseSchema,
  pharmacySettingsSchema,
  prescriptionListQuerySchema,
  releaseLotHoldSchema,
  reportRangeSchema,
  updatePrescriptionSchema,
  voidPrescriptionSchema,
  type CreateDispenseApprovalInput,
  type CreateLotHoldInput,
  type CreatePrescriptionInput,
  type EquivalentsQuery,
  type LotHoldListQuery,
  type LotTraceQuery,
  type PharmacistLicenseInput,
  type PharmacySettingsInput,
  type PrescriptionListQuery,
  type ReleaseLotHoldInput,
  type ReportRangeQuery,
  type UpdatePrescriptionInput,
  type VoidPrescriptionInput,
} from '@1pos/validation';
import { z } from 'zod';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { BatchesService } from './batches.service.js';
import { PharmacyBooksService } from './books.service.js';
import { PrescriptionsService } from './prescriptions.service.js';

const id = new ZodPipe(idParamSchema);
const customerPrescriptionsQuery = new ZodPipe(z.object({ branchId: z.uuid().optional() }));

/**
 * Pharmacies and drugstores (ADR-0025): prescriptions, the pharmacist's approval at the till, licences and
 * settings, lot holds and the batch trace, equivalents, and the two books. Dispensing itself happens in the
 * sale (`SalesService.record`); permissions and the business type are checked in the services.
 */
@RequireTenant()
@Controller()
export class PharmacyController {
  constructor(
    @Inject(PrescriptionsService) private readonly prescriptions: PrescriptionsService,
    @Inject(BatchesService) private readonly batches: BatchesService,
    @Inject(PharmacyBooksService) private readonly books: PharmacyBooksService,
  ) {}

  // ---------------------------------------------------------------- prescriptions

  @Get('prescriptions')
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(prescriptionListQuerySchema)) q: PrescriptionListQuery) {
    return this.prescriptions.list(auth, q);
  }

  @Get('prescriptions/:id')
  get(@Auth() auth: AuthContext, @Param('id', id) prescriptionId: string) {
    return this.prescriptions.get(auth, prescriptionId);
  }

  @Idempotent()
  @Post('prescriptions')
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(createPrescriptionSchema)) input: CreatePrescriptionInput) {
    return this.prescriptions.create(auth, input);
  }

  @Patch('prescriptions/:id')
  update(@Auth() auth: AuthContext, @Param('id', id) prescriptionId: string, @Body(new ZodPipe(updatePrescriptionSchema)) input: UpdatePrescriptionInput) {
    return this.prescriptions.update(auth, prescriptionId, input);
  }

  @HttpCode(200)
  @Post('prescriptions/:id/void')
  void(@Auth() auth: AuthContext, @Param('id', id) prescriptionId: string, @Body(new ZodPipe(voidPrescriptionSchema)) input: VoidPrescriptionInput) {
    return this.prescriptions.void(auth, prescriptionId, input);
  }

  /** A customer's prescriptions with something left to dispense (the till offers them for a refill). */
  @Get('customers/:id/prescriptions')
  forCustomer(@Auth() auth: AuthContext, @Param('id', id) customerId: string, @Query(customerPrescriptionsQuery) q: { branchId?: string }) {
    return this.prescriptions.openForCustomer(auth, customerId, q.branchId);
  }

  /**
   * A pharmacist approves prescription medicines for the cashier, signing in on the spot (like a price
   * override). Rate-limited like a sign-in: per address, and per approver account named in the body.
   */
  @RateLimit({ bucket: 'dispense-approval', limit: 20, windowSeconds: 600 }, { bucket: 'dispense-approval-account', limit: 10, windowSeconds: 600, by: 'account' })
  @Post('pharmacy/dispense-approvals')
  approve(@Auth() auth: AuthContext, @Body(new ZodPipe(createDispenseApprovalSchema)) input: CreateDispenseApprovalInput) {
    return this.prescriptions.createApproval(auth, input);
  }

  // ---------------------------------------------------------------- set-up

  @Get('pharmacy/settings')
  getSettings(@Auth() auth: AuthContext) {
    return this.prescriptions.getSettings(auth);
  }

  @Put('pharmacy/settings')
  setSettings(@Auth() auth: AuthContext, @Body(new ZodPipe(pharmacySettingsSchema)) input: PharmacySettingsInput) {
    return this.prescriptions.setSettings(auth, input);
  }

  @Get('pharmacy/pharmacists')
  pharmacists(@Auth() auth: AuthContext) {
    return this.prescriptions.listPharmacists(auth);
  }

  @Put('pharmacy/pharmacists/:id')
  setLicence(@Auth() auth: AuthContext, @Param('id', id) membershipId: string, @Body(new ZodPipe(pharmacistLicenseSchema)) input: PharmacistLicenseInput) {
    return this.prescriptions.setLicence(auth, membershipId, input);
  }

  // ---------------------------------------------------------------- batches

  @Get('stock/lot-holds')
  holds(@Auth() auth: AuthContext, @Query(new ZodPipe(lotHoldListQuerySchema)) q: LotHoldListQuery) {
    return this.batches.listHolds(auth, q);
  }

  @Idempotent()
  @Post('stock/lot-holds')
  hold(@Auth() auth: AuthContext, @Body(new ZodPipe(createLotHoldSchema)) input: CreateLotHoldInput) {
    return this.batches.createHold(auth, input);
  }

  @HttpCode(200)
  @Post('stock/lot-holds/:id/release')
  release(@Auth() auth: AuthContext, @Param('id', id) holdId: string, @Body(new ZodPipe(releaseLotHoldSchema)) input: ReleaseLotHoldInput) {
    return this.batches.releaseHold(auth, holdId, input);
  }

  @Get('stock/lots/trace')
  trace(@Auth() auth: AuthContext, @Query(new ZodPipe(lotTraceQuerySchema)) q: LotTraceQuery) {
    return this.batches.trace(auth, q);
  }

  @Get('catalog/equivalents')
  equivalents(@Auth() auth: AuthContext, @Query(new ZodPipe(equivalentsQuerySchema)) q: EquivalentsQuery) {
    return this.batches.equivalents(auth, q);
  }

  // ---------------------------------------------------------------- books

  @Get('reports/prescription-book')
  prescriptionBook(@Auth() auth: AuthContext, @Query(new ZodPipe(reportRangeSchema)) range: ReportRangeQuery) {
    return this.books.prescriptionBook(auth, range);
  }

  @Get('reports/dangerous-drugs')
  dangerousDrugs(@Auth() auth: AuthContext, @Query(new ZodPipe(reportRangeSchema)) range: ReportRangeQuery) {
    return this.books.dangerousDrugs(auth, range);
  }
}
