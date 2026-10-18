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
