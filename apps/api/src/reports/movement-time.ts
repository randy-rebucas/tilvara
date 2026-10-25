import { sql } from '@1pos/database';

/**
 * When a stock movement counts in a report. A sale's movements (SALE, CONSUMPTION before 0112, and the packs it
 * opened) count when the sale happened (`sales.completed_at`): an offline sale is delivered later, and
 * the ledger books it, its revenue and its cost on the day it was rung. Every other movement counts
 * when it was written. Use with `movementSaleJoin` on `stock_movements m`.
 *
 * A movement is never written before its sale's time (offline sale times are clamped to the delivery),
 * so `m.created_at >= start` may still prune rows for a window's lower bound.
 */
export const movementSaleJoin = sql`LEFT JOIN sales ms ON m.type IN ('SALE', 'CONSUMPTION', 'UNPACK_OUT', 'UNPACK_IN') AND ms.id = m.sale_id`;
export const movementAt = sql`coalesce(ms.completed_at, m.created_at)`;
