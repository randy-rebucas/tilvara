import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql, type BusinessType, type Database } from '@1pos/database';
import { LODGING_CODES, roleTemplatesFor, servesAppointments, servesLodging, servesTables, type BusinessUpdateInput } from '@1pos/validation';
import { addRoleTemplates } from '../auth/role-templates.js';
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
 * The business's own details. Its type decides which features its people see: RETAIL, GROCERY and
 * SALON leave out restaurant service (refused by `assertFeature`), RESTAURANT leaves out selling by
 * weight (screens only), only SALON and HYBRID take appointments (`assertAppointments`, ADR-0022),
 * only LODGING and HYBRID have rooms and stays (`assertLodging`, ADR-0023), HYBRID shows everything. Records are never removed by a change of type.
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
      if (!servesTables(input.businessType)) {
        // Tables still in service would be left with orders nobody may bill or settle.
        const { rows } = await db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM restaurant_orders WHERE status IN ('OPEN', 'BILLED')`,
        );
        const open = Number(rows[0]?.n ?? 0);
        if (open > 0) {
          throw new AppError(
            'OPEN_RESTAURANT_ORDERS',
            'Settle or cancel the open restaurant orders before making this a business without table service',
            HttpStatus.CONFLICT,
            { openOrders: open },
          );
        }
      }
      if (!servesLodging(input.businessType)) {
        // Guests still in house would be left with folios nobody may settle (ADR-0023).
        const { rows: [stays] } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM stays WHERE status = 'IN_HOUSE'`);
        if (Number(stays?.n ?? 0) > 0) {
          throw new AppError('OPEN_STAYS', 'Check out the guests in house before making this a business without rooms', HttpStatus.CONFLICT, { inHouse: Number(stays!.n) });
        }
      }
      const { rows } = await db.execute<BusinessRow>(
        sql`UPDATE tenants SET business_type = ${input.businessType} WHERE id = ${tenantId}
            RETURNING id, slug, name, business_type`,
      );
      // A business that started without table service or appointments has no restaurant or salon roles yet;
      // they come with the type that uses them (existing roles are left as they are).
      const added = !servesTables(input.businessType) && !servesAppointments(input.businessType) && !servesLodging(input.businessType)
        ? new Map()
        : await addRoleTemplates(db, tenantId, roleTemplatesFor(input.businessType));
      // A salon's front desk becoming a hotel's (ADR-0023 §9): the role it already has gains the lodging codes.
      if (servesLodging(input.businessType) && !added.has('front_desk')) {
        const desk = roleTemplatesFor(input.businessType).find((t) => t.key === 'front_desk')!;
        await db.execute(sql`
          INSERT INTO role_permissions (tenant_id, role_id, permission_code)
          SELECT r.tenant_id, r.id, p.code FROM roles r
           CROSS JOIN (VALUES ${sql.join(desk.permissions.filter((p) => LODGING_CODES.includes(p)).map((p) => sql`(${p})`), sql`, `)}) AS p(code)
           WHERE r.key = 'front_desk' AND r.is_system
          ON CONFLICT DO NOTHING`);
      }
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
