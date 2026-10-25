import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  attributeQuerySchema,
  type AttributeQuery,
  branchQuerySchema,
  consolidatedRangeSchema,
  type ConsolidatedRangeQuery,
  idParamSchema,
  reportRangeSchema,
  type BranchQuery,
  type ReportRangeQuery,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { ReportsService } from './reports.service.js';
import { AnalysisReportsService } from './analysis-reports.service.js';

const range = new ZodPipe(reportRangeSchema);
const id = new ZodPipe(idParamSchema);

/** Read-only reports; `reports.read` at the branch (checked in the service). */
@RequireTenant()
@Controller('reports')
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(AnalysisReportsService) private readonly analysis: AnalysisReportsService,
  ) {}

  // Session 20 (SPEC §6.10)

  @Get('by-category')
  byCategory(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.analysis.byCategory(auth, q);
  }

  /** Every branch the person may report on, side by side, and the total. */
  @Get('by-branch')
  byBranch(@Auth() auth: AuthContext, @Query(new ZodPipe(consolidatedRangeSchema)) q: ConsolidatedRangeQuery) {
    return this.analysis.byBranch(auth, q);
  }

  @Get('discounts')
  discounts(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.analysis.discounts(auth, q);
  }

  @Get('purchases-by-supplier')
  purchasesBySupplier(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.analysis.purchasesBySupplier(auth, q);
  }

  @Get('payment-exceptions')
  paymentExceptions(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery) {
    return this.analysis.paymentExceptions(auth, q.branchId);
  }

  @Get('sales-summary')
  salesSummary(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.salesSummary(auth, q);
  }

  @Get('by-product')
  byProduct(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.byProduct(auth, q);
  }

  /** Sales by size and colour (ADR-0021 §2). */
  @Get('by-attribute')
  byAttribute(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery, @Query(new ZodPipe(attributeQuerySchema)) a: AttributeQuery) {
    return this.reports.byAttribute(auth, q, a.attribute);
  }

  @Get('promotions')
  promotions(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.promotions(auth, q);
  }

  @Get('by-cashier')
  byCashier(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.byCashier(auth, q);
  }

  @Get('by-tender')
  byTender(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.byTender(auth, q);
  }

  @Get('tax-summary')
  taxSummary(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.taxSummary(auth, q);
  }

  @Get('statutory-book')
  statutoryBook(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.statutoryBook(auth, q);
  }

  @Get('inventory-valuation')
  inventoryValuation(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery) {
    return this.reports.inventoryValuation(auth, q.branchId);
  }

  @Get('stock-movements')
  stockMovements(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.stockMovements(auth, q);
  }

  @Get('refund-watch')
  refundWatch(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.refundWatch(auth, q);
  }

  @Get('cashier-sessions/:id')
  session(@Auth() auth: AuthContext, @Param('id', id) sessionId: string) {
    return this.reports.session(auth, sessionId);
  }
}
