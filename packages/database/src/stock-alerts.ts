import type { PoolClient } from 'pg';

/**
 * Who looks after stock at a branch (stock alerts, session 16): active members holding
 * inventory.adjust or purchasing.manage for the whole business, the branch's legal entity or the
 * branch itself. Run inside the event's tenant (RLS), as the worker.
 */
export async function stockKeepers(client: PoolClient, branchId: string): Promise<{ email: string; name: string }[]> {
  const { rows } = await client.query<{ email: string; name: string }>(
    `SELECT DISTINCT u.email, u.display_name AS name
       FROM branches br
       JOIN tenant_memberships m ON m.tenant_id = br.tenant_id AND m.status = 'ACTIVE'
       JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
       JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
       JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.archived_at IS NULL
       JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
      WHERE br.id = $1 AND rp.permission_code IN ('inventory.adjust', 'purchasing.manage')
        AND (mr.scope_type = 'TENANT'
             OR (mr.scope_type = 'LEGAL_ENTITY' AND mr.scope_id = br.legal_entity_id)
             OR (mr.scope_type = 'BRANCH' AND mr.scope_id = br.id))
      ORDER BY u.email`,
    [branchId],
  );
  return rows;
}

/** The mail for a stock alert event (`stock.low` / `stock.below_zero`), or null when the item is not visible. */
export async function stockAlertMail(
  client: PoolClient,
  topic: 'stock.low' | 'stock.below_zero',
  payload: Record<string, unknown>,
): Promise<{ subject: string; text: string } | null> {
  const { rows: [item] } = await client.query<{ branch: string; sku: string; name: string }>(
    `SELECT br.name AS branch, v.sku, p.name
       FROM branches br, product_variants v JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      WHERE br.id = $1 AND v.id = $2`,
    [String(payload.branchId ?? ''), String(payload.variantId ?? '')],
  );
  if (!item) return null;
  const quantity = String(payload.quantity ?? '');
  return topic === 'stock.low'
    ? {
        subject: `Low stock at ${item.branch}: ${item.name}`,
        text: `${item.name} (${item.sku}) at ${item.branch} is down to ${quantity}, at or below its reorder point of ${String(payload.reorderPoint ?? '')}. Low stock in the back office lists what to order.`,
      }
    : {
        subject: `Sold below zero at ${item.branch}: ${item.name}`,
        text: `${item.name} (${item.sku}) at ${item.branch} went below zero (${quantity}) with a ${String(payload.movementType ?? 'stock')} movement. The shelf and the books disagree: count it, or record the delivery that is missing.`,
      };
}

/**
 * The mail for `stock.expiring` (ADR-0020 §3): the branch's lots that are expired or expire within its
 * window, soonest first (at most 30 lines), or null when the branch is not visible.
 */
export async function expiryAlertMail(client: PoolClient, payload: Record<string, unknown>): Promise<{ subject: string; text: string } | null> {
  const days = Number.isInteger(payload.withinDays) ? Number(payload.withinDays) : 30;
  const { rows: [branch] } = await client.query<{ name: string; timezone: string }>(`SELECT name, timezone FROM branches WHERE id = $1`, [String(payload.branchId ?? '')]);
  if (!branch) return null;
  const { rows } = await client.query<{ name: string; sku: string; expires_on: string; lot_code: string | null; quantity: string; days_left: number }>(
    `SELECT concat_ws(' ', p.name, v.name) AS name, v.sku, l.expires_on::text, l.lot_code, trim_scale(l.quantity)::text AS quantity,
            (l.expires_on - (now() AT TIME ZONE $2)::date)::int AS days_left
       FROM stock_lots l
       JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
       JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      WHERE l.branch_id = $1 AND l.quantity > 0 AND l.expires_on <= (now() AT TIME ZONE $2)::date + $3::int
      ORDER BY l.expires_on, p.name
      LIMIT 31`,
    [String(payload.branchId), branch.timezone, days],
  );
  if (rows.length === 0) return null;
  const lines = rows.slice(0, 30).map(
    (r) => `- ${r.name} (${r.sku})${r.lot_code ? `, lot ${r.lot_code}` : ''}: ${r.quantity}, ${r.days_left < 0 ? `expired ${r.expires_on}` : `expires ${r.expires_on}`}`,
  );
  return {
    subject: `Expiring stock at ${branch.name}`,
    text: [
      `These items at ${branch.name} are expired or expire within ${days} days:`,
      ...lines,
      ...(rows.length > 30 ? ['…and more. Inventory → Expiry in the back office lists them all.'] : []),
      'Sell them first, or write off what has expired in Inventory → Expiry.',
    ].join('\n'),
  };
}

/**
 * A sale that drew expired or held stock where it is blocked (ADR-0025 §4): an offline sale recorded at
 * sync, or a recipe's consumption. Read from the sale's lot draws; null when there are none.
 */
export async function expiredSoldMail(client: PoolClient, payload: Record<string, unknown>): Promise<{ subject: string; text: string } | null> {
  const { rows: [sale] } = await client.query<{ sale_number: number; branch: string; code: string }>(
    `SELECT s.sale_number, b.name AS branch, r.code FROM sales s JOIN branches b ON b.id = s.branch_id JOIN registers r ON r.id = s.register_id WHERE s.id = $1`,
    [String(payload.saleId ?? '')],
  );
  if (!sale) return null;
  const { rows } = await client.query<{ name: string; sku: string; lot_code: string | null; expires_on: string; quantity: string }>(
    `SELECT concat_ws(' ', p.name, v.name) AS name, v.sku, l.lot_code, l.expires_on::text, trim_scale(-sum(lm.quantity))::text AS quantity
       FROM stock_movements m
       JOIN stock_lot_movements lm ON lm.tenant_id = m.tenant_id AND lm.movement_id = m.id AND lm.expired
       JOIN stock_lots l ON l.tenant_id = lm.tenant_id AND l.id = lm.lot_id
       JOIN product_variants v ON v.tenant_id = m.tenant_id AND v.id = m.variant_id
       JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      WHERE m.sale_id = $1 AND m.type IN ('SALE', 'CONSUMPTION')
      GROUP BY 1, 2, 3, 4 ORDER BY 1`,
    [String(payload.saleId)],
  );
  if (rows.length === 0) return null;
  const reference = `${sale.code}-${String(sale.sale_number).padStart(6, '0')}`;
  return {
    subject: `Expired or held stock sold at ${sale.branch}`,
    text: [
      `Sale ${reference} at ${sale.branch} took stock that is expired or on hold:`,
      ...rows.map((r) => `- ${r.name} (${r.sku})${r.lot_code ? `, lot ${r.lot_code}` : ''}, expiry ${r.expires_on}: ${r.quantity}`),
      'Check the sale with the pharmacist, and write off or return what is left of these lots.',
    ].join('\n'),
  };
}
