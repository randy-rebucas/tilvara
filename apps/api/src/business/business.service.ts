import { Inject, Injectable } from '@nestjs/common';
import { sql, type BusinessType, type Database } from '@1pos/database';
import { roleTemplatesFor, servesAppointments, servesPharmacy, type BusinessUpdateInput } from '@1pos/validation';
import { addRoleTemplates } from '../auth/role-templates.js';
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
 * The business's own details. Its type decides which features its people see: only SALON and HYBRID
 * take appointments, sell packages and record supplies used (`assertAppointments`, `assertPackages`,
 * `assertRecipes`, ADR-0022), only PHARMACY and HYBRID dispense prescription medicines (`assertPharmacy`,
 * ADR-0025; a pharmacy's branches block expired stock unless set otherwise), HYBRID shows everything.
 * Records are never removed by a change of type.
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
      const tenantId = tenantOf(auth).tenantId;
      let after = before;
      if (input.name !== undefined && input.name !== before.name) {
        after = (await db.execute<BusinessRow>(
          sql`UPDATE tenants SET name = ${input.name} WHERE id = ${tenantId} RETURNING id, slug, name, business_type`,
        )).rows[0]!;
        await this.audit(db, auth, 'tenant.renamed', 'tenant', before.id, { from: before.name, to: input.name });
      }
      if (input.businessType === undefined || before.business_type === input.businessType) return view(after);
      const { rows } = await db.execute<BusinessRow>(
        sql`UPDATE tenants SET business_type = ${input.businessType} WHERE id = ${tenantId}
            RETURNING id, slug, name, business_type`,
      );
      // A business that started without appointments or a dispensary has no salon or pharmacy roles yet;
      // they come with the type that uses them (existing roles are left as they are).
      const added = !servesAppointments(input.businessType) && !servesPharmacy(input.businessType)
        ? new Map()
        : await addRoleTemplates(db, tenantId, roleTemplatesFor(input.businessType));
      await this.audit(db, auth, 'tenant.business_type_changed', 'tenant', before.id, {
        from: before.business_type,
        to: input.businessType,
        ...(added.size > 0 && { rolesAdded: [...added.keys()] }),
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
