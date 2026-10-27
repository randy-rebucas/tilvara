import { sql, type Database } from '@1pos/database';

/**
 * The products (of those given) with stock or stock value at any branch. Such a product keeps
 * tracking inventory: turned off, its later sales would post no cost and the balance and the
 * Inventory account would keep the old stock for good (audit 2026-10-27 #9).
 */
export async function productsWithStock(db: Database, productIds: string[]): Promise<Set<string>> {
  if (!productIds.length) return new Set();
  const { rows } = await db.execute<{ product_id: string }>(sql`
    SELECT DISTINCT v.product_id FROM stock_balances b
      JOIN product_variants v ON v.tenant_id = b.tenant_id AND v.id = b.variant_id
     WHERE v.product_id IN (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND (b.quantity <> 0 OR b.value <> 0)`);
  return new Set(rows.map((r) => r.product_id));
}
