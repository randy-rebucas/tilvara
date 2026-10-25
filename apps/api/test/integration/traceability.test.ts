import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwnerInTenant, bearer, createApp, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Phase 3 exit review — traceability both ways: document ↔ stock movement ↔ journal entry, for
 * every document type, over a mixed day; then the audit is shown to catch a broken link.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

async function day() {
  const t = await signup(app, 'trace');
  const auth = bearer(t.access);
  const idem = (path: string, body: unknown) => http().post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body as object);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Trace Corp', vatStatus: 'VAT' }).expect(201)).body.id as string;
  const b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const b2 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const cola = await product('Cola', '22.40');
  const rice = await product('Rice', '56.00', { taxCategoryId: taxes.VAT_EXEMPT });
  const soap = await product('Soap', '35.00');
  const fee = await product('Delivery fee', '0.01', { productType: 'SERVICE', trackInventory: false });

  // A multi-item opening adjustment: three movements, one document, one entry.
  const opening = (await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b1, reason: 'Opening', items: [{ variantId: cola, quantity: '30', unitCost: '11.00' }, { variantId: rice, quantity: '10', unitCost: '41.00' }, { variantId: soap, quantity: '12', unitCost: '20.00' }] }).expect(201)).body;
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b1, kind: 'WASTE', reason: 'Rats', items: [{ variantId: rice, quantity: '-1' }, { variantId: soap, quantity: '-2' }] }).expect(201);

  const supplier = (await http().post('/v1/suppliers').set(auth).send({ code: 'SUP', name: 'Supplier' }).expect(201)).body.id;
  const po = (await http().post('/v1/purchase-orders').set(auth).send({ branchId: b1, supplierId: supplier, lines: [{ variantId: cola, quantity: '24', unitCost: '12.50' }] }).expect(201)).body;
  await http().post(`/v1/purchase-orders/${po.id}/approve`).set(auth).expect(200);
  const receipt = (await idem('/v1/goods-receipts', { branchId: b1, supplierId: supplier, purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0].id, variantId: cola, quantity: '20', rejectedQuantity: '4', rejectionReason: 'Dented' }, { variantId: fee, quantity: '1', unitCost: '80.00' }] }).expect(201)).body;
  await idem('/v1/supplier-returns', { branchId: b1, supplierId: supplier, goodsReceiptId: receipt.id, reason: 'Leaking', lines: [{ goodsReceiptLineId: receipt.lines.find((l: { variantId: string }) => l.variantId === cola).id, variantId: cola, quantity: '2' }] }).expect(201);
  await idem('/v1/supplier-returns', { branchId: b1, supplierId: supplier, reason: 'Recall', lines: [{ variantId: soap, quantity: '1' }] }).expect(201);

  const reg = (await http().post('/v1/registers').set(auth).send({ branchId: b1, code: 'R1', name: 'Counter' }).expect(201)).body.id;
  const session = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: reg, openingFloat: '500.00' }).expect(201)).body.id;
  const sell = (lines: unknown[], tendered: string) => idem('/v1/sales', { cashierSessionId: session, clientTransactionId: randomUUID(), lines, tenders: [{ method: 'CASH', tendered }] }).expect(201).then((r) => r.body);
  const s1 = await sell([{ variantId: cola, quantity: '3' }, { variantId: soap, quantity: '1' }, { variantId: fee, quantity: '1' }], '200.00');
  const s2 = await sell([{ variantId: rice, quantity: '2' }], '120.00');
  await idem(`/v1/sales/${s1.id}/returns`, { cashierSessionId: session, kind: 'RETURN', reason: 'Wrong', lines: [{ saleLineId: s1.lines[0].id, quantity: '1', disposition: 'RESTOCK' }, { saleLineId: s1.lines[1].id, quantity: '1', disposition: 'DAMAGED' }] }).expect(201);
  await idem(`/v1/sales/${s2.id}/returns`, { cashierSessionId: session, kind: 'VOID', reason: 'Mistake' }).expect(201);
  await http().post(`/v1/cashier-sessions/${session}/movements`).set(auth).send({ type: 'PAY_IN', amount: '100.00', reason: 'Change fund' }).expect(201);

  // A count with one equal line and one variance; a transfer received short; one still in transit.
  const bal = async (v: string) => (await http().get('/v1/stock/balances').query({ branchId: b1, variantId: v }).set(auth)).body.data[0].quantity as string;
  await idem('/v1/stock/counts', { branchId: b1, lines: [{ variantId: rice, countedQuantity: await bal(rice) }, { variantId: soap, countedQuantity: '5' }] }).expect(201);
  const tr = (await idem('/v1/stock/transfers', { fromBranchId: b1, toBranchId: b2, lines: [{ variantId: cola, quantity: '6' }, { variantId: soap, quantity: '1' }] }).expect(201)).body;
  await idem(`/v1/stock/transfers/${tr.id}/receive`, { lines: [{ transferLineId: tr.lines.find((l: { variantId: string }) => l.variantId === cola).id, receivedQuantity: '5', discrepancyReason: 'Crushed' }] }).expect(200);
  await idem('/v1/stock/transfers', { fromBranchId: b1, toBranchId: b2, lines: [{ variantId: rice, quantity: '1' }] }).expect(201);

  const expected = (await http().get(`/v1/cashier-sessions/${session}`).set(auth)).body.expectedCash as string;
  await http().post(`/v1/cashier-sessions/${session}/close`).set(auth).send({ countedCash: (Number(expected) + 2).toFixed(2) }).expect(200);
  return { t, auth, le, b1, opening };
}

/** A Manila date `days` from today (branches default to Asia/Manila). */
const manila = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + days * 86_400_000));

/**
 * A HYBRID business's day with every sub-ledger kept beside the books (audit 2026-10-21 §3): store credit
 * given back and spent, a service package sold and one session used, cash tips taken, given back by a
 * void and paid out, and an item that keeps expiry dates sold and returned.
 */
async function serviceDay() {
  const t = await signup(app, 'trace-svc');
  const auth = bearer(t.access);
  const idem = (path: string, body: unknown) => http().post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body as object);
  await http().patch('/v1/business').set(auth).send({ businessType: 'HYBRID' }).expect(200);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: 'Trace Services Corp', vatStatus: 'VAT' }).expect(201)).body.id as string;
  const b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const reg = (await http().post('/v1/registers').set(auth).send({ branchId: b1, code: 'R1', name: 'Front' }).expect(201)).body.id as string;
  const session = (await http().post('/v1/cashier-sessions').set(auth).send({ registerId: reg, openingFloat: '5000.00' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const uoms = (await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[];
  const pc = uoms.find((u) => u.code === 'PC')!.id;
  const product = async (body: Record<string, unknown>, variant: Record<string, unknown>) =>
    (await http().post('/v1/products').set(auth).send({ uomId: pc, taxCategoryId: vat, ...body, variants: [{ sku: uniq('SKU'), ...variant }] }).expect(201)).body.variants[0].id as string;
  const cola = await product({ name: 'Cola', tracksExpiry: true }, { price: '22.40' });
  const cut = await product({ name: 'Haircut', productType: 'SERVICE' }, { price: '560.00', serviceMinutes: 30 });
  const bundle = await product({ name: 'Five cuts', productType: 'PACKAGE' }, { price: '2800.00', packageValidDays: 90 });
  await http().put(`/v1/variants/${bundle}/package-items`).set(auth).send({ items: [{ serviceVariantId: cut, sessions: 5 }] }).expect(200);
  await idem('/v1/stock/adjustments', { branchId: b1, reason: 'Opening', items: [{ variantId: cola, quantity: '10', unitCost: '11.00', expiresOn: manila(60) }] }).expect(201);
  const customer = (await http().post('/v1/customers').set(auth).send({ displayName: 'Liza Reyes' }).expect(201)).body.id as string;
  const sell = (body: Record<string, unknown>) =>
    idem('/v1/sales', { cashierSessionId: session, clientTransactionId: randomUUID(), tenders: [{ method: 'CASH', tendered: '5000.00' }], ...body }).expect(201).then((r) => r.body);
  const giveBack = (saleId: string, body: Record<string, unknown>) => idem(`/v1/sales/${saleId}/returns`, { cashierSessionId: session, reason: 'Changed mind', ...body }).expect(201);

  // Store credit: one cola back as credit, ₱10 of it spent.
  const a = await sell({ customerId: customer, lines: [{ variantId: cola, quantity: '2' }] });
  await giveBack(a.id, { kind: 'RETURN', refundTo: 'STORE_CREDIT', lines: [{ saleLineId: a.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] });
  await sell({ customerId: customer, lines: [{ variantId: cola, quantity: '1' }], tenders: [{ method: 'STORE_CREDIT', amount: '10.00' }, { method: 'CASH', tendered: '20.00' }] });
  // A package of five cuts (₱2,500 ex VAT), one session used.
  await sell({ customerId: customer, lines: [{ variantId: bundle, quantity: '1' }] });
  const [pkg] = (await http().get(`/v1/customers/${customer}/packages`).query({ open: 'true' }).set(auth).expect(200)).body.data;
  await sell({ customerId: customer, lines: [{ variantId: cut, quantity: '1', packageId: pkg.id }], tenders: [{ method: 'CASH', tendered: '0.00' }] });
  // Tips: ₱50 kept, ₱10 given back by a void, ₱20 paid out.
  await sell({ lines: [{ variantId: cola, quantity: '1' }], tip: { amount: '50.00' } });
  const tipped = await sell({ lines: [{ variantId: cut, quantity: '1' }], tip: { amount: '10.00' } });
  await giveBack(tipped.id, { kind: 'VOID' });
  await http().post(`/v1/cashier-sessions/${session}/movements`).set(auth).send({ type: 'TIP_PAYOUT', amount: '20.00', reason: 'Tips to staff' }).expect(201);

  return { tenantId: t.tenantId, auth, le, b1 };
}

describe('traceability (Phase 3 exit criterion)', () => {
  it('every movement has its document, every document of value its one entry, every entry its document; values tie per document and branch', async () => {
    const d = await day();
    expect(await asOwnerInTenant(owner, d.t.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);

    // Each document type is present, so the audit above was not vacuous.
    const types = await asOwnerInTenant(owner, d.t.tenantId, async (c) => (await c.query(`SELECT DISTINCT source_type FROM journal_entries ORDER BY 1`)).rows.map((r) => r.source_type));
    expect(types).toEqual(['CASH_MOVEMENT', 'CASH_VARIANCE', 'GOODS_RECEIPT', 'SALE', 'SALE_RETURN', 'STOCK_ADJUSTMENT', 'STOCK_COUNT', 'SUPPLIER_RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT']);

    // Through the API, both ways, for the multi-item adjustment (the defect this review fixed):
    // the document lists all its movements, and its id finds its one entry.
    const adj = (await http().get(`/v1/stock/adjustments/${d.opening.id}`).set(d.auth).expect(200)).body;
    expect(adj).toMatchObject({ kind: 'ADJUSTMENT', reason: 'Opening', value: '980.00' });
    expect(adj.lines).toHaveLength(3);
    const entries = (await http().get('/v1/journal-entries').query({ legalEntityId: d.le, sourceId: d.opening.id }).set(d.auth).expect(200)).body.data;
    expect(entries).toEqual([expect.objectContaining({ sourceType: 'STOCK_ADJUSTMENT', total: '980.00' })]);
    const movements = (await http().get('/v1/stock/movements').query({ branchId: d.b1 }).set(d.auth)).body.data as { type: string; stockAdjustmentId: string | null }[];
    expect(movements.filter((m) => m.type === 'ADJUSTMENT').every((m) => m.stockAdjustmentId === d.opening.id)).toBe(true);
    // Opening, the rats, and the damaged return's write-off (ADR-0011 amendment).
    const adjustments = (await http().get('/v1/stock/adjustments').query({ branchId: d.b1 }).set(d.auth).expect(200)).body.data as { kind: string; reason: string }[];
    expect(adjustments).toHaveLength(3);
    expect(adjustments.filter((a) => a.kind === 'WASTE' && a.reason.startsWith('Damaged on return'))).toHaveLength(1);
  });

  it('every entry opens its document through the API (the admin links each journal line to it)', async () => {
    const d = await day();
    const READ: Record<string, (id: string) => string> = {
      SALE: (id) => `/v1/sales/${id}`,
      SALE_RETURN: (id) => `/v1/sale-returns/${id}`,
      CASH_MOVEMENT: (id) => `/v1/cash-movements/${id}`,
      CASH_VARIANCE: (id) => `/v1/cashier-sessions/${id}`,
      GOODS_RECEIPT: (id) => `/v1/goods-receipts/${id}`,
      SUPPLIER_RETURN: (id) => `/v1/supplier-returns/${id}`,
      STOCK_ADJUSTMENT: (id) => `/v1/stock/adjustments/${id}`,
      STOCK_COUNT: (id) => `/v1/stock/counts/${id}`,
      TRANSFER_DISPATCH: (id) => `/v1/stock/transfers/${id}`,
      TRANSFER_RECEIPT: (id) => `/v1/stock/transfers/${id}`,
    };
    const entries = (await http().get('/v1/journal-entries').query({ legalEntityId: d.le }).set(d.auth).expect(200)).body.data as { sourceType: string; sourceId: string }[];
    expect(new Set(entries.map((e) => e.sourceType))).toEqual(new Set(Object.keys(READ)));
    for (const e of entries) {
      const doc = await http().get(READ[e.sourceType]!(e.sourceId)).set(d.auth);
      expect([e.sourceType, doc.status]).toEqual([e.sourceType, 200]);
      expect(doc.body.id).toBe(e.sourceId);
    }
    // A return names its sale, a pay-in its shift, so the admin can open the right page.
    const ret = entries.find((e) => e.sourceType === 'SALE_RETURN')!;
    expect((await http().get(`/v1/sale-returns/${ret.sourceId}`).set(d.auth)).body.saleId).toBeTruthy();
    const pay = (await http().get(`/v1/cash-movements/${entries.find((e) => e.sourceType === 'CASH_MOVEMENT')!.sourceId}`).set(d.auth)).body;
    expect(pay).toMatchObject({ type: 'PAY_IN', amount: '100.00', reason: 'Change fund' });
    const shift = (await http().get(`/v1/cashier-sessions/${pay.cashierSessionId}`).set(d.auth)).body;
    expect(shift.payInOut).toMatchObject([{ id: pay.id, type: 'PAY_IN', amount: '100.00' }]);
  });

  it('the balance-sheet sub-ledgers (store credit, packages, tips) and the expiry lots tie to the books', async () => {
    const d = await serviceDay();
    expect(await asOwnerInTenant(owner, d.tenantId, (c) => traceabilityAudit(c))).toEqual(CLEAN);
    // Not vacuous: every account carries a balance, and the lots moved.
    const balances = await asOwnerInTenant(owner, d.tenantId, async (c) => Object.fromEntries((await c.query(`
      SELECT a.system_key, sum(l.credit - l.debit)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE a.system_key IN ('CUSTOMER_STORE_CREDIT', 'PREPAID_SERVICES', 'TIPS_PAYABLE') GROUP BY 1`)).rows.map((r) => [r.system_key, Number(r.v)])));
    expect(balances).toEqual({
      CUSTOMER_STORE_CREDIT: 12.4, // 22.40 back as credit − 10.00 spent
      PREPAID_SERVICES: 2000, // 2,500 sold − one 500 session
      TIPS_PAYABLE: 30, // 50 + 10 taken − 10 given back by the void − 20 paid out
    });
    const lots = await asOwnerInTenant(owner, d.tenantId, async (c) => (await c.query(`SELECT trim_scale(l.quantity)::text AS q, (SELECT count(*)::int FROM stock_lot_movements m WHERE m.lot_id = l.id) AS n FROM stock_lots l`)).rows);
    expect(lots).toEqual([{ q: '7', n: 5 }]); // 10 in, 2 + 1 + 1 sold, 1 back
  });

  it('the audit is not vacuous: an entry pointing nowhere, or one whose inventory differs from its movements, is reported', async () => {
    const d = await day();
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [d.t.tenantId]);
      const acc = Object.fromEntries((await c.query(`SELECT system_key, id FROM accounts WHERE legal_entity_id = $1`, [d.le])).rows.map((r) => [r.system_key, r.id]));
      const post = async (sourceType: string, sourceId: string, amount: string) => {
        const e = (await c.query(`INSERT INTO journal_entries (tenant_id, legal_entity_id, entry_number, entry_date, source_type, source_id, memo, created_by)
          VALUES ($1, $2, 9000 + (SELECT count(*) FROM journal_entries), current_date, $3, $4, 'tamper', $1) RETURNING id`, [d.t.tenantId, d.le, sourceType, sourceId])).rows[0].id;
        await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, branch_id, debit) VALUES ($1, $2, $3, $4, $5, $6)`, [d.t.tenantId, d.le, e, acc.INVENTORY, d.b1, amount]);
        await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, credit) VALUES ($1, $2, $3, $4, $5)`, [d.t.tenantId, d.le, e, acc.INVENTORY_ADJUSTMENTS, amount]);
      };
      await post('GOODS_RECEIPT', randomUUID(), '10.00');
      // Store credit booked with no credit entry behind it; a lot no movement filled, above what is on hand.
      const manual = (await c.query(`INSERT INTO journal_entries (tenant_id, legal_entity_id, entry_number, entry_date, source_type, memo, created_by)
        VALUES ($1, $2, 9500, current_date, 'MANUAL', 'tamper', $1) RETURNING id`, [d.t.tenantId, d.le])).rows[0].id;
      await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, debit) VALUES ($1, $2, $3, $4, 5)`, [d.t.tenantId, d.le, manual, acc.CASH_ON_HAND]);
      await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, credit) VALUES ($1, $2, $3, $4, 5)`, [d.t.tenantId, d.le, manual, acc.CUSTOMER_STORE_CREDIT]);
      await c.query(`INSERT INTO stock_lots (tenant_id, branch_id, variant_id, expires_on, quantity)
        SELECT tenant_id, branch_id, variant_id, current_date + 30, quantity + 1 FROM stock_balances WHERE branch_id = $1 AND quantity > 0 LIMIT 1`, [d.b1]);
      const found = await traceabilityAudit(c);
      expect(found['entry whose document does not exist']).toHaveLength(1);
      expect(found['entry inventory ≠ its movements (per document and branch)']).toHaveLength(1);
      expect(found['balance-sheet account ≠ its sub-ledger (per legal entity)']).toEqual([{ account: 'CUSTOMER_STORE_CREDIT', legal_entity_id: d.le, books: '5.0000', sub_ledger: '0' }]);
      expect(found['lot whose quantity ≠ its movements, or lots above the stock on hand']!.map((r) => (r as { problem: string }).problem).sort()).toEqual(['lot ≠ its movements', 'lots above on hand']);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
