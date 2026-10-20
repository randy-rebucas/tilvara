import { HttpStatus } from '@nestjs/common';
import { inventorySettings, sql, type Database, type NegativeStockPolicy } from '@1pos/database';
import { Dec, toDec } from '@1pos/money';
import { AppError } from '../infrastructure/http-error.filter.js';
import { reservedAt } from '../inventory/reservations.service.js';

/** The branch's negative-stock policy (a branch without settings: ALLOW, as before the policy existed). */
export async function negativeStockPolicy(db: Database, branchId: string): Promise<NegativeStockPolicy> {
  const [row] = await db
    .select({ policy: inventorySettings.negativeStockPolicy })
    .from(inventorySettings)
    .where(sql`${inventorySettings.branchId} = ${branchId}`);
  return row?.policy ?? 'ALLOW';
}

/**
 * BLOCK: refuse a counter sale that would take a tracked item below zero, before anything is written.
 * The balance rows are locked (in variant order, as the costing trigger will lock them a moment later
 * in this transaction), so two tills selling the last unit cannot both pass.
 */
export async function assertStockAvailable(db: Database, branchId: string, lines: { variantId: string; quantity: string; name: string }[]): Promise<void> {
  if (lines.length === 0 || (await negativeStockPolicy(db, branchId)) !== 'BLOCK') return;
  const need = new Map<string, { quantity: Dec; name: string }>();
  for (const l of lines) {
    const prev = need.get(l.variantId);
    need.set(l.variantId, { quantity: (prev?.quantity ?? new Dec(0)).plus(l.quantity), name: l.name });
  }
  const ids = [...need.keys()].sort();
  const { rows } = await db.execute<{ variant_id: string; quantity: string }>(
    sql`SELECT variant_id, quantity::text FROM app_lock_stock_balances(${branchId}, ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[])`,
  );
  // Units reserved for someone else are not for sale (session 20): available = on hand − reserved.
  const reserved = await reservedAt(db, branchId, ids);
  const short = ids.flatMap((variantId) => {
    const onHand = toDec(rows.find((r) => r.variant_id === variantId)?.quantity ?? '0');
    const held = reserved.get(variantId) ?? new Dec(0);
    const { quantity, name } = need.get(variantId)!;
    return quantity.gt(onHand.minus(held)) ? [{ variantId, name, onHand: onHand.toString(), reserved: held.toString(), requested: quantity.toString() }] : [];
  });
  if (short.length > 0) {
    throw new AppError(
      'INSUFFICIENT_STOCK',
      `Not enough stock: ${short.map((s) => `${s.name} (${s.onHand} on hand${s.reserved !== '0' ? `, ${s.reserved} reserved` : ''})`).join(', ')}`,
      HttpStatus.CONFLICT,
      { lines: short },
    );
  }
}
