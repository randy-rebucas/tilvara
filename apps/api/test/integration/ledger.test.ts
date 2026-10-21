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
    const sql = ['0029_ledger_rls.sql', '0040_bills_checks_rls.sql', '0069_supplier_invoices_rls.sql', '0075_customers_rls.sql', '0092_counter_service_tips_rls.sql', '0099_salons_appointments_packages_rls.sql', '0102_lodging_rooms_folios_rls.sql', '0104_laundry_job_orders_rls.sql']
      .map((f) => readFileSync(new URL(`../../../../packages/database/drizzle/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    const seeded = [...sql.matchAll(/\('([A-Z_]+)', '(\d{4})', '([^']+)', '([A-Z]+)'\)/g)].map((m) => [m[1], m[2], m[3], m[4]]);
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
    expect(cents(await gl(s, 'PAYMENT_CLEARING'))).toBe(cents(await ev(`SELECT (SELECT coalesce(sum(amount), 0) FROM sale_tenders WHERE method IN ('CARD', 'QR', 'EWALLET'))
      + (SELECT coalesce(sum(amount), 0) FROM sale_tips WHERE method <> 'CASH') - (SELECT coalesce(sum(amount), 0) FROM sale_tip_refunds WHERE method = 'CARD') AS v`)));
    // Tips (session 25) are owed to staff: taken − given back on voids − paid out from drawers.
    expect(0 - cents(await gl(s, 'TIPS_PAYABLE'))).toBe(cents(await ev(`SELECT (SELECT coalesce(sum(amount), 0) FROM sale_tips) - (SELECT coalesce(sum(tip_refund), 0) FROM sale_returns)
      - (SELECT coalesce(sum(amount), 0) FROM sale_tip_refunds)
      + (SELECT coalesce(sum(amount), 0) FROM cash_movements WHERE type = 'TIP_PAYOUT') AS v`)));
    // Store credit (ADR-0018) is owed to customers: the liability is what the credit ledger says they hold.
    expect(cents(await gl(s, 'CUSTOMER_STORE_CREDIT')) + cents(await ev(`SELECT coalesce(sum(amount), 0) AS v FROM customer_credit_entries`))).toBe(0);
    // Service packages (ADR-0022) are owed until used: the liability is what the package ledger says is left.
    expect(cents(await gl(s, 'PREPAID_SERVICES')) + cents(await ev(`SELECT coalesce(sum(value), 0) AS v FROM customer_package_entries`))).toBe(0);
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

describe('a night at the hotel (ADR-0023)', () => {
  it('the guest ledger equals the open folios and the deposits account equals the deposits held', async () => {
    const s = await shop('gl-hotel');
    await http().patch('/v1/business').set(s.auth).send({ businessType: 'LODGING' }).expect(200);
    const type = (await idem(s, '/v1/room-types', { code: 'STD', name: 'Standard', rackRate: '2800.00' }).expect(201)).body;
    const room = (await idem(s, '/v1/rooms', { branchId: s.b1, roomTypeId: type.id, number: '101' }).expect(201)).body.id;
    const room2 = (await idem(s, '/v1/rooms', { branchId: s.b1, roomTypeId: type.id, number: '102' }).expect(201)).body.id;
    const reg = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.b1, code: 'FD', name: 'Front desk' }).expect(201)).body.id;
    const session = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId: reg, openingFloat: '1000.00' }).expect(201)).body.id;
    const guests = [{ fullName: 'Juan Dela Cruz' }];
    const stay = (await idem(s, '/v1/stays', { branchId: s.b1, roomId: room, arrivalDate: localToday, departureDate: new Date(Date.parse(localToday) + 2 * 86_400_000).toISOString().slice(0, 10), guests }).expect(201)).body;
    await idem(s, `/v1/stays/${stay.id}/deposits`, { method: 'CASH', cashierSessionId: session, amount: '1000.00' }).expect(201);
    await http().post(`/v1/stays/${stay.id}/check-in`).set(s.auth).send({}).expect(200);
    const dinner = await s.product('Dinner', '560.00', { productType: 'SERVICE', trackInventory: false });
    await idem(s, '/v1/sales', { cashierSessionId: session, clientTransactionId: randomUUID(), lines: [{ variantId: dinner, quantity: '1' }], tenders: [{ method: 'ROOM_CHARGE', stayId: stay.id }] }).expect(201);
    await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(s.auth).send({}).expect(200);
    const folioId = (await http().get(`/v1/stays/${stay.id}/folio`).set(s.auth).expect(200)).body.id;
    await idem(s, `/v1/folios/${folioId}/payments`, { method: 'CASH', cashierSessionId: session, tendered: '2000.00' }).expect(201);
    // A second booking holds its deposit.
    const later = (await idem(s, '/v1/stays', { branchId: s.b1, roomId: room2, arrivalDate: '2031-01-10', departureDate: '2031-01-12', guestName: 'Later' }).expect(201)).body;
    await idem(s, `/v1/stays/${later.id}/deposits`, { method: 'CASH', cashierSessionId: session, amount: '700.00' }).expect(201);

    const ev = (q: string) => one(s, q);
    expect(cents(await gl(s, 'GUEST_LEDGER'))).toBe(cents(await ev(`SELECT coalesce(sum(amount), 0) AS v FROM folio_entries`)));
    expect(cents(await gl(s, 'GUEST_LEDGER'))).toBe(560 * 100 + 2 * 280000 - 100000 - 200000);
    expect(-cents(await gl(s, 'GUEST_DEPOSITS'))).toBe(cents(await ev(`SELECT coalesce(sum(amount), 0) AS v FROM stay_deposits`)));
    expect(-cents(await gl(s, 'ROOM_REVENUE'))).toBe(cents(await ev(`SELECT sum(vatable_sales + vat_exempt_sales + zero_rated_sales + percentage_tax_sales) AS v FROM folio_entries WHERE kind = 'ROOM_NIGHT'`)));
    expect(cents(await gl(s, 'CASH_ON_HAND'))).toBe(
      cents(await ev(`SELECT sum(amount) FILTER (WHERE type <> 'OPENING_FLOAT') + coalesce((SELECT sum(variance) FROM cash_reconciliations), 0) AS v FROM cash_movements`)),
    );
    expect(-cents(await gl(s, 'OUTPUT_VAT'))).toBe(cents(await ev(`SELECT (SELECT coalesce(sum(vat_amount), 0) FROM sales) + (SELECT coalesce(sum(vat_amount), 0) FROM folio_entries WHERE vat_amount IS NOT NULL) AS v`)));
    const perType = await asOwnerInTenant(owner, s.tenantId, async (c) =>
      Object.fromEntries((await c.query(`SELECT source_type, count(*)::int AS n FROM journal_entries GROUP BY 1`)).rows.map((r) => [r.source_type, r.n])),
    );
    // Two nights, two deposits received and one applied, one payment, one sale charged to the room.
    expect(perType).toMatchObject({ FOLIO_ENTRY: 2, STAY_DEPOSIT: 3, FOLIO_PAYMENT: 1, SALE: 1 });
    const tb = (await http().get('/v1/reports/trial-balance').query({ legalEntityId: s.le, from: localToday, to: localToday }).set(s.accountant).expect(200)).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
    // Folio entries are corrected on the folio, never by reversing their journal entry.
    const [entry] = (await http().get('/v1/journal-entries').query({ legalEntityId: s.le, sourceType: 'FOLIO_ENTRY' }).set(s.accountant).expect(200)).body.data;
    expect((await idem(s, `/v1/journal-entries/${entry.id}/reverse`, { memo: "x" }, s.accountant).expect(422)).body.error.code).toBe("CANCEL_THE_DOCUMENT");
  });
});

describe('front desk money at another branch (ADR-0023 §5.2)', () => {
  it("a drawer at branch B takes a deposit and a folio payment for a stay at branch A: the cash is B's, the guest's accounts stay A's", async () => {
    const s = await shop('gl-hotel-b');
    await http().patch('/v1/business').set(s.auth).send({ businessType: 'LODGING' }).expect(200);
    const type = (await idem(s, '/v1/room-types', { code: 'STD', name: 'Standard', rackRate: '2800.00' }).expect(201)).body;
    const room = (await idem(s, '/v1/rooms', { branchId: s.b1, roomTypeId: type.id, number: '101' }).expect(201)).body.id;
    const reg = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.b2, code: 'FB', name: 'Front desk B' }).expect(201)).body.id;
    const session = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId: reg, openingFloat: '1000.00' }).expect(201)).body.id;
    const stay = (await idem(s, '/v1/stays', { branchId: s.b1, roomId: room, arrivalDate: localToday, departureDate: new Date(Date.parse(localToday) + 86_400_000).toISOString().slice(0, 10), guests: [{ fullName: 'Juan Dela Cruz' }] }).expect(201)).body;
    await idem(s, `/v1/stays/${stay.id}/deposits`, { method: 'CASH', cashierSessionId: session, amount: '1000.00' }).expect(201);
    await idem(s, `/v1/stays/${stay.id}/deposits/refund`, { amount: '200.00', reason: 'Asked back', refund: { method: 'CASH', cashierSessionId: session } }).expect(200);
    await http().post(`/v1/stays/${stay.id}/check-in`).set(s.auth).send({}).expect(200);
    await http().post(`/v1/stays/${stay.id}/prepare-check-out`).set(s.auth).send({}).expect(200);
    const folioId = (await http().get(`/v1/stays/${stay.id}/folio`).set(s.auth).expect(200)).body.id;
    await idem(s, `/v1/folios/${folioId}/payments`, { method: 'CASH', cashierSessionId: session, tendered: '2000.00' }).expect(201);
    const byBranch = await asOwnerInTenant(owner, s.tenantId, async (c) =>
      (await c.query(`SELECT a.system_key AS key, l.branch_id, sum(l.debit - l.credit)::text AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.journal_entry_id
                       WHERE e.source_type IN ('STAY_DEPOSIT', 'FOLIO_PAYMENT') AND a.system_key IN ('CASH_ON_HAND', 'GUEST_DEPOSITS', 'GUEST_LEDGER') GROUP BY 1, 2 ORDER BY 1, 2`)).rows as { key: string; branch_id: string; v: string }[]);
    // Cash: 1,000 in − 200 back + 2,000 paid at B. Deposits: 1,000 − 200 − 800 applied, all at A. Guest ledger: −800 applied − 2,000 paid at A.
    expect(byBranch.map((r) => [r.key, r.branch_id === s.b1 ? 'A' : r.branch_id === s.b2 ? 'B' : r.branch_id, cents(r.v)])).toEqual([
      ['CASH_ON_HAND', 'B', 280000], ['GUEST_DEPOSITS', 'A', 0], ['GUEST_LEDGER', 'A', -280000],
    ]);
    expect(cents(await gl(s, 'GUEST_LEDGER'))).toBe(cents(await one(s, `SELECT coalesce(sum(amount), 0) AS v FROM folio_entries`)));
  });
});

describe('a day at the laundry (ADR-0024)', () => {
  it('customer down payments on the books equal the down payments held; a claim, a refund and a forfeit each move them', async () => {
    const s = await shop('gl-laundry');
    await http().patch('/v1/business').set(s.auth).send({ businessType: 'LAUNDRY' }).expect(200);
    const wash = await s.product('Wash per load', '112.00', { productType: 'SERVICE', trackInventory: false });
    const reg = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.b1, code: 'LC', name: 'Counter' }).expect(201)).body.id;
    const session = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId: reg, openingFloat: '1000.00' }).expect(201)).body.id;
    const job = async (loads: string) => (await idem(s, '/v1/job-orders', { branchId: s.b1, customerName: 'Walk-in', lines: [{ variantId: wash, quantity: loads }] }).expect(201)).body;
    const pay = (id: string, body: object) => idem(s, `/v1/job-orders/${id}/deposits`, body).expect(201);
    // Claimed with its down payment applied.
    const claimed = await job('2');
    await pay(claimed.id, { method: 'CASH', cashierSessionId: session, amount: '100.00' });
    await http().post(`/v1/job-orders/${claimed.id}/status`).set(s.auth).send({ status: 'READY' }).expect(200);
    await idem(s, `/v1/job-orders/${claimed.id}/claim`, { cashierSessionId: session, clientTransactionId: randomUUID(), claimCode: claimed.claimCode, tenders: [{ method: 'CASH', tendered: '124.00' }] }).expect(201);
    // Still held on an open job, part by bank transfer; one refunded; one kept on a cancel.
    const open = await job('3');
    await pay(open.id, { method: 'BANK_TRANSFER', amount: '150.00', reference: 'BDO-9' });
    await idem(s, `/v1/job-orders/${open.id}/deposits/refund`, { amount: '50.00', reason: 'Asked back', refund: { method: 'CASH', cashierSessionId: session } }).expect(201);
    const kept = await job('1');
    await pay(kept.id, { method: 'CASH', cashierSessionId: session, amount: '56.00' });
    await idem(s, `/v1/job-orders/${kept.id}/cancel`, { reason: 'No-show', deposit: 'forfeit' }).expect(200);

    const ev = (q: string) => one(s, q);
    expect(-cents(await gl(s, 'CUSTOMER_DOWN_PAYMENTS'))).toBe(cents(await ev(`SELECT coalesce(sum(amount), 0) AS v FROM job_order_deposits`)));
    expect(-cents(await gl(s, 'CUSTOMER_DOWN_PAYMENTS'))).toBe(10000);
    expect([-cents(await gl(s, 'FORFEITED_DOWN_PAYMENTS')), -cents(await gl(s, 'SALES'))]).toEqual([5000, 20000]);
    expect(-cents(await gl(s, 'OUTPUT_VAT'))).toBe(cents(await ev(`SELECT (SELECT coalesce(sum(vat_amount), 0) FROM sales) + (SELECT coalesce(sum(vat_amount), 0) FROM job_order_deposits WHERE kind = 'FORFEITED') AS v`)));
    expect(cents(await gl(s, 'CASH_ON_HAND'))).toBe(
      cents(await ev(`SELECT sum(amount) FILTER (WHERE type <> 'OPENING_FLOAT') + coalesce((SELECT sum(variance) FROM cash_reconciliations), 0) AS v FROM cash_movements`)),
    );
    const perType = await asOwnerInTenant(owner, s.tenantId, async (c) =>
      Object.fromEntries((await c.query(`SELECT source_type, count(*)::int AS n FROM journal_entries GROUP BY 1`)).rows.map((r) => [r.source_type, r.n])),
    );
    // Three received, one refunded, one kept; the one applied is part of the claim sale.
    expect(perType).toMatchObject({ JOB_ORDER_DEPOSIT: 5, SALE: 1 });
    const [entry] = (await http().get('/v1/journal-entries').query({ legalEntityId: s.le, sourceType: 'JOB_ORDER_DEPOSIT' }).set(s.accountant).expect(200)).body.data;
    expect((await idem(s, `/v1/journal-entries/${entry.id}/reverse`, { memo: 'x' }, s.accountant).expect(422)).body.error.code).toBe('CANCEL_THE_DOCUMENT');
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
