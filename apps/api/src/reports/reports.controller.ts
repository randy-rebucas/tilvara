import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  branchQuerySchema,
  idParamSchema,
  prepTimesBySchema,
  reportDaySchema,
  reportRangeSchema,
  type BranchQuery,
  type PrepTimesByQuery,
  type ReportDayQuery,
  type ReportRangeQuery,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { ReportsService } from './reports.service.js';
import { RestaurantReportsService } from './restaurant-reports.service.js';

const range = new ZodPipe(reportRangeSchema);
const id = new ZodPipe(idParamSchema);

/** Read-only reports; `reports.read` at the branch (checked in the service). */
@RequireTenant()
@Controller('reports')
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(RestaurantReportsService) private readonly restaurant: RestaurantReportsService,
  ) {}

  @Get('sales-summary')
  salesSummary(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.salesSummary(auth, q);
  }

  @Get('by-product')
  byProduct(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.reports.byProduct(auth, q);
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

  // Restaurant (ADR-0014 §10)

  @Get('item-performance')
  itemPerformance(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.restaurant.itemPerformance(auth, q);
  }

  @Get('ingredient-usage')
  ingredientUsage(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.restaurant.ingredientUsage(auth, q);
  }

  @Get('kitchen-voids')
  kitchenVoids(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.restaurant.kitchenVoids(auth, q);
  }

  @Get('prep-times')
  prepTimes(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery, @Query(new ZodPipe(prepTimesBySchema)) g: PrepTimesByQuery) {
    return this.restaurant.prepTimes(auth, q, g.by);
  }

  @Get('open-orders')
  openOrders(@Auth() auth: AuthContext, @Query(new ZodPipe(reportDaySchema)) q: ReportDayQuery) {
    return this.restaurant.openOrders(auth, q);
  }

  @Get('service-charge')
  serviceCharge(@Auth() auth: AuthContext, @Query(range) q: ReportRangeQuery) {
    return this.restaurant.serviceCharge(auth, q);
  }

  @Get('cashier-sessions/:id')
  session(@Auth() auth: AuthContext, @Param('id', id) sessionId: string) {
    return this.reports.session(auth, sessionId);
  }
}
