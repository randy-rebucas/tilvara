import { sql, type Database } from '@1pos/database';

/** Why a product must keep tracking stock. */
export type StockHeldReason = 'STOCK' | 'IN_TRANSIT' | 'ON_COUNT_SHEET';

/**
 * The products (of those given) that must keep tracking inventory, and why: stock or stock value at any branch,
 * a dispatched transfer not yet received, or a line on an open count sheet. Turned off, its later sales would
 * post no cost, and a receipt or a count of it would land stock and value no document could clear: the balance
 * and the Inventory account would keep them for good (audits 2026-10-27 #9, 2026-10-31 #7).
 *
 * With `lock` (inside the write that stops tracking), it first locks the products' rows (so a transfer, count or
 * sheet checking `trackInventory` waits, then sees the change; `assertStocked`) and their stock balances at every
 * branch (`app_lock_stock_balances`, so no movement lands between the check and the change).
 */
export async function productsWithStock(db: Database, productIds: string[], opts: { lock?: boolean } = {}): Promise<Map<string, StockHeldReason>> {
  const held = new Map<string, StockHeldReason>();
  if (!productIds.length) return held;
  const ids = [...new Set(productIds)].sort();
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  if (opts.lock) {
    await db.execute(sql`SELECT id FROM products WHERE id IN (${list}) ORDER BY id FOR UPDATE`);
    const { rows: at } = await db.execute<{ branch_id: string; variant_ids: string[] }>(sql`
      SELECT b.branch_id, array_agg(b.variant_id ORDER BY b.variant_id)::text[] AS variant_ids FROM stock_balances b
        JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
       WHERE v.product_id IN (${list})
       GROUP BY b.branch_id ORDER BY b.branch_id`);
    for (const r of at) {
      await db.execute(sql`SELECT count(*) FROM app_lock_stock_balances(${r.branch_id}, ARRAY[${sql.join(r.variant_ids.map((v) => sql`${v}`), sql`, `)}]::uuid[])`);
    }
  }
  const { rows } = await db.execute<{ product_id: string; reason: StockHeldReason }>(sql`
    SELECT DISTINCT ON (product_id) product_id, reason FROM (
      SELECT v.product_id, 'STOCK' AS reason, 1 AS rank FROM stock_balances b
        JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
       WHERE v.product_id IN (${list}) AND (b.quantity <> 0 OR b.value <> 0)
      UNION ALL
      SELECT v.product_id, 'IN_TRANSIT', 2 FROM stock_transfer_lines l
        JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.stock_transfer_id
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
       WHERE v.product_id IN (${list}) AND t.status = 'DISPATCHED'
      UNION ALL
      SELECT v.product_id, 'ON_COUNT_SHEET', 3 FROM stock_count_sheet_lines l
        JOIN stock_count_sheets s ON s.tenant_id = l.tenant_id AND s.id = l.sheet_id
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
       WHERE v.product_id IN (${list}) AND s.status = 'OPEN'
    ) x ORDER BY product_id, rank`);
  for (const r of rows) held.set(r.product_id, r.reason);
  return held;
}

/** The words for a product that must keep tracking stock. */
export const stockHeldMessage: Record<StockHeldReason, string> = {
  STOCK: 'Count or write off its stock at every branch first',
  IN_TRANSIT: 'Receive its transfers in transit first',
  ON_COUNT_SHEET: 'Post or cancel the open count sheets listing it first',
};
