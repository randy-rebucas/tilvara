import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  branches,
  desc,
  eq,
  inArray,
  productVariants,
  promotionBranches,
  promotionItems,
  promotions,
  sql,
  type Database,
  inSequence,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type { Promotion } from '@1pos/pricing';
import type { CreatePromotionInput, PromotionListQuery, UpdatePromotionInput } from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';
import { dbNow, EFFECTIVE_SKEW, effectiveNowSql } from '../common/clock.js';

/** A promotion may start this long before the request reached the database (clock skew), never earlier. */
const BACKDATE_TOLERANCE_MS = 60_000;

type PromotionRow = typeof promotions.$inferSelect;

/** The engine's view of a row (decimal strings normalised, so the till and the server read the same). */
export function enginePromotion(row: PromotionRow, variantIds: string[]): Promotion {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    startsAt: row.startsAt.toISOString(),
    variantIds,
    ...(row.quantity !== null && { quantity: row.quantity }),
    ...(row.price !== null && { price: toDec(row.price).toString() }),
    ...(row.buyQuantity !== null && { buyQuantity: row.buyQuantity }),
    ...(row.getQuantity !== null && { getQuantity: row.getQuantity }),
    ...(row.getRate !== null && { getRate: toDec(row.getRate).toString() }),
    ...(row.tiers !== null && { tiers: row.tiers }),
  };
}

/**
 * Promotions in force at a branch at `at` (ADR-0021 §1): started by then, not yet ended, for every
 * branch or listing this one. With `variantIds`, only those touching one of them. Each carries its
 * whole item set (a mix-and-match set may include items not in the cart).
 * With `knownAt` (an offline sale re-priced as of its snapshot), a promotion made after that instant is
 * ignored even when its start was set up to a minute earlier: the till could not have known it.
 */
export async function promotionsInForce(db: Database, branchId: string, at: Date, variantIds?: readonly string[], knownAt?: Date): Promise<Promotion[]> {
  if (variantIds && !variantIds.length) return [];
  const atSql = sql`${at.toISOString()}::timestamptz`;
  const rows = await db
    .select()
    .from(promotions)
    .where(
      and(
        sql`${promotions.startsAt} <= ${atSql}`,
        sql`(${promotions.endsAt} IS NULL OR ${promotions.endsAt} > ${atSql})`,
        knownAt ? sql`${promotions.createdAt} <= ${knownAt.toISOString()}::timestamptz + ${sql.raw(EFFECTIVE_SKEW)}` : undefined,
        sql`(${promotions.allBranches} OR EXISTS (SELECT 1 FROM promotion_branches pb WHERE pb.promotion_id = ${promotions.id} AND pb.branch_id = ${branchId}))`,
        variantIds
          ? sql`EXISTS (SELECT 1 FROM promotion_items pi WHERE pi.promotion_id = ${promotions.id} AND pi.variant_id IN (${sql.join(variantIds.map((v) => sql`${v}::uuid`), sql`, `)}))`
          : undefined,
      ),
    )
    .orderBy(asc(promotions.startsAt), asc(promotions.id));
  if (!rows.length) return [];
  const items = await db
    .select({ promotionId: promotionItems.promotionId, variantId: promotionItems.variantId })
    .from(promotionItems)
    .where(inArray(promotionItems.promotionId, rows.map((r) => r.id)))
    .orderBy(asc(promotionItems.variantId));
  return rows.map((r) => enginePromotion(r, items.filter((i) => i.promotionId === r.id).map((i) => i.variantId)));
}

/** The next start or end of a promotion at this branch after `after` (the till refreshes then). */
export async function nextPromotionChange(db: Database, branchId: string, after: Date): Promise<Date | null> {
  const at = after.toISOString();
  const { rows } = await db.execute<{ next: string | null }>(sql`
    SELECT min(t) AS next FROM (
      SELECT CASE WHEN p.starts_at > ${at}::timestamptz THEN p.starts_at ELSE p.ends_at END AS t
        FROM promotions p
       WHERE (p.starts_at > ${at}::timestamptz OR p.ends_at > ${at}::timestamptz)
         AND (p.all_branches OR EXISTS (SELECT 1 FROM promotion_branches pb WHERE pb.promotion_id = p.id AND pb.branch_id = ${branchId}))) s`);
  return rows[0]?.next ? new Date(rows[0].next) : null;
}

@Injectable()
export class PromotionsService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    promotions_terms_immutable: ['PROMOTION_ENDED', 'This promotion has ended; make a new one'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  list(auth: AuthContext, query: PromotionListQuery) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => {
      const state =
        query.state === 'CURRENT'
          ? sql`(${promotions.endsAt} IS NULL OR (${promotions.endsAt} > ${effectiveNowSql} AND ${promotions.endsAt} > ${promotions.startsAt}))`
          : query.state === 'ENDED'
            ? sql`(${promotions.endsAt} <= ${effectiveNowSql} OR ${promotions.endsAt} = ${promotions.startsAt})`
            : undefined;
      const rows = await db.select().from(promotions).where(state).orderBy(desc(promotions.startsAt), desc(promotions.id)).limit(500);
      return { data: await this.views(db, rows) };
    });
  }

  get(auth: AuthContext, id: string) {
    this.assertHolds(auth, 'catalog.read');
    return this.read(auth, async (db) => (await this.views(db, [await this.row(db, id)]))[0]!);
  }

  create(auth: AuthContext, input: CreatePromotionInput) {
    this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      const tenantId = tenantOf(auth).tenantId;
      const now = await dbNow(db);
      const startsAt = input.startsAt ? new Date(input.startsAt) : now;
      if (startsAt.getTime() < now.getTime() - BACKDATE_TOLERANCE_MS) {
        throw new AppError('BACKDATED_PROMOTION', 'A promotion can start now or later, never in the past', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const endsAt = input.endsAt ? new Date(input.endsAt) : null;
      if (endsAt && endsAt.getTime() <= Math.max(startsAt.getTime(), now.getTime())) {
        throw new AppError('VALIDATION_FAILED', 'A promotion ends after it starts and after now', HttpStatus.UNPROCESSABLE_ENTITY, { field: 'endsAt' });
      }
      const [found, branchRows] = await inSequence(
        () => db.select({ id: productVariants.id, archivedAt: productVariants.archivedAt }).from(productVariants).where(inArray(productVariants.id, input.variantIds)),
        () => (input.branchIds?.length ? db.select({ id: branches.id, archivedAt: branches.archivedAt }).from(branches).where(inArray(branches.id, input.branchIds)) : Promise.resolve([])),
      );
      const missing = input.variantIds.filter((v) => !found.some((f) => f.id === v && !f.archivedAt));
      if (missing.length) throw new AppError('NOT_FOUND', 'Item not found', HttpStatus.NOT_FOUND, { variantIds: missing });
      const missingBranches = (input.branchIds ?? []).filter((b) => !branchRows.some((f) => f.id === b && !f.archivedAt));
      if (missingBranches.length) throw new AppError('NOT_FOUND', 'Branch not found', HttpStatus.NOT_FOUND, { branchIds: missingBranches });

      const allBranches = !input.branchIds?.length;
      const [row] = await db
        .insert(promotions)
        .values({
          tenantId,
          name: input.name,
          kind: input.kind,
          quantity: input.quantity ?? null,
          price: input.price ?? null,
          buyQuantity: input.buyQuantity ?? null,
          getQuantity: input.getQuantity ?? null,
          getRate: input.getRate ?? null,
          tiers: input.tiers ?? null,
          allBranches,
          startsAt,
          endsAt,
          createdBy: auth.userId,
        })
        .returning();
      await db.insert(promotionItems).values(input.variantIds.map((variantId) => ({ tenantId, promotionId: row!.id, variantId })));
      if (!allBranches) await db.insert(promotionBranches).values(input.branchIds!.map((branchId) => ({ tenantId, promotionId: row!.id, branchId })));
      await this.audit(db, auth, 'promotion.created', 'promotion', row!.id, { kind: row!.kind, items: input.variantIds.length, allBranches });
      return (await this.views(db, [row!]))[0]!;
    });
  }

  /** The name, or ending it: `now` (a promotion not yet started is called off: it never runs), or a later moment. */
  update(auth: AuthContext, id: string, input: UpdatePromotionInput) {
    this.assertCan(auth, 'prices.manage');
    return this.mutate(auth, async (db) => {
      const row = await this.row(db, id);
      const set: Partial<PromotionRow> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.endsAt !== undefined) {
        const now = await dbNow(db);
        if (row.endsAt && row.endsAt.getTime() <= now.getTime()) throw new AppError('PROMOTION_ENDED', 'This promotion has ended; make a new one', HttpStatus.CONFLICT);
        if (input.endsAt === 'now') set.endsAt = row.startsAt.getTime() > now.getTime() ? row.startsAt : now;
        else {
          const at = new Date(input.endsAt);
          if (at.getTime() < now.getTime() || at.getTime() <= row.startsAt.getTime()) {
            throw new AppError('VALIDATION_FAILED', 'A promotion ends after it starts and after now', HttpStatus.UNPROCESSABLE_ENTITY, { field: 'endsAt' });
          }
          set.endsAt = at;
        }
      }
      const [updated] = await db.update(promotions).set(set).where(eq(promotions.id, id)).returning();
      await this.audit(db, auth, input.endsAt !== undefined ? 'promotion.ended' : 'promotion.renamed', 'promotion', id, {
        fields: Object.keys(input),
        ...(set.endsAt && { endsAt: set.endsAt.toISOString() }),
      });
      return (await this.views(db, [updated!]))[0]!;
    });
  }

  private async row(db: Database, id: string) {
    const [row] = await db.select().from(promotions).where(eq(promotions.id, id));
    if (!row) throw notFound('Promotion');
    return row;
  }

  /** Rows with their items (names) and branches, and their state now. */
  private async views(db: Database, rows: PromotionRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [items, branchRows, [now]] = await inSequence(
      () =>
        db
          .select({ promotionId: promotionItems.promotionId, variantId: promotionItems.variantId, sku: productVariants.sku, name: sql<string>`CASE WHEN ${productVariants.name} IS NULL THEN p.name ELSE p.name || ' — ' || ${productVariants.name} END` })
          .from(promotionItems)
          .innerJoin(productVariants, eq(productVariants.id, promotionItems.variantId))
          .innerJoin(sql`products p`, sql`p.id = ${productVariants.productId}`)
          .where(inArray(promotionItems.promotionId, ids))
          .orderBy(asc(productVariants.sku)),
      () => db.select({ promotionId: promotionBranches.promotionId, branchId: promotionBranches.branchId }).from(promotionBranches).where(inArray(promotionBranches.promotionId, ids)),
      () => db.execute<{ now: string | Date }>(sql`SELECT ${effectiveNowSql} AS now`).then((r) => r.rows),
    );
    const at = new Date(now!.now).getTime();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      quantity: r.quantity,
      price: r.price === null ? null : toDec(r.price).toFixed(2),
      buyQuantity: r.buyQuantity,
      getQuantity: r.getQuantity,
      getRate: r.getRate === null ? null : toDec(r.getRate).toString(),
      tiers: r.tiers,
      allBranches: r.allBranches,
      branchIds: branchRows.filter((b) => b.promotionId === r.id).map((b) => b.branchId),
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      // Called off before it started: an empty window, never ran.
      state: r.endsAt && (r.endsAt.getTime() <= at || r.endsAt.getTime() === r.startsAt.getTime()) ? 'ENDED' : r.startsAt.getTime() > at ? 'SCHEDULED' : 'RUNNING',
      items: items.filter((i) => i.promotionId === r.id).map(({ promotionId: _p, ...i }) => i),
      createdAt: r.createdAt,
    }));
  }
}

