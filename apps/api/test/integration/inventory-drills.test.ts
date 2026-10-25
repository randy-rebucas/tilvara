import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asOwnerInTenant, bearer, createApp, loginToken, ownerPool, signup, uniq } from './helpers.js';
import { CLEAN, traceabilityAudit } from './traceability-audit.js';

/**
 * Phase 3 exit review — drills for purchasing, transfers, counts and the books under failure and
 * concurrency: a lost connection or an unreachable database writes nothing and the same key then
 * posts once; racing requests post once; mixed documents on the same items never deadlock; a
 * month being closed and a posting into it take turns. Every drill ends with the traceability audit.
 */
let app: INestApplication;
let owner: pg.Pool;
const http = (a: INestApplication = app) => request(a.getHttpServer());
type Auth = { Authorization: string };

beforeAll(async () => {
  app = await createApp();
  owner = ownerPool();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

async function shop(prefix: string) {
  const t = await signup(app, prefix);
  const auth = bearer(t.access);
  const le = (await http().post('/v1/legal-entities').set(auth).send({ registeredName: `${prefix} Corp`, vatStatus: 'VAT' }).expect(201)).body.id as string;
  const b1 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B1', name: 'One' }).expect(201)).body.id as string;
  const b2 = (await http().post('/v1/branches').set(auth).send({ legalEntityId: le, code: 'B2', name: 'Two', birBranchCode: '00001' }).expect(201)).body.id as string;
  const vat = ((await http().get('/v1/tax-categories').set(auth)).body.data as { id: string; code: string }[]).find((x) => x.code === 'VAT')!.id;
  const pc = ((await http().get('/v1/uoms').set(auth)).body.data as { id: string; code: string }[]).find((u) => u.code === 'PC')!.id;
  const item = async (name: string) =>
    (await http().post('/v1/products').set(auth).send({ name, uomId: pc, taxCategoryId: vat, variants: [{ sku: uniq('SKU'), price: '30.00' }] }).expect(201)).body.variants[0].id as string;
  const [x, y] = [await item('Item X'), await item('Item Y')];
  await http().post('/v1/stock/adjustments').set(auth).set('Idempotency-Key', randomUUID()).send({ branchId: b1, reason: 'Opening', items: [{ variantId: x, quantity: '100', unitCost: '10.00' }, { variantId: y, quantity: '100', unitCost: '20.00' }] }).expect(201);
  const supplier = (await http().post('/v1/suppliers').set(auth).send({ code: 'SUP', name: 'Supplier' }).expect(201)).body.id as string;
  return { tenantId: t.tenantId, auth, le, b1, b2, x, y, supplier };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const post = (s: Shop, path: string, body: unknown, key = randomUUID(), a: INestApplication = app, auth: Auth = s.auth) =>
  http(a).post(path).set(auth).set('Idempotency-Key', key).send(body as object);
const audit = (s: Shop) => asOwnerInTenant(owner, s.tenantId, (c) => traceabilityAudit(c));
const count = (s: Shop, q: string) => asOwnerInTenant(owner, s.tenantId, async (c) => Number((await c.query(q)).rows[0].n));

async function approvedOrder(s: Shop, qty = '10') {
  const po = (await http().post('/v1/purchase-orders').set(s.auth).send({ branchId: s.b1, supplierId: s.supplier, lines: [{ variantId: s.x, quantity: qty, unitCost: '11.00' }] }).expect(201)).body;
  await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
  return po as { id: string; lines: { id: string }[] };
}
const receiptBody = (s: Shop, po: { id: string; lines: { id: string }[] }, qty = '10') => ({
  branchId: s.b1, supplierId: s.supplier, purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: po.lines[0]!.id, variantId: s.x, quantity: qty }],
});

/** Everything a goods receipt writes. */
const receiptFootprint = async (s: Shop, poId: string) => ({
  receipts: await count(s, `SELECT count(*) AS n FROM goods_receipts`),
  movements: await count(s, `SELECT count(*) AS n FROM stock_movements WHERE type = 'RECEIPT'`),
  entries: await count(s, `SELECT count(*) AS n FROM journal_entries WHERE source_type = 'GOODS_RECEIPT'`),
  numbers: await count(s, `SELECT coalesce(sum(next_value - 1), 0) AS n FROM sequence_counters WHERE name = 'GOODS_RECEIPT'`),
  onHand: await count(s, `SELECT quantity AS n FROM stock_balances WHERE variant_id = '${s.x}' AND branch_id = '${s.b1}'`),
  status: await asOwnerInTenant(owner, s.tenantId, async (c) => (await c.query(`SELECT status FROM purchase_orders WHERE id = $1`, [poId])).rows[0].status as string),
});

describe('receiving under failure', () => {
  it('connection killed mid-receipt: 503, nothing written, the same key then receives exactly once', async () => {
    const s = await shop('drill-gr-kill');
    const po = await approvedOrder(s);
    const key = randomUUID();
    // Hold the order row (receiving locks it), then kill the receipt's backend while it waits.
    const blocker = await owner.connect();
    const killer = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await killer.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT set_config('app.tenant_id', $1, true)", [s.tenantId]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.id]);
      const pending = post(s, '/v1/goods-receipts', receiptBody(s, po), key).then((r) => r);
      let victim: number | undefined;
      for (let i = 0; i < 100 && !victim; i++) {
        victim = (await killer.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [blockerPid])).rows[0]?.pid;
        if (!victim) await new Promise((r) => setTimeout(r, 50));
      }
      expect(victim).toBeDefined();
      await killer.query('SELECT pg_terminate_backend($1)', [victim]);
      const res = await pending;
      expect([res.status, res.body.error?.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
      await killer.end();
    }
    expect(await receiptFootprint(s, po.id)).toEqual({ receipts: 0, movements: 0, entries: 0, numbers: 0, onHand: 100, status: 'APPROVED' });
    const ok = await post(s, '/v1/goods-receipts', receiptBody(s, po), key).expect(201);
    expect(ok.body.receiptNumber).toBe(1);
    expect(await receiptFootprint(s, po.id)).toEqual({ receipts: 1, movements: 1, entries: 1, numbers: 1, onHand: 110, status: 'RECEIVED' });
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('database unreachable: receipt, transfer and count answer 503 with nothing written', async () => {
    const s = await shop('drill-inv-down');
    const po = await approvedOrder(s);
    const down = await createApp({ DATABASE_URL: 'postgres://onepos_app:x@127.0.0.1:1/onepos_test' });
    try {
      const res = [
        await post(s, '/v1/goods-receipts', receiptBody(s, po), randomUUID(), down),
        await post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: s.x, quantity: '1' }] }, randomUUID(), down),
        await post(s, '/v1/stock/counts', { branchId: s.b1, lines: [{ variantId: s.x, countedQuantity: '1' }] }, randomUUID(), down),
      ];
      for (const r of res) expect([r.status, r.body.error?.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
    } finally {
      await down.close();
    }
    expect(await count(s, `SELECT count(*) AS n FROM stock_movements WHERE type <> 'ADJUSTMENT'`)).toBe(0);
    expect(await count(s, `SELECT count(*) AS n FROM journal_entries WHERE source_type <> 'STOCK_ADJUSTMENT'`)).toBe(0);
  });
});

describe('racing requests', () => {
  it('double-click on receive (same key ×5, concurrent): one receipt, the rest replay it', async () => {
    const s = await shop('drill-gr-dbl');
    const po = await approvedOrder(s);
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 5 }, () => post(s, '/v1/goods-receipts', receiptBody(s, po), key)));
    // Concurrent duplicates of one key: one creates; the others replay it or are told it is in progress.
    const created = res.filter((r) => r.status === 201);
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
    expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect((await receiptFootprint(s, po.id)).receipts).toBe(1);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('the same transfer received by five people at once: arrives once, the others are told it was received', async () => {
    const s = await shop('drill-tr-race');
    const tr = (await post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: s.x, quantity: '8' }, { variantId: s.y, quantity: '3' }] }).expect(201)).body;
    const res = await Promise.all(Array.from({ length: 5 }, () => post(s, `/v1/stock/transfers/${tr.id}/receive`, {})));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).map((r) => r.body.error.code)).toEqual(Array(4).fill('ALREADY_RECEIVED'));
    expect(await count(s, `SELECT count(*) AS n FROM stock_movements WHERE type = 'TRANSFER_IN'`)).toBe(2);
    expect(await count(s, `SELECT count(*) AS n FROM journal_entries WHERE source_type = 'TRANSFER_RECEIPT'`)).toBe(1);
    expect(await count(s, `SELECT quantity AS n FROM stock_balances WHERE branch_id = '${s.b2}' AND variant_id = '${s.x}'`)).toBe(8);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('four returns of the last received units to the supplier at once: exactly one', async () => {
    const s = await shop('drill-sr-race');
    const po = await approvedOrder(s, '3');
    const receipt = (await post(s, '/v1/goods-receipts', receiptBody(s, po, '3')).expect(201)).body;
    const res = await Promise.all(
      Array.from({ length: 4 }, () =>
        post(s, '/v1/supplier-returns', { branchId: s.b1, supplierId: s.supplier, goodsReceiptId: receipt.id, reason: 'Recall', lines: [{ goodsReceiptLineId: receipt.lines[0].id, variantId: s.x, quantity: '3' }] }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 422).map((r) => r.body.error.code)).toEqual(Array(3).fill('RETURN_EXCEEDS_RECEIVED'));
    expect(await count(s, `SELECT count(*) AS n FROM journal_entries WHERE source_type = 'SUPPLIER_RETURN'`)).toBe(1);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('receipts, transfers, counts and adjustments on the same two items in opposite orders, all at once: no deadlock, books = stock', async () => {
    const s = await shop('drill-mix');
    const orders = await Promise.all(Array.from({ length: 3 }, async () => {
      const po = (await http().post('/v1/purchase-orders').set(s.auth).send({ branchId: s.b1, supplierId: s.supplier, lines: [{ variantId: s.y, quantity: '5', unitCost: '21.00' }, { variantId: s.x, quantity: '5', unitCost: '11.00' }] }).expect(201)).body;
      await http().post(`/v1/purchase-orders/${po.id}/approve`).set(s.auth).expect(200);
      return po;
    }));
    const jobs = [
      ...orders.map((po) => () => post(s, '/v1/goods-receipts', { branchId: s.b1, supplierId: s.supplier, purchaseOrderId: po.id, lines: po.lines.map((l: { id: string; variantId: string }) => ({ purchaseOrderLineId: l.id, variantId: l.variantId, quantity: '5' })) })),
      () => post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: s.y, quantity: '2' }, { variantId: s.x, quantity: '2' }] }),
      () => post(s, '/v1/stock/transfers', { fromBranchId: s.b1, toBranchId: s.b2, lines: [{ variantId: s.x, quantity: '1' }, { variantId: s.y, quantity: '1' }] }),
      () => post(s, '/v1/stock/counts', { branchId: s.b1, lines: [{ variantId: s.y, countedQuantity: '90' }, { variantId: s.x, countedQuantity: '95' }] }),
      () => http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.b1, kind: 'WASTE', reason: 'Spill', items: [{ variantId: s.y, quantity: '-1' }, { variantId: s.x, quantity: '-1' }] }),
      () => http().post('/v1/stock/adjustments').set(s.auth).set('Idempotency-Key', randomUUID()).send({ branchId: s.b1, reason: 'Found', items: [{ variantId: s.x, quantity: '2' }, { variantId: s.y, quantity: '2' }] }),
    ];
    const res = await Promise.all(jobs.map((j) => j()));
    expect(res.map((r) => r.status).filter((x) => x >= 300)).toEqual([]);
    // Stock = ledger at every branch and item.
    expect(await count(s, `SELECT count(*) AS n FROM stock_balances b WHERE b.quantity <> (SELECT sum(quantity) FROM stock_movements m WHERE m.branch_id = b.branch_id AND m.variant_id = b.variant_id) OR b.value <> (SELECT sum(value) FROM stock_movements m WHERE m.branch_id = b.branch_id AND m.variant_id = b.variant_id)`)).toBe(0);
    // Books = stock: inventory + goods in transit = Σ movement value, counting what is on the road (not yet received) at the value that left.
    const gap = await asOwnerInTenant(owner, s.tenantId, async (c) =>
      (await c.query(`SELECT (SELECT sum(l.debit - l.credit) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.system_key IN ('INVENTORY', 'INVENTORY_IN_TRANSIT'))
                           - (SELECT sum(value) FROM stock_movements WHERE type <> 'TRANSFER_OUT') AS n`)).rows[0].n as string,
    );
    expect(Number(gap)).toBe(0);
    expect(await audit(s)).toEqual(CLEAN);
  });

  it('the same entry reversed four times at once: one reversal', async () => {
    const s = await shop('drill-rev');
    const acc = Object.fromEntries(((await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.auth)).body.data as { id: string; systemKey: string }[]).map((a) => [a.systemKey, a.id]));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const entry = (await post(s, '/v1/journal-entries', { legalEntityId: s.le, entryDate: today, memo: 'Float', lines: [{ accountId: acc.CASH_ON_HAND, debit: '100.00' }, { accountId: acc.CASH_TRANSFERS, credit: '100.00' }] }).expect(201)).body;
    const res = await Promise.all(Array.from({ length: 4 }, () => post(s, `/v1/journal-entries/${entry.id}/reverse`, { memo: 'Twice' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).map((r) => r.body.error.code)).toEqual(Array(3).fill('ALREADY_REVERSED'));
  });
});

describe('closing a month while posting into it', () => {
  const lastMonth = () => {
    const d = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()).slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };
  const manual = async (s: Shop) => {
    const acc = Object.fromEntries(((await http().get('/v1/accounts').query({ legalEntityId: s.le }).set(s.auth)).body.data as { id: string; systemKey: string }[]).map((a) => [a.systemKey, a.id]));
    return { legalEntityId: s.le, entryDate: `${lastMonth()}-28`, memo: 'Late accrual', lines: [{ accountId: acc.INVENTORY_ADJUSTMENTS, debit: '5.00' }, { accountId: acc.INVENTORY, credit: '5.00' }] };
  };
  /** An uncommitted posting into last month, written the way any writer would. */
  async function postingInFlight(s: Shop) {
    const c = await owner.connect();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [s.tenantId]);
    const acc = Object.fromEntries((await c.query(`SELECT system_key, id FROM accounts WHERE legal_entity_id = $1`, [s.le])).rows.map((r) => [r.system_key, r.id]));
    const e = (await c.query(`INSERT INTO journal_entries (tenant_id, legal_entity_id, entry_number, entry_date, source_type, memo, created_by) VALUES ($1, $2, 900, $3, 'MANUAL', 'in flight', $1) RETURNING id`, [s.tenantId, s.le, `${lastMonth()}-20`])).rows[0].id;
    await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, debit) VALUES ($1, $2, $3, $4, 1)`, [s.tenantId, s.le, e, acc.INVENTORY_ADJUSTMENTS]);
    await c.query(`INSERT INTO journal_lines (tenant_id, legal_entity_id, journal_entry_id, account_id, credit) VALUES ($1, $2, $3, $4, 1)`, [s.tenantId, s.le, e, acc.INVENTORY]);
    return c;
  }
  const settled = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

  it('a close waits for a posting in flight, so nothing lands in the month after it closed', async () => {
    const s = await shop('drill-close-wait');
    const c = await postingInFlight(s);
    const closing = http().post('/v1/accounting/periods/close').set(s.auth).send({ legalEntityId: s.le, month: lastMonth() }).then((r) => r);
    expect(await settled(closing, 600)).toBe(false); // blocked on the posting's period lock
    await c.query('COMMIT');
    c.release();
    expect((await closing).status).toBe(200);
    const late = await count(s, `SELECT count(*) AS n FROM journal_entries e JOIN accounting_periods p ON p.legal_entity_id = e.legal_entity_id AND p.starts_on = date_trunc('month', e.entry_date)::date WHERE p.status = 'CLOSED' AND e.created_at > p.closed_at`);
    expect(late).toBe(0);
  });

  it('a posting waits for a close in flight, then is refused with PERIOD_CLOSED', async () => {
    const s = await shop('drill-close-first');
    const body = await manual(s);
    const c = await owner.connect();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [s.tenantId]);
    await c.query(`INSERT INTO accounting_periods (tenant_id, legal_entity_id, starts_on, status, closed_by, closed_at) VALUES ($1, $2, $3, 'CLOSED', $1, now())`, [s.tenantId, s.le, `${lastMonth()}-01`]);
    const posting = post(s, '/v1/journal-entries', body).then((r) => r);
    expect(await settled(posting, 600)).toBe(false); // blocked on the close
    await c.query('COMMIT');
    c.release();
    const res = await posting;
    expect([res.status, res.body.error?.code]).toEqual([409, 'PERIOD_CLOSED']);
    expect(await count(s, `SELECT count(*) AS n FROM journal_entries WHERE source_type = 'MANUAL'`)).toBe(0);
  });
});


describe('who sees which branch', () => {
  it('an inventory officer at one branch sees that branch (to pick it in the admin), not the others; a cashier sees only theirs', async () => {
    const s = await shop('branch-view');
    const officer = await addMember(owner, s.tenantId, 'inventory_officer', { type: 'BRANCH', id: s.b2 });
    const cashier = await addMember(owner, s.tenantId, 'cashier', { type: 'BRANCH', id: s.b1 });
    const seen = async (email: string) => {
      const token = await loginToken(app, email);
      return ((await http().get('/v1/branches').set(bearer(token)).expect(200)).body.data as { id: string }[]).map((b) => b.id);
    };
    expect(await seen(officer.email)).toEqual([s.b2]);
    expect(await seen(cashier.email)).toEqual([s.b1]);
    // A counting clerk (a custom role with inventory.count) picks the branch they count: that branch only.
    await http().post('/v1/roles').set(s.auth).send({ key: 'counter', name: 'Count clerk', permissions: ['inventory.count'] }).expect(201);
    expect(await seen((await addMember(owner, s.tenantId, 'counter', { type: 'BRANCH', id: s.b1 })).email)).toEqual([s.b1]);
    expect((await seen((await addMember(owner, s.tenantId, 'inventory_officer')).email)).sort()).toEqual([s.b1, s.b2].sort());
  });
});
