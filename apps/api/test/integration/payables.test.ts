import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/** Supplier invoices, payments and payables aging (ADR-0013 amendment, session 16). */
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

/** A Manila calendar day, `offset` days from today. */
const day = (offset = 0) => new Date(Date.now() + 8 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);

async function shop(prefix: string, vatStatus: 'VAT' | 'NON_VAT' = 'VAT') {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus }).expect(201)).body.id as string;
  const branchId = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const taxes = Object.fromEntries(((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).map((x) => [x.code, x.id]));
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const product = async (name: string) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: taxes.VAT ?? taxes.VAT_EXEMPT, variants: [{ sku: uniq('SKU'), price: '50.00' }] }).expect(201)).body.variants[0].id as string;
  const cola = await product('Cola');
  const rice = await product('Rice');
  const supplier = async (code: string, paymentTermsDays = 30) => (await http().post('/v1/suppliers').set(auth).send({ code, name: `${code} Trading`, paymentTermsDays }).expect(201)).body.id as string;
  const supplierId = await supplier('COKE');
  const acct = await addMember(owner, t.tenantId, 'accountant');
  const io = await addMember(owner, t.tenantId, 'inventory_officer', { type: 'BRANCH', id: branchId });
  const c = await addMember(owner, t.tenantId, 'cashier', { type: 'BRANCH', id: branchId });
  return {
    tenantId: t.tenantId,
    auth,
    le,
    branchId,
    cola,
    rice,
    supplier,
    supplierId,
    accountant: bearer(await loginToken(app, acct.email)),
    officer: bearer(await loginToken(app, io.email)),
    cashier: bearer(await loginToken(app, c.email)),
  };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const receive = async (s: Shop, lines: { variantId: string; quantity: string; unitCost: string }[], supplierId = s.supplierId) =>
  (await http().post('/v1/goods-receipts').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.branchId, supplierId, lines }).expect(201)).body as {
    id: string;
    lines: { id: string; variantId: string }[];
  };
const invoice = (s: Shop, body: Record<string, unknown>, auth: Auth = s.auth, key = randomUUID()) =>
  http().post('/v1/supplier-invoices').set(auth).set('Idempotency-Key', key).send({ supplierId: s.supplierId, invoiceDate: day(), ...body });
const pay = (id: string, body: Record<string, unknown>, auth: Auth) =>
  http().post(`/v1/supplier-invoices/${id}/payments`).set(auth).set('Idempotency-Key', randomUUID()).send({ paidOn: day(), method: 'BANK_TRANSFER', ...body });
const cancel = (id: string, auth: Auth, reason = 'Entered twice') =>
  http().post(`/v1/supplier-invoices/${id}/cancel`).set(auth).set('Idempotency-Key', randomUUID()).send({ reason });
const uninvoiced = async (s: Shop) =>
  ((await http().get('/v1/uninvoiced-receipts').query({ branchId: s.branchId, supplierId: s.supplierId }).set(s.auth).expect(200)).body.data as { id: string; uninvoicedAmount: string }[]).map((r) => [r.id, r.uninvoicedAmount]);
/** Net per system account of one journal entry. */
const entryNet = async (s: Shop, entryId: string) => {
  const e = (await http().get(`/v1/journal-entries/${entryId}`).set(s.auth).expect(200)).body as { lines: { systemKey: string; debit: string; credit: string }[] };
  return Object.fromEntries(e.lines.map((l) => [l.systemKey, (Number(l.debit) - Number(l.credit)).toFixed(2)]));
};
const audit = (s: Shop) => asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c));

describe('supplier invoices', () => {
  it('clear the GRNI the receipts still hold, claim input VAT, owe the total; the rest is a price variance', async () => {
    const s = await shop('ap-inv');
    const r1 = await receive(s, [{ variantId: s.cola, quantity: '10', unitCost: '12.00' }]);
    const r2 = await receive(s, [{ variantId: s.rice, quantity: '5', unitCost: '40.00' }]);
    // One cola goes back before the invoice arrives: r1 now holds ₱108.00 of GRNI.
    await http().post('/v1/supplier-returns').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ branchId: s.branchId, supplierId: s.supplierId, goodsReceiptId: r1.id, reason: 'Dented', lines: [{ goodsReceiptLineId: r1.lines[0]!.id, variantId: s.cola, quantity: '1' }] }).expect(201);
    expect(await uninvoiced(s)).toEqual([[r1.id, '108.00'], [r2.id, '200.00']]);

    const inv = (await invoice(s, { invoiceNumber: 'SI-5001', goodsReceiptIds: [r2.id, r1.id], netAmount: '310.00', vatAmount: '37.20' }).expect(201)).body;
    expect(inv).toMatchObject({
      entryNumber: 1, invoiceNumber: 'SI-5001', invoiceDate: day(), dueDate: day(30), status: 'OPEN',
      netAmount: '310.00', vatAmount: '37.20', totalAmount: '347.20', matchedAmount: '308.00', inputVat: '37.20', priceVariance: '2.00',
      paidAmount: '0.00', balance: '347.20', supplier: { code: 'COKE' },
    });
    expect(inv.receipts.map((r: { goodsReceiptId: string; matchedAmount: string }) => [r.goodsReceiptId, r.matchedAmount]).sort()).toEqual([[r1.id, '108.00'], [r2.id, '200.00']].sort());
    expect(await entryNet(s, inv.journalEntryId)).toEqual({ GRNI: '308.00', INPUT_VAT: '37.20', PURCHASE_PRICE_VARIANCE: '2.00', ACCOUNTS_PAYABLE: '-347.20' });
    expect(await uninvoiced(s)).toEqual([]);

    // A receipt is on one open invoice at a time; a supplier's invoice number once among open invoices.
    const r3 = await receive(s, [{ variantId: s.cola, quantity: '1', unitCost: '12.00' }]);
    const again = await invoice(s, { invoiceNumber: 'SI-5002', goodsReceiptIds: [r1.id, r3.id], netAmount: '1.00', vatAmount: '0' }).expect(409);
    expect(again.body.error).toMatchObject({ code: 'RECEIPT_ALREADY_INVOICED', details: { goodsReceiptIds: [r1.id] } });
    expect((await invoice(s, { invoiceNumber: 'si-5001', goodsReceiptIds: [r3.id], netAmount: '12.00', vatAmount: '1.44' }).expect(409)).body.error.code).toBe('INVOICE_NUMBER_TAKEN');
    // Another supplier's receipt, a future date, an unknown receipt.
    const other = await s.supplier('PEPSI');
    const r4 = await receive(s, [{ variantId: s.cola, quantity: '1', unitCost: '11.00' }], other);
    expect((await invoice(s, { invoiceNumber: 'SI-5003', goodsReceiptIds: [r3.id, r4.id], netAmount: '23.00', vatAmount: '0' }).expect(422)).body.error).toMatchObject({ code: 'RECEIPT_MISMATCH', details: { goodsReceiptIds: [r4.id] } });
    expect((await invoice(s, { invoiceNumber: 'SI-5003', invoiceDate: day(2), goodsReceiptIds: [r3.id], netAmount: '12.00', vatAmount: '0' }).expect(422)).body.error.code).toBe('DATE_IN_FUTURE');
    await invoice(s, { invoiceNumber: 'SI-5003', goodsReceiptIds: [randomUUID()], netAmount: '12.00', vatAmount: '0' }).expect(404);
    await invoice(s, { invoiceNumber: 'SI-5003', goodsReceiptIds: [r3.id, r3.id], netAmount: '12.00', vatAmount: '0' }).expect(400);
    await invoice(s, { invoiceNumber: 'SI-5003', goodsReceiptIds: [r3.id], netAmount: '12.005', vatAmount: '0' }).expect(400);
    expect(await asOwnerInTenant(owner, s.tenantId, async (c) => Number((await c.query('SELECT count(*) AS n FROM supplier_invoices')).rows[0].n))).toBe(1);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('are paid from the bank up to their balance, then cannot be cancelled', async () => {
    const s = await shop('ap-pay');
    const r = await receive(s, [{ variantId: s.cola, quantity: '10', unitCost: '10.00' }]);
    const inv = (await invoice(s, { invoiceNumber: 'A-1', goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;

    const p1 = (await pay(inv.id, { amount: '50.00', reference: 'BDO 7781' }, s.accountant).expect(201)).body;
    expect(p1).toMatchObject({ status: 'OPEN', paidAmount: '50.00', balance: '62.00', payments: [{ paymentNumber: 1, amount: '50.00', method: 'BANK_TRANSFER', reference: 'BDO 7781' }] });
    expect((await pay(inv.id, { amount: '62.01' }, s.accountant).expect(422)).body.error).toMatchObject({ code: 'OVERPAYMENT', details: { balance: '62.00' } });
    expect((await pay(inv.id, { amount: '1.00', paidOn: day(-1) }, s.accountant).expect(422)).body.error.code).toBe('PAID_BEFORE_INVOICE');
    expect((await pay(inv.id, { amount: '1.00', paidOn: day(1) }, s.accountant).expect(422)).body.error.code).toBe('DATE_IN_FUTURE');
    await pay(inv.id, { amount: '0' }, s.accountant).expect(400);
    const paid = (await pay(inv.id, { amount: '62.00', method: 'CHECK' }, s.accountant).expect(201)).body;
    expect(paid).toMatchObject({ status: 'PAID', paidAmount: '112.00', balance: '0.00' });
    expect((await pay(inv.id, { amount: '0.01' }, s.accountant).expect(422)).body.error.code).toBe('OVERPAYMENT');
    expect((await cancel(inv.id, s.auth).expect(409)).body.error.code).toBe('INVOICE_HAS_PAYMENTS');

    // Each payment posted AP against the bank, and opens from its journal entry.
    const entries = (await http().get('/v1/journal-entries').query({ legalEntityId: s.le, sourceType: 'SUPPLIER_PAYMENT' }).set(s.auth).expect(200)).body.data as { id: string; sourceId: string; total: string }[];
    expect(entries.map((e) => e.total).sort()).toEqual(['50.00', '62.00']);
    expect(await entryNet(s, entries.find((e) => e.total === '50.00')!.id)).toEqual({ ACCOUNTS_PAYABLE: '50.00', CASH_IN_BANK: '-50.00' });
    const payment = (await http().get(`/v1/supplier-payments/${entries[0]!.sourceId}`).set(s.auth).expect(200)).body;
    expect(payment).toMatchObject({ id: entries[0]!.sourceId, supplierInvoiceId: inv.id, invoiceNumber: 'A-1' });

    expect((await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le, status: 'PAID' }).set(s.auth).expect(200)).body.data).toMatchObject([{ id: inv.id, status: 'PAID', balance: '0.00' }]);
    expect((await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le, status: 'OPEN' }).set(s.auth).expect(200)).body.data).toEqual([]);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('two payments of the whole balance at once: one is recorded, the other refused', async () => {
    const s = await shop('ap-race');
    const r = await receive(s, [{ variantId: s.cola, quantity: '1', unitCost: '100.00' }]);
    const inv = (await invoice(s, { invoiceNumber: 'R-1', goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    const res = await Promise.all([pay(inv.id, { amount: '112.00' }, s.accountant), pay(inv.id, { amount: '112.00' }, s.auth)]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 422]);
    expect((await http().get(`/v1/supplier-invoices/${inv.id}`).set(s.auth).expect(200)).body).toMatchObject({ paidAmount: '112.00', balance: '0.00', payments: [{ amount: '112.00' }] });
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('cancelling an unpaid invoice reverses its entry and frees its receipts and its number', async () => {
    const s = await shop('ap-cancel');
    const r = await receive(s, [{ variantId: s.cola, quantity: '4', unitCost: '25.00' }]);
    const inv = (await invoice(s, { invoiceNumber: 'C-9', goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    const done = (await cancel(inv.id, s.officer, 'Wrong quantities').expect(200)).body;
    expect(done).toMatchObject({ status: 'CANCELLED', cancelReason: 'Wrong quantities', reversalEntryId: expect.any(String), receipts: [{ goodsReceiptId: r.id, active: false }] });
    expect(await entryNet(s, done.reversalEntryId)).toEqual({ GRNI: '-100.00', INPUT_VAT: '-12.00', ACCOUNTS_PAYABLE: '112.00' });
    expect((await cancel(inv.id, s.auth).expect(409)).body.error.code).toBe('INVALID_STATE');
    expect((await pay(inv.id, { amount: '1.00' }, s.accountant).expect(409)).body.error.code).toBe('INVALID_STATE');
    expect(await uninvoiced(s)).toEqual([[r.id, '100.00']]);
    // Entered again, correctly, under the same supplier number.
    const fixed = (await invoice(s, { invoiceNumber: 'C-9', goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    expect(fixed).toMatchObject({ entryNumber: 2, status: 'OPEN' });
    expect((await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le, status: 'CANCELLED' }).set(s.auth).expect(200)).body.data).toMatchObject([{ id: inv.id }]);
    // Each status filter returns exactly its own invoices (the filter runs before the list's limit).
    expect((await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le, status: 'OPEN' }).set(s.auth).expect(200)).body.data).toMatchObject([{ id: fixed.id, status: 'OPEN' }]);
    expect((await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le, status: 'PAID' }).set(s.auth).expect(200)).body.data).toEqual([]);
    // Its entry is undone by cancelling the invoice, never by a reversal by hand (the invoice would stay open).
    const byHand = await http().post(`/v1/journal-entries/${fixed.journalEntryId}/reverse`).set(s.auth).set('Idempotency-Key', randomUUID()).send({ memo: 'Oops' }).expect(422);
    expect(byHand.body.error.code).toBe('CANCEL_THE_DOCUMENT');

    // The database keeps the rules whoever writes: no reopening, no editing amounts, no deleting.
    const tryAs = (q: string) => asOwnerInTenant(owner, s.tenantId, (c) => c.query(q)).then(() => null, (e: Error) => e.message);
    expect(await tryAs(`UPDATE supplier_invoices SET status = 'OPEN', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = '${inv.id}'`)).toMatch(/only goes from OPEN to CANCELLED/);
    expect(await tryAs(`UPDATE supplier_invoices SET net_amount = 1, total_amount = 13 WHERE id = '${fixed.id}'`)).toMatch(/only goes from OPEN to CANCELLED/);
    expect(await tryAs(`DELETE FROM supplier_invoices WHERE id = '${fixed.id}'`)).toMatch(/never deleted/);
    expect(await tryAs(`UPDATE supplier_invoice_receipts SET active = false WHERE supplier_invoice_id = '${fixed.id}'`)).toMatch(/only when its invoice is cancelled/);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('a non-VAT entity claims no input VAT: the VAT it pays is cost', async () => {
    const s = await shop('ap-nonvat', 'NON_VAT');
    const r = await receive(s, [{ variantId: s.cola, quantity: '10', unitCost: '11.20' }]);
    const inv = (await invoice(s, { invoiceNumber: 'N-1', goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    expect(inv).toMatchObject({ totalAmount: '112.00', matchedAmount: '112.00', inputVat: '0.00', priceVariance: '0.00' });
    expect(await entryNet(s, inv.journalEntryId)).toEqual({ GRNI: '112.00', ACCOUNTS_PAYABLE: '-112.00' });
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('are refused in a closed month, and replay with the same Idempotency-Key', async () => {
    const s = await shop('ap-period');
    const r = await receive(s, [{ variantId: s.cola, quantity: '1', unitCost: '10.00' }]);
    const lastMonth = day(-40).slice(0, 7);
    await http().post('/v1/accounting/periods/close').set(s.accountant).send({ legalEntityId: s.le, month: lastMonth }).expect(200);
    expect((await invoice(s, { invoiceNumber: 'P-1', invoiceDate: `${lastMonth}-15`, goodsReceiptIds: [r.id], netAmount: '10.00', vatAmount: '1.20' }).expect(409)).body.error.code).toBe('PERIOD_CLOSED');
    const key = randomUUID();
    const first = (await invoice(s, { invoiceNumber: 'P-1', goodsReceiptIds: [r.id], netAmount: '10.00', vatAmount: '1.20' }, s.auth, key).expect(201)).body;
    const replay = (await invoice(s, { invoiceNumber: 'P-1', goodsReceiptIds: [r.id], netAmount: '10.00', vatAmount: '1.20' }, s.auth, key).expect(201)).body;
    expect(replay.id).toBe(first.id);
    await http().post('/v1/supplier-invoices').set(s.auth).send({ supplierId: s.supplierId, invoiceNumber: 'P-2', invoiceDate: day(), goodsReceiptIds: [r.id], netAmount: '1', vatAmount: '0' }).expect(400);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('permissions: the branch purchaser enters and cancels, the bookkeeper pays and reads entity-wide, a cashier neither', async () => {
    const s = await shop('ap-perm');
    const r = await receive(s, [{ variantId: s.cola, quantity: '2', unitCost: '10.00' }]);
    await invoice(s, { invoiceNumber: 'X-1', goodsReceiptIds: [r.id], netAmount: '20.00', vatAmount: '2.40' }, s.cashier).expect(403);
    await http().get('/v1/uninvoiced-receipts').query({ branchId: s.branchId, supplierId: s.supplierId }).set(s.cashier).expect(403);
    const inv = (await invoice(s, { invoiceNumber: 'X-1', goodsReceiptIds: [r.id], netAmount: '20.00', vatAmount: '2.40' }, s.officer).expect(201)).body;
    await http().get(`/v1/supplier-invoices/${inv.id}`).set(s.officer).expect(200);
    await http().get(`/v1/supplier-invoices/${inv.id}`).set(s.cashier).expect(403);
    await pay(inv.id, { amount: '1.00' }, s.officer).expect(403);
    await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le }).set(s.officer).expect(403);
    await http().get('/v1/reports/payables-aging').query({ legalEntityId: s.le }).set(s.officer).expect(403);
    await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le }).set(s.accountant).expect(200);
    await http().get('/v1/reports/payables-aging').query({ legalEntityId: s.le }).set(s.accountant).expect(200);
    await pay(inv.id, { amount: '1.00' }, s.accountant).expect(201);
  });
});

describe('payables aging', () => {
  it('buckets open balances by days past due as of a day, and equals the payables account then', async () => {
    const s = await shop('ap-aging');
    const kirin = await s.supplier('KIRIN', 7);
    const rec = (supplierId = s.supplierId) => receive(s, [{ variantId: s.rice, quantity: '1', unitCost: '100.00' }], supplierId);
    // COKE: due 15 days ago (1–30), part paid 5 days ago; and one over 90 days past due.
    const a = (await invoice(s, { invoiceNumber: 'AG-1', invoiceDate: day(-45), goodsReceiptIds: [(await rec()).id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    expect(a.dueDate).toBe(day(-15));
    await pay(a.id, { amount: '12.00', paidOn: day(-5) }, s.accountant).expect(201);
    await invoice(s, { invoiceNumber: 'AG-2', invoiceDate: day(-100), dueDate: day(-95), goodsReceiptIds: [(await rec()).id], netAmount: '200.00', vatAmount: '0' }).expect(201);
    // KIRIN: not yet due; and one cancelled, which owes nothing.
    await invoice(s, { supplierId: kirin, invoiceNumber: 'K-1', goodsReceiptIds: [(await rec(kirin)).id], netAmount: '50.00', vatAmount: '6.00' }).expect(201);
    const k2 = (await invoice(s, { supplierId: kirin, invoiceNumber: 'K-2', goodsReceiptIds: [(await rec(kirin)).id], netAmount: '9.00', vatAmount: '0' }).expect(201)).body;
    await cancel(k2.id, s.auth).expect(200);

    const now = (await http().get('/v1/reports/payables-aging').query({ legalEntityId: s.le }).set(s.accountant).expect(200)).body;
    expect(now).toMatchObject({
      asOf: day(),
      suppliers: [
        { supplier: { code: 'COKE' }, invoices: 2, current: '0.00', days1to30: '100.00', days31to60: '0.00', days61to90: '0.00', over90: '200.00', total: '300.00' },
        { supplier: { code: 'KIRIN' }, invoices: 1, current: '56.00', total: '56.00' },
      ],
      totals: { current: '56.00', days1to30: '100.00', over90: '200.00', total: '356.00' },
      ledgerBalance: '356.00',
    });
    // Ten days ago: the payment had not been made, K-1 not yet invoiced; AG-1 was 5 and AG-2 85 days past due.
    const before = (await http().get('/v1/reports/payables-aging').query({ legalEntityId: s.le, asOf: day(-10) }).set(s.accountant).expect(200)).body;
    expect(before).toMatchObject({ suppliers: [{ supplier: { code: 'COKE' }, days1to30: '112.00', days61to90: '200.00', over90: '0.00', total: '312.00' }], totals: { total: '312.00' }, ledgerBalance: '312.00' });
    expect(await audit(s)).toEqual(CLEAN);
  });
});

/** Net (debit − credit) of a system account over the entity's whole journal. */
const gl = (s: Shop, key: string) =>
  asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query<{ v: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id WHERE e.legal_entity_id = $1 AND a.system_key = $2`, [s.le, key])).rows[0]!.v);
const payMany = (s: Shop, body: Record<string, unknown>, auth: Auth = s.accountant, key = randomUUID()) =>
  http().post('/v1/supplier-payments').set(auth).set('Idempotency-Key', key).send({ supplierId: s.supplierId, paidOn: day(), method: 'BANK_TRANSFER', ...body });
const voidPayment = (id: string, auth: Auth, reason = 'Paid the wrong supplier') =>
  http().post(`/v1/supplier-payments/${id}/void`).set(auth).set('Idempotency-Key', randomUUID()).send({ reason });
const note = (id: string, body: Record<string, unknown>, auth: Auth) =>
  http().post(`/v1/supplier-invoices/${id}/notes`).set(auth).set('Idempotency-Key', randomUUID()).send({ noteDate: day(), vatAmount: '0', reason: 'Agreed with the supplier', ...body });
const getInvoice = async (s: Shop, id: string) => (await http().get(`/v1/supplier-invoices/${id}`).set(s.auth).expect(200)).body;
const tryAs = (s: Shop, q: string) => asOwnerInTenant(owner, s.tenantId, (c) => c.query(q)).then(() => null, (e: Error) => e.message);

describe('supplier payments over several invoices, and voids (session 22)', () => {
  it('one payment settles invoices of two branches: one entry, balanced per branch; mismatches and overpayment refused', async () => {
    const s = await shop('ap-multi');
    const b2 = (await http().post('/v1/branches').set(s.auth).send({ legalEntityId: s.le, code: 'B2', name: 'Two', birBranchCode: '00002' }).expect(201)).body.id as string;
    const r1 = await receive(s, [{ variantId: s.cola, quantity: '10', unitCost: '10.00' }]);
    const r2 = (await http().post('/v1/goods-receipts').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ branchId: b2, supplierId: s.supplierId, lines: [{ variantId: s.rice, quantity: '2', unitCost: '50.00' }] }).expect(201)).body;
    const a = (await invoice(s, { invoiceNumber: 'M-1', goodsReceiptIds: [r1.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    const b = (await invoice(s, { invoiceNumber: 'M-2', goodsReceiptIds: [r2.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    const pepsi = await s.supplier('PEPSI');
    const rp = await receive(s, [{ variantId: s.cola, quantity: '1', unitCost: '10.00' }], pepsi);
    const c = (await invoice(s, { supplierId: pepsi, invoiceNumber: 'P-1', goodsReceiptIds: [rp.id], netAmount: '10.00', vatAmount: '0' }).expect(201)).body;

    // Refusals: another supplier's invoice, more than one invoice owes, an invoice twice, no posting rights.
    expect((await payMany(s, { allocations: [{ supplierInvoiceId: a.id, amount: '10.00' }, { supplierInvoiceId: c.id, amount: '1.00' }] }).expect(422)).body.error)
      .toMatchObject({ code: 'INVOICE_MISMATCH', details: { supplierInvoiceIds: [c.id] } });
    expect((await payMany(s, { allocations: [{ supplierInvoiceId: a.id, amount: '112.01' }, { supplierInvoiceId: b.id, amount: '1.00' }] }).expect(422)).body.error)
      .toMatchObject({ code: 'OVERPAYMENT', details: { balance: '112.00', supplierInvoiceId: a.id } });
    await payMany(s, { allocations: [{ supplierInvoiceId: a.id, amount: '1.00' }, { supplierInvoiceId: a.id, amount: '1.00' }] }).expect(400);
    await payMany(s, { allocations: [{ supplierInvoiceId: a.id, amount: '1.00' }] }, s.officer).expect(403);
    await payMany(s, { allocations: [{ supplierInvoiceId: randomUUID(), amount: '1.00' }] }).expect(404);

    const key = randomUUID();
    const body = { reference: 'BDO 9001', allocations: [{ supplierInvoiceId: a.id, amount: '112.00' }, { supplierInvoiceId: b.id, amount: '50.00' }] };
    const paid = (await payMany(s, body, s.accountant, key).expect(201)).body;
    expect(paid).toMatchObject({ amount: '162.00', status: 'RECORDED', supplierInvoiceId: null, invoiceNumber: null, supplier: { code: 'COKE' }, branchId: s.branchId });
    expect(paid.allocations.map((x: { invoiceNumber: string; amount: string }) => [x.invoiceNumber, x.amount])).toEqual([['M-1', '112.00'], ['M-2', '50.00']]);
    // The same key again answers the same payment; nothing new is recorded.
    expect((await payMany(s, body, s.accountant, key).expect(201)).body.id).toBe(paid.id);
    expect(await getInvoice(s, a.id)).toMatchObject({ status: 'PAID', balance: '0.00', payments: [{ id: paid.id, amount: '112.00', paymentAmount: '162.00' }] });
    expect(await getInvoice(s, b.id)).toMatchObject({ status: 'OPEN', balance: '62.00', payments: [{ id: paid.id, amount: '50.00' }] });

    // One entry, each branch's payables against the bank on its own lines.
    const e = (await http().get(`/v1/journal-entries/${paid.journalEntryId}`).set(s.auth).expect(200)).body as { lines: { systemKey: string; debit: string; credit: string; branchId: string }[] };
    const byBranch = (br: string) => Object.fromEntries(e.lines.filter((l) => l.branchId === br).map((l) => [l.systemKey, (Number(l.debit) - Number(l.credit)).toFixed(2)]));
    expect(byBranch(s.branchId)).toEqual({ ACCOUNTS_PAYABLE: '112.00', CASH_IN_BANK: '-112.00' });
    expect(byBranch(b2)).toEqual({ ACCOUNTS_PAYABLE: '50.00', CASH_IN_BANK: '-50.00' });
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('a mistaken payment is voided once, with a reason: its entry reversed, the invoice open again; never reversed by hand', async () => {
    const s = await shop('ap-void');
    const r = await receive(s, [{ variantId: s.cola, quantity: '10', unitCost: '10.00' }]);
    const inv = (await invoice(s, { invoiceNumber: 'V-1', goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    const payment = (await pay(inv.id, { amount: '112.00' }, s.accountant).expect(201)).body.payments[0];
    const detail = (await http().get(`/v1/supplier-payments/${payment.id}`).set(s.auth).expect(200)).body;
    expect(detail).toMatchObject({ supplierInvoiceId: inv.id, invoiceNumber: 'V-1', status: 'RECORDED' });

    // Its entry is undone by voiding the payment, never by a reversal by hand.
    expect((await http().post(`/v1/journal-entries/${detail.journalEntryId}/reverse`).set(s.auth).set('Idempotency-Key', randomUUID()).send({ memo: 'Oops' }).expect(422)).body.error.code).toBe('CANCEL_THE_DOCUMENT');
    await voidPayment(payment.id, s.officer).expect(403);
    await voidPayment(payment.id, s.accountant, ' ').expect(400);

    const voided = (await voidPayment(payment.id, s.accountant).expect(200)).body;
    expect(voided).toMatchObject({ status: 'VOIDED', voidReason: 'Paid the wrong supplier', reversalEntryId: expect.any(String) });
    expect(await entryNet(s, voided.reversalEntryId)).toEqual({ ACCOUNTS_PAYABLE: '-112.00', CASH_IN_BANK: '112.00' });
    expect((await voidPayment(payment.id, s.accountant).expect(409)).body.error.code).toBe('ALREADY_VOIDED');
    expect(await getInvoice(s, inv.id)).toMatchObject({ status: 'OPEN', paidAmount: '0.00', balance: '112.00', payments: [{ id: payment.id, status: 'VOIDED' }] });
    expect(await gl(s, 'ACCOUNTS_PAYABLE')).toBe('-112.00');
    const aging = (await http().get('/v1/reports/payables-aging').query({ legalEntityId: s.le }).set(s.accountant).expect(200)).body;
    expect([aging.totals.total, aging.ledgerBalance]).toEqual(['112.00', '112.00']);

    // Paid again, correctly.
    await pay(inv.id, { amount: '112.00', method: 'CHECK' }, s.accountant).expect(201);
    expect(await getInvoice(s, inv.id)).toMatchObject({ status: 'PAID', balance: '0.00' });

    expect(await tryAs(s, `UPDATE supplier_payments SET amount = 1 WHERE id = '${payment.id}'`)).toMatch(/only voided, once/);
    expect(await tryAs(s, `UPDATE supplier_payments SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id = '${payment.id}'`)).toMatch(/only voided, once/);
    expect(await tryAs(s, `DELETE FROM supplier_payments WHERE id = '${payment.id}'`)).toMatch(/never deleted/);
    expect(await tryAs(s, `UPDATE supplier_payment_allocations SET amount = 1 WHERE supplier_payment_id = '${payment.id}'`)).not.toBeNull();
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('a supplier paid in cash from a till drawer (session 36)', () => {
  it('settles the invoice, takes the cash out of the open drawer and posts payables against cash on hand; a void puts it back', async () => {
    const s = await shop('ap-drawer');
    const register = (await http().post('/v1/registers').set(s.auth).send({ branchId: s.branchId, code: 'R1', name: 'Counter' }).expect(201)).body.id as string;
    const shift = (await http().post('/v1/cashier-sessions').set(s.auth).send({ registerId: register, openingFloat: '1000.00' }).expect(201)).body.id as string;
    const r = await receive(s, [{ variantId: s.cola, quantity: '10', unitCost: '10.00' }]);
    const inv = (await invoice(s, { invoiceNumber: 'D-1', invoiceDate: day(-2), goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    const expected = async () => (await http().get(`/v1/cashier-sessions/${shift}`).set(s.auth).expect(200)).body as { expectedCash: string; payInOut: { type: string; amount: string; supplierPaymentId: string | null }[] };

    // Refusals: no shift named, a shift with a bank transfer, not today, more than the drawer holds.
    expect((await pay(inv.id, { amount: '112.00', method: 'CASH_DRAWER' }, s.accountant).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await pay(inv.id, { amount: '112.00', method: 'BANK_TRANSFER', cashierSessionId: shift }, s.accountant).expect(400);
    expect((await pay(inv.id, { amount: '112.00', method: 'CASH_DRAWER', cashierSessionId: shift, paidOn: day(-1) }, s.accountant).expect(422)).body.error.code).toBe('DRAWER_PAID_TODAY');
    await http().post(`/v1/cashier-sessions/${shift}/movements`).set(s.auth).send({ type: 'PAY_OUT', amount: '950.00', reason: 'To the bank' }).expect(201);
    expect((await pay(inv.id, { amount: '112.00', method: 'CASH_DRAWER', cashierSessionId: shift }, s.accountant).expect(422)).body.error)
      .toMatchObject({ code: 'INSUFFICIENT_DRAWER_CASH', details: { available: '50.00' } });
    await http().post(`/v1/cashier-sessions/${shift}/movements`).set(s.auth).send({ type: 'PAY_IN', amount: '950.00', reason: 'Back from the bank' }).expect(201);

    const paid = (await pay(inv.id, { amount: '112.00', method: 'CASH_DRAWER', cashierSessionId: shift }, s.accountant).expect(201)).body;
    expect(paid).toMatchObject({ status: 'PAID', balance: '0.00' });
    const payment = (await http().get(`/v1/supplier-payments/${paid.payments[0].id}`).set(s.auth).expect(200)).body;
    expect(payment).toMatchObject({ method: 'CASH_DRAWER', paidFromSessionId: shift, returnedToSessionId: null });
    expect(await entryNet(s, payment.journalEntryId)).toEqual({ ACCOUNTS_PAYABLE: '112.00', CASH_ON_HAND: '-112.00' });
    const after = await expected();
    expect(after.expectedCash).toBe('888.00');
    expect(after.payInOut.filter((m) => m.type === 'SUPPLIER_PAYMENT')).toEqual([expect.objectContaining({ amount: '-112.00', supplierPaymentId: payment.id })]);

    // A void names the open drawer that takes the cash back; the cash and the payable come back.
    expect((await voidPayment(payment.id, s.accountant).expect(422)).body.error.code).toBe('DRAWER_REQUIRED');
    const voided = (await http().post(`/v1/supplier-payments/${payment.id}/void`).set(s.accountant).set('Idempotency-Key', randomUUID())
      .send({ reason: 'Supplier gave the cash back', cashierSessionId: shift }).expect(200)).body;
    expect(voided).toMatchObject({ status: 'VOIDED', returnedToSessionId: shift });
    expect(await entryNet(s, voided.reversalEntryId)).toEqual({ ACCOUNTS_PAYABLE: '-112.00', CASH_ON_HAND: '112.00' });
    expect((await expected()).expectedCash).toBe('1000.00');
    expect(await getInvoice(s, inv.id)).toMatchObject({ status: 'OPEN', balance: '112.00' });
    // Only once each way (the payment is voided once; the DB keeps one movement per direction).
    expect(await tryAs(s, `INSERT INTO cash_movements (tenant_id, cashier_session_id, type, amount, supplier_payment_id, created_by)
      SELECT tenant_id, cashier_session_id, 'SUPPLIER_PAYMENT', 1, supplier_payment_id, created_by FROM cash_movements WHERE supplier_payment_id = '${payment.id}' LIMIT 1`)).toMatch(/duplicate key/);
    expect(await tryAs(s, `INSERT INTO cash_movements (tenant_id, cashier_session_id, type, amount, created_by)
      SELECT tenant_id, cashier_session_id, 'SUPPLIER_PAYMENT', -1, created_by FROM cash_movements WHERE supplier_payment_id = '${payment.id}' LIMIT 1`)).toMatch(/cash_movements_supplier_payment_link/);

    // A closed shift pays nothing; the drawer stays square at the count.
    await http().post(`/v1/cashier-sessions/${shift}/close`).set(s.auth).send({ countedCash: '1000.00' }).expect(200);
    expect((await pay(inv.id, { amount: '112.00', method: 'CASH_DRAWER', cashierSessionId: shift }, s.accountant).expect(409)).body.error.code).toBe('SESSION_NOT_OPEN');
    expect(await audit(s)).toEqual(CLEAN);
  });
});

describe('supplier credit and debit notes (session 22)', () => {
  it('a return after invoicing is credited: the stranded GRNI cleared, the VAT given back; an allowance is a variance; a debit note owes more', async () => {
    const s = await shop('ap-notes');
    const r = await receive(s, [{ variantId: s.cola, quantity: '10', unitCost: '10.00' }]);
    const inv = (await invoice(s, { invoiceNumber: 'N-1', goodsReceiptIds: [r.id], netAmount: '100.00', vatAmount: '12.00' }).expect(201)).body;
    // Two colas go back after the invoice: the return debits GRNI ₱20 that no invoice clears.
    await http().post('/v1/supplier-returns').set(s.auth).set('Idempotency-Key', randomUUID())
      .send({ branchId: s.branchId, supplierId: s.supplierId, goodsReceiptId: r.id, reason: 'Leaking', lines: [{ goodsReceiptLineId: r.lines[0]!.id, variantId: s.cola, quantity: '2' }] }).expect(201);
    expect(await gl(s, 'GRNI')).toBe('20.00');

    await note(inv.id, { kind: 'CREDIT', noteNumber: 'CM-1', netAmount: '20.00', vatAmount: '2.40' }, s.cashier).expect(403);
    expect((await note(inv.id, { kind: 'CREDIT', noteNumber: 'CM-1', netAmount: '200.00' }, s.officer).expect(422)).body.error).toMatchObject({ code: 'CREDIT_EXCEEDS_BALANCE', details: { balance: '112.00' } });
    expect((await note(inv.id, { kind: 'CREDIT', noteNumber: 'CM-1', netAmount: '1.00', noteDate: day(1) }, s.officer).expect(422)).body.error.code).toBe('DATE_IN_FUTURE');
    await note(inv.id, { kind: 'CREDIT', noteNumber: 'CM-1', netAmount: '0' }, s.officer).expect(400);

    const credited = (await note(inv.id, { kind: 'CREDIT', noteNumber: 'CM-1', netAmount: '20.00', vatAmount: '2.40', reason: 'Two leaking colas returned' }, s.officer).expect(201)).body;
    expect(credited).toMatchObject({ creditedAmount: '22.40', balance: '89.60', status: 'OPEN' });
    const cm = credited.adjustments[0];
    expect(cm).toMatchObject({ kind: 'CREDIT', noteNumber: 'CM-1', totalAmount: '22.40', inputVat: '2.40', grniCleared: '20.00', entryNumber: 1 });
    expect(await gl(s, 'GRNI')).toBe('0.00');
    const noteEntries = async () => (await http().get('/v1/journal-entries').query({ legalEntityId: s.le, sourceType: 'SUPPLIER_NOTE' }).set(s.auth).expect(200)).body.data as { id: string; sourceId: string }[];
    const cmEntry = (await noteEntries()).find((x) => x.sourceId === cm.id)!;
    expect(await entryNet(s, cmEntry.id)).toEqual({ ACCOUNTS_PAYABLE: '22.40', INPUT_VAT: '-2.40', GRNI: '-20.00' });
    expect((await http().get(`/v1/supplier-notes/${cm.id}`).set(s.accountant).expect(200)).body).toMatchObject({ invoiceNumber: 'N-1', grniCleared: '20.00' });

    // An allowance: nothing is left stranded, so the rest is a price variance.
    const allowance = (await note(inv.id, { kind: 'CREDIT', noteNumber: 'CM-2', netAmount: '5.00', vatAmount: '0.60' }, s.accountant).expect(201)).body.adjustments[1];
    expect(allowance).toMatchObject({ grniCleared: '0.00', entryNumber: 2 });
    expect(await entryNet(s, (await noteEntries()).find((x) => x.sourceId === allowance.id)!.id)).toEqual({ ACCOUNTS_PAYABLE: '5.60', INPUT_VAT: '-0.60', PURCHASE_PRICE_VARIANCE: '-5.00' });
    // A debit note: the supplier left freight off the invoice.
    const debited = (await note(inv.id, { kind: 'DEBIT', noteNumber: 'DM-1', netAmount: '10.00', vatAmount: '1.20', reason: 'Freight' }, s.accountant).expect(201)).body;
    expect(debited).toMatchObject({ creditedAmount: '28.00', debitedAmount: '11.20', balance: '95.20' });
    expect(await entryNet(s, (await noteEntries()).find((x) => x.sourceId === debited.adjustments[2].id)!.id)).toEqual({ PURCHASE_PRICE_VARIANCE: '10.00', INPUT_VAT: '1.20', ACCOUNTS_PAYABLE: '-11.20' });

    // The balance is what may be paid; then no credit fits; the books and the aging agree.
    expect((await pay(inv.id, { amount: '95.21' }, s.accountant).expect(422)).body.error.code).toBe('OVERPAYMENT');
    await pay(inv.id, { amount: '95.20' }, s.accountant).expect(201);
    expect(await getInvoice(s, inv.id)).toMatchObject({ status: 'PAID', balance: '0.00' });
    expect((await note(inv.id, { kind: 'CREDIT', noteNumber: 'CM-3', netAmount: '0.01' }, s.accountant).expect(422)).body.error.code).toBe('CREDIT_EXCEEDS_BALANCE');
    expect(await gl(s, 'ACCOUNTS_PAYABLE')).toBe('0.00');
    expect((await http().get('/v1/supplier-invoices').query({ legalEntityId: s.le, status: 'PAID' }).set(s.auth).expect(200)).body.data).toMatchObject([{ id: inv.id, notesAmount: '-16.80', balance: '0.00' }]);

    // A note is corrected by an opposite note, never by reversing its entry by hand.
    expect((await http().post(`/v1/journal-entries/${cmEntry.id}/reverse`).set(s.auth).set('Idempotency-Key', randomUUID()).send({ memo: 'Oops' }).expect(422)).body.error.code).toBe('CANCEL_THE_DOCUMENT');
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('an invoice with notes cannot be cancelled; a cancelled invoice takes none; notes stay as recorded', async () => {
    const s = await shop('ap-notes2');
    const r = await receive(s, [{ variantId: s.cola, quantity: '1', unitCost: '50.00' }]);
    const inv = (await invoice(s, { invoiceNumber: 'N-2', goodsReceiptIds: [r.id], netAmount: '50.00', vatAmount: '6.00' }).expect(201)).body;
    const withNote = (await note(inv.id, { kind: 'DEBIT', noteNumber: 'DM-9', netAmount: '5.00' }, s.auth).expect(201)).body;
    expect((await cancel(inv.id, s.auth).expect(409)).body.error.code).toBe('INVOICE_HAS_NOTES');
    const r2 = await receive(s, [{ variantId: s.cola, quantity: '1', unitCost: '50.00' }]);
    const other = (await invoice(s, { invoiceNumber: 'N-3', goodsReceiptIds: [r2.id], netAmount: '50.00', vatAmount: '6.00' }).expect(201)).body;
    await cancel(other.id, s.auth).expect(200);
    expect((await note(other.id, { kind: 'CREDIT', noteNumber: 'CM-9', netAmount: '1.00' }, s.auth).expect(409)).body.error.code).toBe('INVALID_STATE');
    expect(await tryAs(s, `UPDATE supplier_notes SET reason = 'changed' WHERE id = '${withNote.adjustments[0].id}'`)).not.toBeNull();
    expect(await tryAs(s, `DELETE FROM supplier_notes WHERE id = '${withNote.adjustments[0].id}'`)).not.toBeNull();
    expect(await audit(s)).toEqual(CLEAN);
  });
});
