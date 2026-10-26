import type { INestApplication } from '@nestjs/common';
import { DEFAULT_CHART } from '@1pos/accounting';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';

/**
 * Double-entry ledger (ADR-0013): every operational document posts one balanced entry in its own
 * transaction, and every GL balance equals the evidence it summarises (Phase 3 exit criterion).
 */
let app: INestApplication;
let owner: pg.Pool;
const http = () => request(app.getHttpServer());
type Auth = { Authorization: string };

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const b2 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string, price: string, extra: Record<string, unknown> = {}) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT, ...extra, variants: [{ sku: uniq('SKU'), price }] }).expect(201)).body.variants[0].id as string;
  const acct = await addMember(owner, t.tenantId, 'accountant');
  const mgr = await addMember(owner, t.tenantId, 'branch_manager', { type: 'BRANCH', id: b1 });
  return { tenantId: t.tenantId, auth, le, b1, b2, taxes, product, accountant: bearer(await loginToken(app, acct.email)), manager: bearer(await loginToken(app, mgr.email)) };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const idem = (s: Shop, path: string, body: unknown, auth: Auth = s.auth) => http().post(path).set(auth).set('Idempotency-Key', randomUUID()).send(body as object);
const gl = (s: Shop, key: string) =>
  asOwnerInTenant(owner, s.tenantId, async (c) =>
    (await c.query(`SELECT coalesce(sum(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.legal_entity_id = $1 AND a.system_key = $2`, [s.le, key])).rows[0].v as string,
  );
const one = (s: Shop, q: string, p: unknown[] = []) => asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(q, p)).rows[0].v as string);

describe('chart of accounts', () => {
  it('every new legal entity gets the default chart, the same list the migration back-fills', async () => {
    const s = await shop('gl-chart');
    const accounts = (await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.accountant).expect(200)).body.data as { systemKey: string; code: string; name: string; type: string }[];
    expect(accounts.map((a) => [a.systemKey, a.code, a.name, a.type]).sort()).toEqual(DEFAULT_CHART.map((a) => [a.key, a.code, a.name, a.type]).sort());
    const sql = ['0029_ledger_rls.sql', '0040_bills_checks_rls.sql', '0069_supplier_invoices_rls.sql', '0075_customers_rls.sql']
      .map((f) => readFileSync(new URL(`../../../../packages/database/drizzle/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    // 0116 took 2200 Service charge payable off the default chart (charts that took charges keep it).
    const seeded = [...sql.matchAll(/\('([A-Z_]+)', '(\d{4})', '([^']+)', '([A-Z]+)'\)/g)].map((m) => [m[1], m[2], m[3], m[4]]).filter(([key]) => key !== 'SERVICE_CHARGE_PAYABLE');
    expect(seeded.sort()).toEqual(DEFAULT_CHART.map((a) => [a.key, a.code, a.name, a.type]).sort());
    await http().post('/v1/accounts').set(s.accountant).send({ legalEntityId: s.le, code: '6100', name: 'Rent', type: 'EXPENSE' }).expect(201);
    expect((await http().post('/v1/accounts').set(s.accountant).send({ legalEntityId: s.le, code: '6100', name: 'Dup', type: 'EXPENSE' }).expect(409)).body.error.code).toBe('ACCOUNT_CODE_TAKEN');
    await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.manager).expect(403);
    const err = await asOwnerInTenant(owner, s.tenantId, (c) => c.query(`UPDATE accounts SET archived_at = now() WHERE system_key = 'SALES'`)).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/cannot be archived/);
  });
});

describe('a day in the books', () => {
  it('every document posts one balanced entry and every GL balance equals its evidence', async () => {
    const s = await shop('gl-day');
    const cola = await s.product('Cola', '22.40');
    const rice = await s.product('Rice', '56.00', { taxCategoryId: s.taxes.VAT_EXEMPT });
    const fee = await s.product('Delivery fee', '0.01', { productType: 'SERVICE', trackInventory: false });
    const supplier = (await http().post('/v1/suppliers').set(s.auth).send({ code: 'SUP', name: 'Supplier' }).expect(201)).body.id;

    // Purchasing: an order received in full, plus a direct receipt of a non-stock charge.
    const po = (await http().post('/v1/purchase-orders').set(s.auth).send({ branchId: s.b1, supplierId: supplier, lines: [{ variantId: cola, quantity: '20', unitCost: '12.00' }, { variantId: rice, quantity: '10', unitCost: '40.00' }] }).expect(201)).body;
    await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
    const receipt = (await idem(s, '/v1/goods-receipts', { branchId: s.b1, supplierId: supplier, purchaseOrderId: po.id, lines: po.lines.map((l: { id: string; variantId: string; quantity: string }) => ({ purchaseOrderLineId: l.id, variantId: l.variantId, quantity: l.quantity })) }).expect(201)).body;
    await idem(s, '/v1/goods-receipts', { branchId: s.b1, supplierId: supplier, lines: [{ variantId: fee, quantity: '1', unitCost: '150.00' }] }).expect(201);

    // Selling: cash, card, senior citizen; a return and a void; a pay-out.
    const reg = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.b1, code: 'R1', name: 'Counter' }).expect(201)).body.id;
    const session = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId: reg, openingFloat: '1000.00' }).expect(201)).body.id;
    const sell = (lines: unknown[], tenders: unknown[], extra: Record<string, unknown> = {}, clientTransactionId = randomUUID()) =>
      idem(s, '/v1/sales', { cashierSessionId: session, clientTransactionId, lines, tenders, ...extra }).expect(201).then((r) => r.body);
    const s1 = await sell([{ variantId: cola, quantity: '2' }, { variantId: rice, quantity: '1' }], [{ method: 'CASH', tendered: '200.00' }]);
    const tx = randomUUID();
    const card = (await idem(s, '/v1/payment-intents', { cashierSessionId: session, clientTransactionId: tx, method: 'CARD', amount: '22.40' }).expect(201)).body;
    await sell([{ variantId: cola, quantity: '1' }], [{ method: 'INTENT', paymentIntentId: card.id }], {}, tx);
    const sc = await sell([{ variantId: cola, quantity: '1', statutory: { scheme: 'SC', beneficiary: 'b' } }], [{ method: 'CASH', tendered: '20.00' }], { beneficiaries: [{ ref: 'b', scheme: 'SC', name: 'Lola', idNumber: 'OSCA-1' }] });
    await idem(s, `/v1/sales/${s1.id}/returns`, { cashierSessionId: session, kind: 'RETURN', reason: 'Dented', lines: [{ saleLineId: s1.lines[0].id, quantity: '1', disposition: 'RESTOCK' }] }).expect(201);
    await idem(s, `/v1/sales/${sc.id}/returns`, { cashierSessionId: session, kind: 'VOID', reason: 'Wrong item' }).expect(201);
    await http().post(`/v1/cashier-sessions/${session}/movements`).set(s.auth).send({ type: 'PAY_OUT', amount: '50.00', reason: 'Ice' }).expect(201);

    // Stock: waste, a count, a transfer received short, a supplier return.
    await http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.b1, kind: 'WASTE', reason: 'Torn bag', items: [{ variantId: rice, quantity: '-1' }] }).expect(201);
    await idem(s, '/v1/stock/counts', { branchId: s.b1, lines: [{ variantId: cola, countedQuantity: '17' }] }).expect(201);
    const t = (await idem(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: cola, quantity: '5' }] }).expect(201)).body;
    expect(await gl(s, 'INVENTORY_IN_TRANSIT')).toBe('60.0000');
    await idem(s, `/v1/stock/transfers/${t.id}/receive`, { lines: [{ transferLineId: t.lines[0].id, receivedQuantity: '4', discrepancyReason: 'Crushed case' }] }).expect(200);
    const riceLine = receipt.lines.find((l: { variantId: string }) => l.variantId === rice);
    await idem(s, '/v1/supplier-returns', { branchId: s.b1, supplierId: supplier, goodsReceiptId: receipt.id, reason: 'Weevils', lines: [{ goodsReceiptLineId: riceLine.id, variantId: rice, quantity: '1' }] }).expect(201);

    // Close the drawer ₱1.00 short.
    const expected = (await http().get(`/v1/cashier-sessions/${session}`).set(s.auth)).body.expectedCash as string;
    await http().post(`/v1/cashier-sessions/${session}/close`).set(s.auth).send({ countedCash: (Number(expected) - 1).toFixed(2) }).expect(200);

    // ---- one entry per document, every one balanced
    const perType = await asOwnerInTenant(owner, s.tenantId, async (c) =>
      Object.fromEntries((await c.query(`SELECT source_type, count(*)::int AS n FROM journal_entries GROUP BY 1`)).rows.map((r) => [r.source_type, r.n])),
    );
    expect(perType).toEqual({ GOODS_RECEIPT: 2, SALE: 3, SALE_RETURN: 2, CASH_MOVEMENT: 1, STOCK_ADJUSTMENT: 1, STOCK_COUNT: 1, TRANSFER_DISPATCH: 1, TRANSFER_RECEIPT: 1, SUPPLIER_RETURN: 1, CASH_VARIANCE: 1 });
    expect(await one(s, `SELECT count(*) AS v FROM (SELECT journal_entry_id FROM journal_lines GROUP BY 1 HAVING sum(debit) <> sum(credit)) x`)).toBe('0');
    const traced = (await http().get('/v1/journal-entries').query({ legalEntityId: s.le, sourceType: 'SALE', sourceId: s1.id }).set(s.accountant).expect(200)).body.data;
    expect(traced).toEqual([expect.objectContaining({ sourceType: 'SALE', sourceId: s1.id, total: expect.any(String) })]);

    // ---- every GL balance equals the evidence it summarises
    const ev = (q: string) => one(s, q);
    expect(cents(await gl(s, 'INVENTORY'))).toBe(cents(await ev(`SELECT coalesce(sum(value), 0) AS v FROM stock_balances`)));
    expect(cents(await gl(s, 'INVENTORY_IN_TRANSIT'))).toBe(0);
    expect(cents(await gl(s, 'CASH_ON_HAND'))).toBe(
      cents(await ev(`SELECT sum(amount) FILTER (WHERE type <> 'OPENING_FLOAT') + (SELECT sum(variance) FROM cash_reconciliations) AS v FROM cash_movements`)),
    );
    expect(cents(await gl(s, 'PAYMENT_CLEARING'))).toBe(cents(await ev(`SELECT (SELECT coalesce(sum(amount), 0) FROM sale_tenders WHERE method IN ('CARD', 'QR', 'EWALLET')) AS v`)));
    // Store credit (ADR-0018) is owed to customers: the liability is what the credit ledger says they hold.
    expect(cents(await gl(s, 'CUSTOMER_STORE_CREDIT')) + cents(await ev(`SELECT coalesce(sum(amount), 0) AS v FROM customer_credit_entries`))).toBe(0);
    expect(-cents(await gl(s, 'OUTPUT_VAT'))).toBe(cents(await ev(`SELECT (SELECT sum(vat_amount) FROM sales) - (SELECT coalesce(sum(vat_amount), 0) FROM sale_returns) AS v`)));
    const revenue = -(cents(await gl(s, 'SALES')) + cents(await gl(s, 'SALES_RETURNS')) + cents(await gl(s, 'STATUTORY_DISCOUNTS')));
    const byProduct = (await http().get('/v1/reports/by-product').query({ branchId: s.b1, from: localToday, to: localToday }).set(s.auth).expect(200)).body.data as { revenueExVat: string; cogs: string }[];
    expect(revenue).toBe(byProduct.reduce((a, p) => a + cents(p.revenueExVat), 0));
    expect(cents(await gl(s, 'COGS'))).toBe(byProduct.reduce((a, p) => a + cents(p.cogs), 0));
    expect(-cents(await gl(s, 'GRNI'))).toBe(
      cents(await ev(`SELECT (SELECT sum(quantity * unit_cost) FROM goods_receipt_lines) - (SELECT sum(quantity * credit_unit_cost) FROM supplier_return_lines) AS v`)),
    );
    expect(cents(await gl(s, 'INVENTORY_WASTE'))).toBe(-cents(await ev(`SELECT sum(value) AS v FROM stock_movements WHERE type = 'WASTE'`)));
    expect(cents(await gl(s, 'INVENTORY_ADJUSTMENTS'))).toBe(-cents(await ev(`SELECT sum(value) AS v FROM stock_movements WHERE type = 'COUNT'`)));
    expect(cents(await gl(s, 'TRANSIT_LOSS'))).toBe(1200); // one ₱12.00 cola lost in transit
    expect(cents(await gl(s, 'PURCHASES_NON_STOCK'))).toBe(15000);
    expect(cents(await gl(s, 'CASH_OVER_SHORT'))).toBe(100);
    expect(cents(await gl(s, 'CASH_TRANSFERS'))).toBe(5000);

    // ---- the trial balance balances
    const tb = (await http().get('/v1/reports/trial-balance').query({ legalEntityId: s.le, from: localToday, to: localToday }).set(s.accountant).expect(200)).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.totals.closing).toBe('0.00');
    expect(tb.data.find((r: { systemKey: string }) => r.systemKey === 'TRANSIT_LOSS')).toMatchObject({ debit: '12.00', closing: '12.00' });

    // ---- the accountant's export: every line, balanced per entry, the same totals as the trial balance
    const lines = (await http().get('/v1/journal-lines').query({ legalEntityId: s.le, from: localToday, to: localToday }).set(s.accountant).expect(200)).body.data as { entryNumber: number; accountCode: string; debit: string; credit: string }[];
    const byEntry = new Map<number, number>();
    for (const l of lines) byEntry.set(l.entryNumber, (byEntry.get(l.entryNumber) ?? 0) + cents(l.debit) - cents(l.credit));
    expect([...byEntry.values()].every((v) => v === 0)).toBe(true);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0)).toBe(cents(tb.totals.debit));
    expect(lines.every((l) => /^\d{4}$/.test(l.accountCode))).toBe(true);
    await http().get('/v1/journal-lines').query({ legalEntityId: s.le, from: '2025-01-01', to: '2026-06-30' }).set(s.accountant).expect(400); // over 366 days
    await http().get('/v1/journal-lines').query({ legalEntityId: s.le, from: localToday, to: localToday }).set(s.manager).expect(403); // no accounting.read
  });
});

describe('corrections and periods', () => {
  it('manual entries balance, reversals mirror once, nothing is ever edited', async () => {
    const s = await shop('gl-manual');
    const accounts = (await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.accountant)).body.data as { id: string; systemKey: string }[];
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const body = { legalEntityId: s.le, entryDate: localToday, memo: 'Owner funds the cash box', lines: [{ accountId: id('CASH_ON_HAND'), debit: '5000.00', branchId: s.b1 }, { accountId: id('CASH_TRANSFERS'), credit: '5000.00' }] };
    expect((await idem(s, '/v1/journal-entries', { ...body, lines: [body.lines[0], { ...body.lines[1], credit: '4999.99' }] }, s.accountant).expect(422)).body.error.code).toBe('UNBALANCED_ENTRY');
    await idem(s, '/v1/journal-entries', { ...body, lines: [{ accountId: id('CASH_ON_HAND'), debit: '1', credit: '1' }, body.lines[1]] }, s.accountant).expect(400);
    await idem(s, '/v1/journal-entries', body, s.manager).expect(403);
    const entry = (await idem(s, '/v1/journal-entries', body, s.accountant).expect(201)).body;
    expect(entry).toMatchObject({ sourceType: 'MANUAL', total: '5000.00', lines: [{ accountCode: '1010', debit: '5000.00', branchId: s.b1 }, { accountCode: '3900', credit: '5000.00' }] });

    const rev = (await idem(s, `/v1/journal-entries/${entry.id}/reverse`, { memo: 'Posted twice' }, s.accountant).expect(201)).body;
    expect(rev).toMatchObject({ sourceType: 'REVERSAL', reversesEntryId: entry.id, lines: [{ accountCode: '3900', debit: '5000.00' }, { accountCode: '1010', credit: '5000.00' }] });
    expect((await idem(s, `/v1/journal-entries/${entry.id}/reverse`, { memo: 'again' }, s.accountant).expect(409)).body.error.code).toBe('ALREADY_REVERSED');
    expect((await idem(s, `/v1/journal-entries/${rev.id}/reverse`, { memo: 'undo' }, s.accountant).expect(422)).body.error.code).toBe('CANNOT_REVERSE_REVERSAL');
    expect((await http().get(`/v1/journal-entries/${entry.id}`).set(s.accountant).expect(200)).body.reversedBy).toBe(rev.id);
    expect(cents(await gl(s, 'CASH_ON_HAND'))).toBe(0);
    for (const q of [`UPDATE journal_lines SET debit = 1`, `DELETE FROM journal_entries`]) {
      const e = await asOwnerInTenant(owner, s.tenantId, (c) => c.query(q)).then(() => null, (x: Error) => x.message);
      expect(e).toMatch(/append-only|not allowed|forbidden/i);
    }
  });

  it('the database refuses an unbalanced entry at commit, whoever writes it', async () => {
    const s = await shop('gl-backstop');
    const err = await asOwnerInTenant(owner, s.tenantId, async (c) => {
      const acc = (await c.query(`SELECT id FROM accounts WHERE system_key = 'SALES'`)).rows[0].id;
      const e = (await c.query(`INSERT INTO journal_entries (tenant_id, legal_entity_id, entry_number, entry_date, source_type, memo, created_by) VALUES ($1, $2, 999, current_date, 'MANUAL', 'x', $1) RETURNING id`, [s.tenantId, s.le])).rows[0].id;
      await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, debit) VALUES ($1, $2, $3, $4, 10)`, [s.tenantId, s.le, e, acc]);
    }).then(() => null, (x: Error) => x.message);
    expect(err).toMatch(/does not balance/);
  });

  it('a closed month takes no entries; the month in progress cannot be closed; reopening needs a reason', async () => {
    const s = await shop('gl-period');
    const accounts = (await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.accountant)).body.data as { id: string; systemKey: string }[];
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const thisMonth = localToday.slice(0, 7);
    const d = new Date(`${thisMonth}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const lastMonth = d.toISOString().slice(0, 7);
    expect((await http().post('/v1/accounting/periods/close').set(s.accountant).send({ legalEntityId: s.le, month: thisMonth }).expect(422)).body.error.code).toBe('PERIOD_IN_PROGRESS');
    await http().post('/v1/accounting/periods/close').set(s.accountant).send({ legalEntityId: s.le, month: lastMonth }).expect(200);
    const entry = { legalEntityId: s.le, entryDate: `${lastMonth}-15`, memo: 'Late accrual', lines: [{ accountId: id('INVENTORY_ADJUSTMENTS'), debit: '10.00' }, { accountId: id('INVENTORY'), credit: '10.00' }] };
    expect((await idem(s, '/v1/journal-entries', entry, s.accountant).expect(409)).body.error.code).toBe('PERIOD_CLOSED');
    await http().post('/v1/accounting/periods/reopen').set(s.accountant).send({ legalEntityId: s.le, month: lastMonth }).expect(400);
    await http().post('/v1/accounting/periods/reopen').set(s.accountant).send({ legalEntityId: s.le, month: lastMonth, reason: 'Supplier invoice found' }).expect(200);
    await idem(s, '/v1/journal-entries', entry, s.accountant).expect(201);
    const periods = (await http().get('/v1/accounting/periods').query({ legalEntityId: s.le }).set(s.accountant).expect(200)).body.data;
    expect(periods.find((p: { month: string }) => p.month === lastMonth)).toMatchObject({ status: 'OPEN' });
  });
});
