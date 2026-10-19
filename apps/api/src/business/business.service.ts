import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql, type BusinessType, type Database } from '@1pos/database';
import type { BusinessUpdateInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type BusinessRow = {
  id: string;
  slug: string;
  name: string;
  business_type: BusinessType;
};

/**
 * The business's own details. Its type decides which features its people see: RETAIL leaves out
 * restaurant service (refused by `assertFeature`), RESTAURANT leaves out selling by weight (screens
 * only), HYBRID shows everything. Records are never removed by a change of type.
 */
@Injectable()
export class BusinessService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  get(auth: AuthContext) {
    return this.read(auth, async (db) => view(await row(db)));
  }

  update(auth: AuthContext, input: BusinessUpdateInput) {
    this.assertCan(auth, 'tenant.manage');
    return this.mutate(auth, async (db) => {
      const before = await row(db, true);
      if (before.business_type === input.businessType) return view(before);
      if (input.businessType === 'RETAIL') {
        // Tables still in service would be left with orders nobody may bill or settle.
        const { rows } = await db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM restaurant_orders WHERE status IN ('OPEN', 'BILLED')`,
        );
        const open = Number(rows[0]?.n ?? 0);
        if (open > 0) {
          throw new AppError(
            'OPEN_RESTAURANT_ORDERS',
            'Settle or cancel the open restaurant orders before making this a retail business',
            HttpStatus.CONFLICT,
            { openOrders: open },
          );
        }
      }
      const { rows } = await db.execute<BusinessRow>(
        sql`UPDATE tenants SET business_type = ${input.businessType} WHERE id = ${tenantOf(auth).tenantId}
            RETURNING id, slug, name, business_type`,
      );
      await this.audit(db, auth, 'tenant.business_type_changed', 'tenant', before.id, {
        from: before.business_type,
        to: input.businessType,
      });
      return view(rows[0]!);
    });
  }
}

async function row(db: Database, lock = false): Promise<BusinessRow> {
  const { rows } = await db.execute<BusinessRow>(
    lock ? sql`SELECT id, slug, name, business_type FROM tenants FOR UPDATE` : sql`SELECT id, slug, name, business_type FROM tenants`,
  );
  return rows[0]!;
}

function view(r: BusinessRow) {
  return { id: r.id, slug: r.slug, name: r.name, businessType: r.business_type };
}
