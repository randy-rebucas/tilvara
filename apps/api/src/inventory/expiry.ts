import { HttpStatus } from '@nestjs/common';
import { sql, type Database } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { AppError } from '../infrastructure/http-error.filter.js';
import { reservedAt } from './reservations.service.js';

/**
 * The expired-stock rule (ADR-0020 §3, ADR-0025 §4 as kept for every shop): per branch
 * `inventory_settings.expired_stock`; where it is BLOCK, expired lots and lots on hold are not sold online
 * and an offline sale that drew them is flagged EXPIRED_STOCK. No setting = ALLOW.
 */

/** The branch's rule: its setting, else ALLOW (as the lot trigger decides; migration 0112 wrote BLOCK for the former pharmacies). */
export async function expiredStockRule(db: Database, branchId: string): Promise<'ALLOW' | 'BLOCK'> {
  const { rows: [r] } = await db.execute<{ rule: 'ALLOW' | 'BLOCK' }>(sql`
    SELECT coalesce(i.expired_stock, 'ALLOW') AS rule
      FROM branches b
      LEFT JOIN inventory_settings i ON i.tenant_id = b.tenant_id AND i.branch_id = b.id
     WHERE b.id = ${branchId}`);
  return r?.rule ?? 'ALLOW';
}

/**
 * What of each item at a branch sits in expired or held lots (not for sale where the rule is BLOCK). A hold
 * covers the item's whole pack family, as `app_lot_held()` does (migration 0107): every item linked to it
 * through pack links either way, archived links included (lot codes copied down while a link was active
 * stay on the pieces). Read here under RLS rather than through the definer function.
 */
export async function unsellableAt(db: Database, branchId: string, variantIds: readonly string[]): Promise<Map<string, Dec>> {
  if (!variantIds.length) return new Map();
  const { rows } = await db.execute<{ variant_id: string; quantity: string }>(sql`
    WITH RECURSIVE family(start_id, v) AS (
      SELECT x, x FROM unnest(ARRAY[${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]) AS x
      UNION
      SELECT f.start_id, CASE WHEN pc.pack_variant_id = f.v THEN pc.piece_variant_id ELSE pc.pack_variant_id END
        FROM family f JOIN pack_conversions pc ON pc.pack_variant_id = f.v OR pc.piece_variant_id = f.v)
    SELECT l.variant_id, sum(l.quantity)::text AS quantity
      FROM stock_lots l JOIN branches b ON b.id = l.branch_id
     WHERE l.branch_id = ${branchId} AND l.quantity > 0
       AND l.variant_id IN (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND (l.expires_on < (now() AT TIME ZONE b.timezone)::date
            OR (l.lot_code IS NOT NULL AND EXISTS (
                  SELECT 1 FROM lot_holds h JOIN family f ON f.start_id = l.variant_id AND f.v = h.variant_id
                   WHERE h.released_at IS NULL AND upper(btrim(h.lot_code)) = upper(btrim(l.lot_code))
                     AND (h.branch_id IS NULL OR h.branch_id = l.branch_id))))
     GROUP BY 1`);
  return new Map(rows.map((r) => [r.variant_id, toDec(r.quantity)]));
}

/**
 * BLOCK: refuse an online sale that could only be filled from expired or held lots. Run
 * after the sale's own pack openings, before the negative-stock rule, with the balances locked in variant
 * order (as the movements will lock them a moment later). Whatever is short of stock altogether is the
 * negative-stock rule's to decide; this refuses only what would take dated stock that may not be sold.
 */
export async function assertNotExpired(db: Database, branchId: string, lines: readonly { variantId: string; quantity: string; name: string }[]): Promise<void> {
  if (!lines.length || (await expiredStockRule(db, branchId)) !== 'BLOCK') return;
  const need = new Map<string, { quantity: Dec; name: string }>();
  for (const l of lines) need.set(l.variantId, { quantity: (need.get(l.variantId)?.quantity ?? new Dec(0)).plus(l.quantity), name: l.name });
  const ids = [...need.keys()].sort();
  const unsellable = await unsellableAt(db, branchId, ids);
  if (![...unsellable.values()].some((q) => q.gt(0))) return;
  const { rows } = await db.execute<{ variant_id: string; quantity: string }>(
    sql`SELECT variant_id, quantity::text FROM app_lock_stock_balances(${branchId}, ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[])`,
  );
  const reserved = await reservedAt(db, branchId, ids);
  const short = ids.flatMap((variantId) => {
    const blocked = unsellable.get(variantId) ?? new Dec(0);
    if (blocked.lte(0)) return [];
    const onHand = toDec(rows.find((r) => r.variant_id === variantId)?.quantity ?? '0');
    const sellable = Dec.max(onHand.minus(reserved.get(variantId) ?? 0).minus(blocked), 0);
    const { quantity, name } = need.get(variantId)!;
    return quantity.gt(sellable) ? [{ variantId, name, sellable: sellable.toString(), expiredOrHeld: blocked.toString(), requested: quantity.toString() }] : [];
  });
  if (short.length) {
    throw new AppError(
      'EXPIRED_STOCK',
      `Only expired or held stock is left: ${short.map((s) => `${s.name} (${s.sellable} sellable)`).join(', ')}. Write it off or return it to the supplier.`,
      HttpStatus.CONFLICT,
      { lines: short },
    );
  }
}

/** The lots a sale's movements drew while expired or held (an offline sale; CONSUMPTION covers sales from before 0112). */
export async function expiredDraws(db: Database, saleId: string) {
  const { rows } = await db.execute<{ variant_id: string; lot_code: string | null; expires_on: string; quantity: string }>(sql`
    SELECT m.variant_id, s.lot_code, s.expires_on::text, (-sum(lm.quantity))::text AS quantity
      FROM stock_movements m
      JOIN stock_lot_movements lm ON lm.tenant_id = m.tenant_id AND lm.movement_id = m.id AND lm.expired
      JOIN stock_lots s ON s.tenant_id = lm.tenant_id AND s.id = lm.lot_id
     WHERE m.sale_id = ${saleId} AND m.type IN ('SALE', 'CONSUMPTION')
     GROUP BY 1, 2, 3`);
  return rows.map((r) => ({ variantId: r.variant_id, lotCode: r.lot_code, expiresOn: r.expires_on, quantity: toDec(r.quantity).toString() }));
}

/** On hand less reserved and less expired or held lots: what of an item may be sold at a branch now. */
export async function sellableAt(db: Database, branchId: string, variantId: string): Promise<{ onHand: string; expiredOrHeld: string; sellable: string }> {
  const { rows: [b] } = await db.execute<{ quantity: string }>(sql`SELECT quantity::text FROM stock_balances WHERE branch_id = ${branchId} AND variant_id = ${variantId}`);
  const onHand = toDec(b?.quantity ?? '0');
  const blocked = (await unsellableAt(db, branchId, [variantId])).get(variantId) ?? new Dec(0);
  const reserved = (await reservedAt(db, branchId, [variantId])).get(variantId) ?? new Dec(0);
  return { onHand: onHand.toString(), expiredOrHeld: blocked.toString(), sellable: Dec.max(onHand.minus(reserved).minus(blocked), 0).toString() };
}
