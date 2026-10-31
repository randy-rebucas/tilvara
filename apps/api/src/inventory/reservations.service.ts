import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, branches, desc, eq, products, productVariants, sql, stockReservations, users, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import type { CreateReservationInput, ReleaseReservationInput, ReservationListQuery } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { activeCustomer } from '../customers/customers.service.js';
import { dbNow } from '../common/clock.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { expiredStockRule, unsellableAt } from './expiry.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { unprocessable } from '../tax/tax.service.js';

/** SQL: a reservation that still holds stock (active, and not past its expiry on the DB clock). */
export const holdsStock = sql`(status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now()))`;

/** Units reserved per item at a branch (only items that have any). */
export async function reservedAt(db: Database, branchId: string, variantIds?: readonly string[]) {
  const { rows } = await db.execute<{ variant_id: string; reserved: string }>(sql`
    SELECT variant_id, sum(quantity)::text AS reserved FROM stock_reservations
     WHERE branch_id = ${branchId} AND ${holdsStock}
       ${variantIds?.length ? sql`AND variant_id IN (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
     GROUP BY 1`);
  return new Map(rows.map((r) => [r.variant_id, toDec(r.reserved)]));
}

/**
 * Stock reservations (session 20, SPEC §10): units set aside at a branch for a customer or a reason,
 * so they are not sold to someone else. available = on hand − reserved. A reservation moves no stock
 * and posts nothing. Taking one needs `sales.create` or `inventory.adjust` at the branch, and never
 * more than is available; the balance row is locked so two reservations cannot share the last units.
 */
@Injectable()
export class ReservationsService extends TenantService {
  protected readonly conflicts: ConflictMap = {};

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  private async scope(db: Database, branchId: string) {
    const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
    if (!branch) throw notFound('Branch');
    return { branchId: branch.id, legalEntityId: branch.legalEntityId };
  }

  private assertMay(auth: AuthContext, scope: { branchId: string; legalEntityId: string }) {
    if (!this.can(auth, 'sales.create', scope)) this.assertCan(auth, 'inventory.adjust', scope);
  }

  create(auth: AuthContext, input: CreateReservationInput) {
    return this.mutate(auth, async (db) => {
      const scope = await this.scope(db, input.branchId);
      this.assertMay(auth, scope);
      const [item] = await db
        .select({ track: products.trackInventory, archivedAt: sql<string | null>`coalesce(${productVariants.archivedAt}, ${products.archivedAt})` })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, input.variantId));
      if (!item) throw notFound('Item');
      if (item.archivedAt) throw archived('Item');
      if (!item.track) throw unprocessable('NOT_TRACKED', 'Only items whose stock is counted can be reserved');
      if (input.customerId) await activeCustomer(db, input.customerId);
      if (input.expiresAt && new Date(input.expiresAt).getTime() <= (await dbNow(db)).getTime()) {
        throw unprocessable('EXPIRY_IN_PAST', 'A reservation must end in the future', { path: ['expiresAt'] });
      }
      // Lock the balance (the same lock a counter sale takes under BLOCK), then count what is free.
      const { rows } = await db.execute<{ quantity: string }>(
        sql`SELECT quantity::text FROM app_lock_stock_balances(${input.branchId}, ARRAY[${input.variantId}]::uuid[])`,
      );
      const onHand = toDec(rows[0]?.quantity ?? '0');
      const reserved = (await reservedAt(db, input.branchId, [input.variantId])).get(input.variantId) ?? new Dec(0);
      // Held lots are never sold, nor expired ones where the branch blocks them: they cannot be set aside either (audit 2026-10-31 #24).
      const rule = await expiredStockRule(db, input.branchId);
      const unsellable = (await unsellableAt(db, input.branchId, [input.variantId], { expired: rule === 'BLOCK' })).get(input.variantId) ?? new Dec(0);
      const available = onHand.minus(reserved).minus(unsellable);
      if (toDec(input.quantity).gt(available)) {
        throw new AppError('INSUFFICIENT_STOCK', 'Not that much is available to reserve', HttpStatus.CONFLICT, {
          onHand: onHand.toString(), reserved: reserved.toString(), unsellable: unsellable.toString(), available: Dec.max(available, 0).toString(),
        });
      }
      const [row] = await db
        .insert(stockReservations)
        .values({
          tenantId: tenantOf(auth).tenantId, branchId: input.branchId, variantId: input.variantId, quantity: input.quantity, note: input.note,
          customerId: input.customerId ?? null, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: auth.userId,
        })
        .returning();
      await this.audit(db, auth, 'stock.reserved', 'stock_reservation', row!.id, { branchId: input.branchId, variantId: input.variantId, quantity: input.quantity });
      return this.view(db, row!);
    });
  }

  release(auth: AuthContext, id: string, input: ReleaseReservationInput) {
    return this.mutate(auth, async (db) => {
      const [current] = await db.select().from(stockReservations).where(eq(stockReservations.id, id)).for('update');
      if (!current) throw notFound('Reservation');
      this.assertMay(auth, await this.scope(db, current.branchId));
      if (current.status !== 'ACTIVE') throw new AppError('RESERVATION_RELEASED', 'This reservation was already released', HttpStatus.CONFLICT);
      const [row] = await db
        .update(stockReservations)
        .set({ status: 'RELEASED', releasedBy: auth.userId, releasedAt: sql`now()`, releaseReason: input.reason })
        .where(eq(stockReservations.id, id))
        .returning();
      await this.audit(db, auth, 'stock.reservation_released', 'stock_reservation', id, { reason: input.reason });
      return this.view(db, row!);
    });
  }

  list(auth: AuthContext, q: ReservationListQuery) {
    return this.read(auth, async (db) => {
      const scope = await this.scope(db, q.branchId);
      if (!this.can(auth, 'inventory.read', scope)) this.assertMay(auth, scope);
      const rows = await db
        .select({ r: stockReservations, sku: productVariants.sku, name: products.name, variantName: productVariants.name, createdByName: users.displayName })
        .from(stockReservations)
        .innerJoin(productVariants, eq(productVariants.id, stockReservations.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .leftJoin(users, eq(users.id, stockReservations.createdBy))
        .where(and(eq(stockReservations.branchId, q.branchId), q.status === 'ACTIVE' ? eq(stockReservations.status, 'ACTIVE') : undefined))
        .orderBy(desc(stockReservations.createdAt), desc(stockReservations.id))
        .limit(500);
      const now = (await db.execute<{ now: string }>(sql`SELECT now()::text AS now`)).rows[0]!.now;
      return {
        data: rows.map(({ r, sku, name, variantName, createdByName }) => ({
          ...this.shape(r),
          sku, name: variantName ? `${name} — ${variantName}` : name, createdByName,
          expired: r.status === 'ACTIVE' && r.expiresAt !== null && r.expiresAt.getTime() <= new Date(now).getTime(),
        })),
      };
    });
  }

  private async view(db: Database, r: typeof stockReservations.$inferSelect) {
    const [item] = await db.select({ sku: productVariants.sku, name: products.name }).from(productVariants).innerJoin(products, eq(products.id, productVariants.productId)).where(eq(productVariants.id, r.variantId));
    return { ...this.shape(r), sku: item?.sku ?? null, name: item?.name ?? null };
  }

  private shape(r: typeof stockReservations.$inferSelect) {
    return {
      id: r.id, branchId: r.branchId, variantId: r.variantId, quantity: toDec(r.quantity).toString(), note: r.note, customerId: r.customerId,
      status: r.status, expiresAt: r.expiresAt, createdBy: r.createdBy, createdAt: r.createdAt, releasedAt: r.releasedAt, releaseReason: r.releaseReason,
    };
  }
}
