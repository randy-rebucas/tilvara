import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql, suppliers, type Database } from '@1pos/database';
import type { CreateSupplierInput, SupplierListQuery, UpdateSupplierInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

/** Load a supplier for use on a purchasing document (404 across tenants, 409 when archived). */
export async function activeSupplier(db: Database, id: string) {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id));
  if (!row) throw notFound('Supplier');
  if (row.archivedAt) throw archived('Supplier');
  return row;
}

/**
 * Supplier master data. Suppliers are tenant-wide: maintaining them needs tenant-wide
 * purchasing.manage; anyone who buys or receives stock somewhere may read them.
 */
@Injectable()
export class SuppliersService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    suppliers_code_active_unique: ['SUPPLIER_CODE_TAKEN', 'An active supplier already uses this code'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  create(auth: AuthContext, input: CreateSupplierInput) {
    return this.mutate(auth, async (db) => {
      this.assertCan(auth, 'purchasing.manage');
      const [row] = await db.insert(suppliers).values({ tenantId: tenantOf(auth).tenantId, ...input }).returning();
      await this.audit(db, auth, 'supplier.created', 'supplier', row!.id, { code: row!.code });
      return row!;
    });
  }

  update(auth: AuthContext, id: string, input: UpdateSupplierInput) {
    return this.mutate(auth, async (db) => {
      const [current] = await db.select().from(suppliers).where(eq(suppliers.id, id));
      if (!current) throw notFound('Supplier');
      this.assertCan(auth, 'purchasing.manage');
      if (current.archivedAt) throw archived('Supplier');
      const [row] = await db.update(suppliers).set({ ...input, updatedAt: sql`now()` }).where(eq(suppliers.id, id)).returning();
      await this.audit(db, auth, 'supplier.updated', 'supplier', id, { fields: Object.keys(input) });
      return row!;
    });
  }

  archive(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const [current] = await db.select().from(suppliers).where(eq(suppliers.id, id));
      if (!current) throw notFound('Supplier');
      this.assertCan(auth, 'purchasing.manage');
      if (current.archivedAt) return current;
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM purchase_orders WHERE supplier_id = ${id} AND status IN ('DRAFT','APPROVED','PARTIALLY_RECEIVED')`,
      );
      if (rows[0]!.n > 0) {
        throw new AppError('SUPPLIER_HAS_OPEN_ORDERS', 'Close or cancel this supplier’s open purchase orders first', HttpStatus.CONFLICT, { openOrders: rows[0]!.n });
      }
      const [row] = await db.update(suppliers).set({ archivedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(suppliers.id, id)).returning();
      await this.audit(db, auth, 'supplier.archived', 'supplier', id);
      return row!;
    });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id));
      if (!row) throw notFound('Supplier');
      this.assertCanRead(auth);
      return row;
    });
  }

  list(auth: AuthContext, q: SupplierListQuery) {
    return this.read(auth, async (db) => {
      this.assertCanRead(auth);
      const term = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const rows = await db
        .select()
        .from(suppliers)
        .where(
          and(
            q.includeArchived ? undefined : isNull(suppliers.archivedAt),
            term ? sql`(${suppliers.name} ILIKE ${term} OR ${suppliers.code} ILIKE ${term})` : undefined,
          ),
        )
        .orderBy(asc(suppliers.name))
        .limit(500);
      return { data: rows };
    });
  }

  /** Any purchasing or inventory grant, at any scope. */
  private assertCanRead(auth: AuthContext) {
    const ok = tenantOf(auth).grants.some((g) => g.permission === 'purchasing.manage' || g.permission === 'inventory.read');
    if (!ok) this.assertCan(auth, 'purchasing.manage');
  }
}
