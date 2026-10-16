import type pg from 'pg';

/**
 * Phase 3 exit criterion — "stock and financial movements remain traceable and consistent" —
 * written as SQL invariants over one tenant (run inside its tenant context). Each query returns
 * the violating rows; an empty result everywhere means:
 *
 *   movement → document: every stock movement belongs to exactly one source document;
 *   document → entry:    every document that moved value posted exactly one journal entry;
 *   entry → document:    every non-manual entry names a document that exists, in its own entity;
 *   value ties:          per document and branch, the entry's inventory lines equal the value of
 *                        that document's movements, and goods in transit clear when received.
 *
 * Also used against the dev database after migrations (scripts in the exit review).
 */
const DOCS = `
  WITH mv AS (
    SELECT m.id, m.branch_id, m.value,
           CASE m.type
             WHEN 'SALE' THEN 'SALE' WHEN 'CONSUMPTION' THEN 'SALE' WHEN 'RETURN' THEN 'SALE_RETURN' WHEN 'RECEIPT' THEN 'GOODS_RECEIPT'
             WHEN 'SUPPLIER_RETURN' THEN 'SUPPLIER_RETURN' WHEN 'TRANSFER_OUT' THEN 'TRANSFER_DISPATCH'
             WHEN 'TRANSFER_IN' THEN 'TRANSFER_RECEIPT' WHEN 'COUNT' THEN 'STOCK_COUNT'
             WHEN 'ADJUSTMENT' THEN 'STOCK_ADJUSTMENT' WHEN 'WASTE' THEN 'STOCK_ADJUSTMENT' END AS doc_type,
           CASE m.type
             WHEN 'SALE' THEN m.sale_id
             WHEN 'CONSUMPTION' THEN m.sale_id
             WHEN 'RETURN' THEN (SELECT sale_return_id FROM sale_return_lines WHERE id = m.sale_return_line_id)
             WHEN 'RECEIPT' THEN (SELECT goods_receipt_id FROM goods_receipt_lines WHERE id = m.goods_receipt_line_id)
             WHEN 'SUPPLIER_RETURN' THEN (SELECT supplier_return_id FROM supplier_return_lines WHERE id = m.supplier_return_line_id)
             WHEN 'TRANSFER_OUT' THEN (SELECT stock_transfer_id FROM stock_transfer_lines WHERE id = m.stock_transfer_line_id)
             WHEN 'TRANSFER_IN' THEN (SELECT stock_transfer_id FROM stock_transfer_lines WHERE id = m.stock_transfer_line_id)
             WHEN 'COUNT' THEN (SELECT stock_count_id FROM stock_count_lines WHERE id = m.stock_count_line_id)
             ELSE m.stock_adjustment_id END AS doc_id
      FROM stock_movements m),
  docs AS (
    SELECT 'SALE' AS doc_type, id AS doc_id, branch_id, amount_due AS amount FROM sales
    UNION ALL SELECT 'SALE_RETURN', id, branch_id, amount_due FROM sale_returns
    UNION ALL SELECT 'GOODS_RECEIPT', r.id, r.branch_id, (SELECT coalesce(sum(quantity * unit_cost), 0) FROM goods_receipt_lines WHERE goods_receipt_id = r.id) FROM goods_receipts r
    UNION ALL SELECT 'SUPPLIER_RETURN', r.id, r.branch_id, (SELECT coalesce(sum(quantity * credit_unit_cost), 0) FROM supplier_return_lines WHERE supplier_return_id = r.id) FROM supplier_returns r
    UNION ALL SELECT 'STOCK_ADJUSTMENT', id, branch_id, 0 FROM stock_adjustments
    UNION ALL SELECT 'STOCK_COUNT', id, branch_id, 0 FROM stock_counts
    UNION ALL SELECT 'TRANSFER_DISPATCH', id, from_branch_id, 0 FROM stock_transfers
    UNION ALL SELECT 'TRANSFER_RECEIPT', id, to_branch_id, 0 FROM stock_transfers WHERE status = 'RECEIVED'
    UNION ALL SELECT 'CASH_MOVEMENT', m.id, s.branch_id, m.amount FROM cash_movements m JOIN cashier_sessions s ON s.id = m.cashier_session_id WHERE m.type IN ('PAY_IN', 'PAY_OUT')
    UNION ALL SELECT 'CASH_VARIANCE', r.cashier_session_id, s.branch_id, r.variance FROM cash_reconciliations r JOIN cashier_sessions s ON s.id = r.cashier_session_id),
  inv AS (
    SELECT e.source_type AS doc_type, e.source_id AS doc_id, l.branch_id, sum(l.debit - l.credit) AS amount
      FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE a.system_key = 'INVENTORY' AND e.source_id IS NOT NULL GROUP BY 1, 2, 3)`;

export const TRACEABILITY_CHECKS: Record<string, string> = {
  'movement without a document': `${DOCS} SELECT id, doc_type FROM mv WHERE doc_type IS NULL OR doc_id IS NULL`,
  'movement whose document does not exist': `${DOCS} SELECT mv.id, mv.doc_type, mv.doc_id FROM mv LEFT JOIN docs d USING (doc_type, doc_id) WHERE d.doc_id IS NULL`,
  'document that moved value without exactly one entry': `${DOCS}
    SELECT d.doc_type, d.doc_id, count(e.id) AS entries
      FROM docs d LEFT JOIN journal_entries e ON e.source_type = d.doc_type AND e.source_id = d.doc_id
     WHERE d.amount <> 0 OR (SELECT coalesce(sum(value), 0) FROM mv WHERE mv.doc_type = d.doc_type AND mv.doc_id = d.doc_id) <> 0
     GROUP BY 1, 2 HAVING count(e.id) <> 1`,
  'entry whose document does not exist': `${DOCS}
    SELECT e.id, e.source_type, e.source_id FROM journal_entries e LEFT JOIN docs d ON d.doc_type = e.source_type AND d.doc_id = e.source_id
     WHERE e.source_type NOT IN ('MANUAL', 'REVERSAL') AND d.doc_id IS NULL`,
  'entry booked in another legal entity than its document': `${DOCS}
    SELECT e.id, e.source_type FROM journal_entries e JOIN docs d ON d.doc_type = e.source_type AND d.doc_id = e.source_id
      JOIN branches b ON b.id = d.branch_id WHERE b.legal_entity_id <> e.legal_entity_id`,
  'entry inventory ≠ its movements (per document and branch)': `${DOCS},
    moved AS (SELECT doc_type, doc_id, branch_id, sum(value) AS amount FROM mv GROUP BY 1, 2, 3)
    SELECT coalesce(m.doc_type, i.doc_type) AS doc_type, coalesce(m.doc_id, i.doc_id) AS doc_id, coalesce(m.branch_id, i.branch_id) AS branch_id,
           coalesce(m.amount, 0)::text AS movements, coalesce(i.amount, 0)::text AS inventory
      FROM moved m FULL JOIN inv i ON i.doc_type = m.doc_type AND i.doc_id = m.doc_id AND i.branch_id IS NOT DISTINCT FROM m.branch_id
     WHERE coalesce(m.amount, 0) <> coalesce(i.amount, 0)`,
  'goods in transit not cleared / not equal to what left': `
    SELECT t.id, t.status,
           (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
             WHERE a.system_key = 'INVENTORY_IN_TRANSIT' AND e.source_id = t.id AND e.source_type IN ('TRANSFER_DISPATCH', 'TRANSFER_RECEIPT'))::text AS transit,
           (SELECT coalesce(-sum(m.value), 0) FROM stock_movements m JOIN stock_transfer_lines x ON x.id = m.stock_transfer_line_id
             WHERE x.stock_transfer_id = t.id AND m.type = 'TRANSFER_OUT')::text AS sent
      FROM stock_transfers t`,
};

/** Rows for the transit check are filtered in JS (its expected value depends on the status). */
export async function traceabilityAudit(c: pg.PoolClient | pg.Client): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [name, q] of Object.entries(TRACEABILITY_CHECKS)) {
    let rows = (await c.query(q)).rows;
    if (name.startsWith('goods in transit')) {
      rows = rows.filter((r) => Number(r.transit) !== (r.status === 'RECEIVED' ? 0 : Number(r.sent)));
    }
    out[name] = rows;
  }
  return out;
}

export const CLEAN = Object.fromEntries(Object.keys(TRACEABILITY_CHECKS).map((k) => [k, []]));
