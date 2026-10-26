import { Inject, Injectable } from '@nestjs/common';
import { sql, type BusinessType, type Database } from '@1pos/database';
import type { BusinessUpdateInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { TenantService, type ConflictMap } from '../common/tenant-service.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type BusinessRow = {
  id: string;
  slug: string;
  name: string;
  business_type: BusinessType;
};

/**
 * The business's own details. RETAIL is the only business type (0112 removed the others) and a trade comes
 * back as an extension (ADR-0026), so only the name changes here; the type is still shown for older clients.
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
      if (input.name === before.name) return view(before);
      const { rows } = await db.execute<BusinessRow>(
        sql`UPDATE tenants SET name = ${input.name} WHERE id = ${tenantOf(auth).tenantId} RETURNING id, slug, name, business_type`,
      );
      await this.audit(db, auth, 'tenant.renamed', 'tenant', before.id, { from: before.name, to: input.name });
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
