import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { Auth, RequireTenant, tenantOf, type AuthContext } from '../auth/auth-context.js';
import { hasPermission } from '../auth/authorization.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { subscriptionSummary } from './entitlements.js';

/**
 * Read-only subscription view. Plan changes happen through the billing integration
 * (PayMongo, not built yet) — never by a tenant API call, so nobody can upgrade for free.
 */
@RequireTenant()
@Controller('subscription')
export class BillingController {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  @Get()
  async get(@Auth() auth: AuthContext) {
    const grants = tenantOf(auth).grants;
    if (!hasPermission(grants, 'subscription.manage') && !hasPermission(grants, 'tenant.manage')) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: ['subscription.manage'] });
    }
    const summary = await this.tenantDb.run(auth, (db) => subscriptionSummary(db));
    if (!summary) throw new AppError('NOT_FOUND', 'No subscription found', HttpStatus.NOT_FOUND);
    return summary;
  }
}
