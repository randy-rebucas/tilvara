import { sql } from '@1pos/database';

/**
 * Where each return's money went (audit 2026-10-21 §3): a refund can be split between the customer's
 * store credit (ADR-0018, the sale's credit share), the guest's folio (ADR-0023, CHARGE_RETURN) and
 * cash for the rest, while `sale_returns.refund_method` names only one way. One row per (return, way)
 * with a non-zero amount (a return of nothing keeps one row under its refund method, so counts hold).
 * The same split as the return's own `refunds` (`ReturnsService.refundParts`).
 *
 * `where` filters `sale_returns r`. Columns: `sale_return_id`, `method`, `amount` (positive = refunded).
 */
export const refundParts = (where: ReturnType<typeof sql>) => sql`
  SELECT r.id AS sale_return_id, p.method, p.amount
    FROM sale_returns r
   CROSS JOIN LATERAL (
         SELECT coalesce((SELECT sum(c.amount) FROM customer_credit_entries c WHERE c.sale_return_id = r.id AND c.kind = 'RETURN'), 0) AS credit,
                coalesce((SELECT -sum(e.amount) FROM folio_entries e WHERE e.sale_return_id = r.id AND e.kind = 'CHARGE_RETURN'), 0) AS folio) k
   CROSS JOIN LATERAL (VALUES ('STORE_CREDIT'::text, k.credit), ('ROOM_CHARGE'::text, k.folio), ('CASH'::text, r.amount_due - k.credit - k.folio)) p(method, amount)
   WHERE (${where}) AND (p.amount <> 0 OR (r.amount_due = 0 AND p.method = r.refund_method))`;
