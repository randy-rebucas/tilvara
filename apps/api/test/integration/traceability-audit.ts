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
 *                        that document's movements, and goods in transit clear when received;
 *   payables:            per supplier invoice, the books owe what it still owes and cleared the GRNI its receipts held;
 *   sub-ledgers:         per legal entity, store credit 2300 holds what
 *                        its sub-ledger rows add up to;
 *   expiry lots:         a lot = Σ its lot movements, and an item's lots ≤ max(on hand, 0) per branch.
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
             WHEN 'ADJUSTMENT' THEN 'STOCK_ADJUSTMENT' WHEN 'WASTE' THEN 'STOCK_ADJUSTMENT'
             WHEN 'UNPACK_OUT' THEN 'PACK_OPENING' WHEN 'UNPACK_IN' THEN 'PACK_OPENING' END AS doc_type,
           CASE m.type
             WHEN 'SALE' THEN m.sale_id
             WHEN 'CONSUMPTION' THEN m.sale_id
             WHEN 'RETURN' THEN (SELECT sale_return_id FROM sale_return_lines WHERE id = m.sale_return_line_id)
             WHEN 'RECEIPT' THEN (SELECT goods_receipt_id FROM goods_receipt_lines WHERE id = m.goods_receipt_line_id)
             WHEN 'SUPPLIER_RETURN' THEN (SELECT supplier_return_id FROM supplier_return_lines WHERE id = m.supplier_return_line_id)
             WHEN 'TRANSFER_OUT' THEN (SELECT stock_transfer_id FROM stock_transfer_lines WHERE id = m.stock_transfer_line_id)
             WHEN 'TRANSFER_IN' THEN (SELECT stock_transfer_id FROM stock_transfer_lines WHERE id = m.stock_transfer_line_id)
             WHEN 'COUNT' THEN (SELECT stock_count_id FROM stock_count_lines WHERE id = m.stock_count_line_id)
             WHEN 'UNPACK_OUT' THEN m.pack_opening_id WHEN 'UNPACK_IN' THEN m.pack_opening_id
             ELSE m.stock_adjustment_id END AS doc_id
      FROM stock_movements m),
  docs AS (
    SELECT 'SALE' AS doc_type, id AS doc_id, branch_id, amount_due AS amount FROM sales
    UNION ALL SELECT 'SALE_RETURN', id, branch_id, amount_due FROM sale_returns
    UNION ALL SELECT 'GOODS_RECEIPT', r.id, r.branch_id, (SELECT coalesce(sum(quantity * unit_cost), 0) FROM goods_receipt_lines WHERE goods_receipt_id = r.id) FROM goods_receipts r
    UNION ALL SELECT 'SUPPLIER_RETURN', r.id, r.branch_id, (SELECT coalesce(sum(quantity * credit_unit_cost), 0) FROM supplier_return_lines WHERE supplier_return_id = r.id) FROM supplier_returns r
    UNION ALL SELECT 'STOCK_ADJUSTMENT', id, branch_id, 0 FROM stock_adjustments
    UNION ALL SELECT 'STOCK_COUNT', id, branch_id, 0 FROM stock_counts
    UNION ALL SELECT 'PACK_OPENING', id, branch_id, 0 FROM pack_openings
    UNION ALL SELECT 'TRANSFER_DISPATCH', id, from_branch_id, 0 FROM stock_transfers
    UNION ALL SELECT 'TRANSFER_RECEIPT', id, to_branch_id, 0 FROM stock_transfers WHERE status = 'RECEIVED'
    UNION ALL SELECT 'CASH_MOVEMENT', m.id, s.branch_id, m.amount FROM cash_movements m JOIN cashier_sessions s ON s.id = m.cashier_session_id WHERE m.type IN ('PAY_IN', 'PAY_OUT')
    UNION ALL SELECT 'CASH_VARIANCE', r.cashier_session_id, s.branch_id, r.variance FROM cash_reconciliations r JOIN cashier_sessions s ON s.id = r.cashier_session_id
    UNION ALL SELECT 'SUPPLIER_INVOICE', id, branch_id, total_amount FROM supplier_invoices
    UNION ALL SELECT 'SUPPLIER_PAYMENT', id, branch_id, amount FROM supplier_payments
    UNION ALL SELECT 'SUPPLIER_NOTE', id, branch_id, total_amount FROM supplier_notes),
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
     -- JOB_ORDER_DEPOSIT: laundry down payments, whose documents migration 0110 dropped; FOLIO_ENTRY, FOLIO_PAYMENT
     -- and STAY_DEPOSIT: guest folios and deposits, whose documents migration 0111 dropped (the entries stay).
     WHERE e.source_type NOT IN ('MANUAL', 'REVERSAL', 'JOB_ORDER_DEPOSIT', 'FOLIO_ENTRY', 'FOLIO_PAYMENT', 'STAY_DEPOSIT') AND d.doc_id IS NULL`,
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
  // Payables (ADR-0013 amendment, sessions 16 and 22): per invoice, what its own entries (the invoice,
  // its reversal, its credit and debit notes) owe is its total adjusted by the notes, and the GRNI it
  // cleared is what its receipts held; a note's GRNI is what the note says it cleared.
  'supplier invoice whose payable or cleared GRNI disagrees with it': `
    WITH ent AS (
      SELECT i.id AS invoice_id, e.id AS entry_id FROM supplier_invoices i JOIN journal_entries e ON e.source_type = 'SUPPLIER_INVOICE' AND e.source_id = i.id
      UNION ALL SELECT i.id, r.id FROM supplier_invoices i JOIN journal_entries e ON e.source_type = 'SUPPLIER_INVOICE' AND e.source_id = i.id JOIN journal_entries r ON r.reverses_entry_id = e.id
      UNION ALL SELECT n.supplier_invoice_id, e.id FROM supplier_notes n JOIN journal_entries e ON e.source_type = 'SUPPLIER_NOTE' AND e.source_id = n.id),
    books AS (
      SELECT ent.invoice_id, sum(l.credit - l.debit) FILTER (WHERE a.system_key = 'ACCOUNTS_PAYABLE') AS payable,
             sum(l.debit - l.credit) FILTER (WHERE a.system_key = 'GRNI' AND e.source_type = 'SUPPLIER_INVOICE') AS grni,
             sum(l.credit - l.debit) FILTER (WHERE a.system_key = 'GRNI' AND e.source_type = 'SUPPLIER_NOTE') AS note_grni
        FROM ent JOIN journal_entries e ON e.id = ent.entry_id JOIN journal_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
       GROUP BY 1)
    SELECT i.id, i.status, coalesce(b.payable, 0)::text AS payable, coalesce(b.grni, 0)::text AS grni
      FROM supplier_invoices i LEFT JOIN books b ON b.invoice_id = i.id
     WHERE coalesce(b.payable, 0) <> CASE WHEN i.status = 'CANCELLED' THEN 0
             ELSE i.total_amount + (SELECT coalesce(sum(CASE n.kind WHEN 'DEBIT' THEN n.total_amount ELSE -n.total_amount END), 0) FROM supplier_notes n WHERE n.supplier_invoice_id = i.id) END
        OR coalesce(b.grni, 0) <> i.matched_amount
        OR coalesce(b.note_grni, 0) <> (SELECT coalesce(sum(grni_cleared), 0) FROM supplier_notes n WHERE n.supplier_invoice_id = i.id)
        OR i.matched_amount <> (SELECT coalesce(sum(matched_amount), 0) FROM supplier_invoice_receipts x WHERE x.supplier_invoice_id = i.id)`,
  // Per payment: its allocations add up to it, it pays no more than an invoice owes, and its entry
  // (with the void's reversal) takes off the payables exactly what it settles.
  'supplier payment whose allocations or payables disagree with it': `
    WITH ent AS (
      SELECT p.id AS payment_id, e.id AS entry_id FROM supplier_payments p JOIN journal_entries e ON e.source_type = 'SUPPLIER_PAYMENT' AND e.source_id = p.id
      UNION ALL SELECT p.id, r.id FROM supplier_payments p JOIN journal_entries e ON e.source_type = 'SUPPLIER_PAYMENT' AND e.source_id = p.id JOIN journal_entries r ON r.reverses_entry_id = e.id),
    books AS (
      SELECT ent.payment_id, sum(l.debit - l.credit) FILTER (WHERE a.system_key = 'ACCOUNTS_PAYABLE') AS settled
        FROM ent JOIN journal_lines l ON l.journal_entry_id = ent.entry_id JOIN accounts a ON a.id = l.account_id GROUP BY 1)
    SELECT p.id, p.amount::text, coalesce(b.settled, 0)::text AS settled
      FROM supplier_payments p LEFT JOIN books b ON b.payment_id = p.id
     WHERE p.amount <> (SELECT coalesce(sum(amount), 0) FROM supplier_payment_allocations a WHERE a.supplier_payment_id = p.id)
        OR coalesce(b.settled, 0) <> CASE WHEN p.voided_at IS NULL THEN p.amount ELSE 0 END
    UNION ALL
    SELECT i.id, i.total_amount::text, 'overpaid' FROM supplier_invoices i
     WHERE i.total_amount + (SELECT coalesce(sum(CASE n.kind WHEN 'DEBIT' THEN n.total_amount ELSE -n.total_amount END), 0) FROM supplier_notes n WHERE n.supplier_invoice_id = i.id)
         < (SELECT coalesce(sum(a.amount), 0) FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.supplier_payment_id WHERE a.supplier_invoice_id = i.id AND p.voided_at IS NULL)`,
  // Balance-sheet accounts kept by a sub-ledger (audit 2026-10-21 §3): per legal entity, the books hold
  // exactly what the sub-ledger rows add up to. Balances as credit − debit. (The guest ledger 1150 and guest
  // deposits 2320 lost their sub-ledgers with lodging in 0111: their balances stay in the books, unchecked.
  // Tips 2210 and prepaid service packages 2310 left the books with their rows in 0113.)
  'balance-sheet account ≠ its sub-ledger (per legal entity)': `
    WITH gl AS (
      SELECT a.system_key, a.legal_entity_id, sum(l.credit - l.debit) AS balance
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE a.system_key = 'CUSTOMER_STORE_CREDIT'
       GROUP BY 1, 2),
    sub AS (
      SELECT 'CUSTOMER_STORE_CREDIT' AS system_key, legal_entity_id, sum(amount) AS balance FROM customer_credit_entries GROUP BY 2)
    SELECT coalesce(g.system_key, s.system_key) AS account, coalesce(g.legal_entity_id, s.legal_entity_id) AS legal_entity_id,
           coalesce(g.balance, 0)::text AS books, coalesce(s.balance, 0)::text AS sub_ledger
      FROM gl g FULL JOIN sub s ON s.system_key = g.system_key AND s.legal_entity_id = g.legal_entity_id
     WHERE coalesce(g.balance, 0) <> coalesce(s.balance, 0)`,
  // Expiry lots (ADR-0020): a lot holds what its movements put in and took out, and the lots of an item
  // never hold more than the branch has on hand (nothing when it is below zero).
  'lot whose quantity ≠ its movements, or lots above the stock on hand': `
    SELECT l.id, 'lot ≠ its movements' AS problem, l.quantity::text AS lots, coalesce(m.quantity, 0)::text AS on_hand
      FROM stock_lots l LEFT JOIN (SELECT lot_id, sum(quantity) AS quantity FROM stock_lot_movements GROUP BY 1) m ON m.lot_id = l.id
     WHERE l.quantity <> coalesce(m.quantity, 0)
    UNION ALL
    SELECT l.variant_id, 'lots above on hand', sum(l.quantity)::text, coalesce(max(b.quantity), 0)::text
      FROM stock_lots l LEFT JOIN stock_balances b ON b.branch_id = l.branch_id AND b.variant_id = l.variant_id
     GROUP BY l.branch_id, l.variant_id HAVING sum(l.quantity) > greatest(coalesce(max(b.quantity), 0), 0)`,
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
